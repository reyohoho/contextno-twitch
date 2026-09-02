from __future__ import annotations

import os

import httpx
from fastapi import HTTPException

CHAT_SERVER_URL = os.environ.get(
    "CHAT_SERVER_URL", "https://chats.eventlab.dev"
).rstrip("/")

VALID_CHAT_SERVERS = frozenset({"twitch", "vkvideo", "kick", "wtv", "gosh"})

_http = httpx.Client(
    timeout=httpx.Timeout(20.0, connect=10.0),
    headers={"Accept": "application/json"},
    follow_redirects=True,
)


def _check_server(server: str) -> str:
    s = (server or "").strip().lower()
    if s not in VALID_CHAT_SERVERS:
        raise HTTPException(
            400,
            f"неизвестная платформа: {server}. доступны: twitch, vkvideo, kick, wtv",
        )
    return s


def _check_channel(channel: str) -> str:
    ch = (channel or "").strip().lstrip("#").lower()
    if not ch:
        raise HTTPException(400, "укажите канал")
    if len(ch) > 64 or "/" in ch or " " in ch:
        raise HTTPException(400, "некорректное имя канала")
    return ch


def _upstream_error(exc: Exception) -> HTTPException:
    return HTTPException(502, f"чат-сервер недоступен: {exc}")


def connect_chat(server: str, channel: str) -> dict:
    server = _check_server(server)
    channel = _check_channel(channel)
    try:
        r = _http.post(
            f"{CHAT_SERVER_URL}/api/chat_connect",
            json={"server": server, "channel": channel},
        )
    except httpx.HTTPError as e:
        raise _upstream_error(e) from e
    return _parse_upstream(r)


def get_chat_messages(server: str, channel: str, ts_from: int) -> dict:
    server = _check_server(server)
    channel = _check_channel(channel)
    try:
        ts = int(ts_from)
    except (TypeError, ValueError):
        raise HTTPException(400, "tsFrom должен быть числом")
    try:
        r = _http.get(
            f"{CHAT_SERVER_URL}/api/chat_messages",
            params={"server": server, "channel": channel, "tsFrom": ts},
        )
    except httpx.HTTPError as e:
        raise _upstream_error(e) from e
    return _parse_upstream(r)


def _parse_upstream(r: httpx.Response) -> dict:
    try:
        data = r.json()
    except Exception:
        raise HTTPException(
            502, f"чат-сервер вернул не JSON ({r.status_code})"
        )
    if not isinstance(data, dict):
        raise HTTPException(502, "чат-сервер вернул неожиданный ответ")
    if r.status_code >= 400:
        errors = data.get("errors")
        if isinstance(errors, list) and errors:
            detail = errors[0]
            if isinstance(detail, dict):
                detail = detail.get("message") or str(detail)
            raise HTTPException(r.status_code, str(detail))
        raise HTTPException(r.status_code, data.get("detail") or "ошибка чат-сервера")
    return data
