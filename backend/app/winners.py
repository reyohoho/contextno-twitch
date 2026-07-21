from __future__ import annotations

import json
import os
import re
import threading
from datetime import date
from typing import Optional


_CHANNEL_RE = re.compile(r"[a-z0-9_]+")
_MAX_NICK_LEN = 40


def normalize_channel(channel: str) -> str:
    ch = (channel or "").strip().lower().lstrip("#")
    m = _CHANNEL_RE.fullmatch(ch)
    if not m:
        raise ValueError("invalid channel")
    return ch


def _today() -> str:
    return date.today().isoformat()


class WinnersStore:
    """Winners leaderboard persisted to a JSON file on disk, keyed by twitch
    channel. Structure on disk:

        {
          "<channel>": {
            "alltime": {"<nick>": <int>, ...},
            "today":   {"date": "YYYY-MM-DD", "winners": {"<nick>": <int>, ...}}
          },
          ...
        }
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._data = data
        except (FileNotFoundError, ValueError, OSError):
            self._data = {}

    def _save(self) -> None:
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def _channel_entry(self, channel: str) -> dict:
        entry = self._data.get(channel)
        if not isinstance(entry, dict):
            entry = {"alltime": {}, "today": {"date": _today(), "winners": {}}}
            self._data[channel] = entry
        entry.setdefault("alltime", {})
        today = entry.get("today")
        if not isinstance(today, dict):
            today = {"date": _today(), "winners": {}}
            entry["today"] = today
        today.setdefault("winners", {})
        if today.get("date") != _today():
            today["date"] = _today()
            today["winners"] = {}
        return entry

    @staticmethod
    def _snapshot(entry: dict, channel: str) -> dict:
        return {
            "channel": channel,
            "alltime": dict(entry.get("alltime", {})),
            "today": {
                "date": entry["today"]["date"],
                "winners": dict(entry["today"]["winners"]),
            },
        }

    def get(self, channel: str) -> dict:
        ch = normalize_channel(channel)
        with self._lock:
            entry = self._channel_entry(ch)
            return self._snapshot(entry, ch)

    def add_win(self, channel: str, nick: str) -> dict:
        ch = normalize_channel(channel)
        nick = (nick or "").strip()
        if not nick:
            raise ValueError("empty nick")
        if len(nick) > _MAX_NICK_LEN:
            nick = nick[:_MAX_NICK_LEN]
        with self._lock:
            entry = self._channel_entry(ch)
            entry["alltime"][nick] = int(entry["alltime"].get(nick, 0)) + 1
            winners = entry["today"]["winners"]
            winners[nick] = int(winners.get(nick, 0)) + 1
            self._save()
            return self._snapshot(entry, ch)

    def reset(self, channel: str, scope: str) -> dict:
        ch = normalize_channel(channel)
        scope = (scope or "").strip().lower()
        if scope not in ("today", "alltime", "all"):
            raise ValueError("invalid scope")
        with self._lock:
            entry = self._channel_entry(ch)
            if scope in ("today", "all"):
                entry["today"] = {"date": _today(), "winners": {}}
            if scope in ("alltime", "all"):
                entry["alltime"] = {}
            self._save()
            return self._snapshot(entry, ch)

    @staticmethod
    def _normalize_counts(raw: object) -> dict[str, int]:
        if not isinstance(raw, dict):
            return {}
        out: dict[str, int] = {}
        for nick, value in raw.items():
            name = str(nick or "").strip()
            if not name:
                continue
            if len(name) > _MAX_NICK_LEN:
                name = name[:_MAX_NICK_LEN]
            try:
                count = int(value)
            except (TypeError, ValueError):
                continue
            if count <= 0:
                continue
            out[name] = max(out.get(name, 0), count)
        return out

    @staticmethod
    def _merge_max(dst: dict, src: dict[str, int]) -> bool:
        changed = False
        for nick, count in src.items():
            prev = int(dst.get(nick, 0))
            if count > prev:
                dst[nick] = count
                changed = True
        return changed

    def import_merge(
        self,
        channel: str,
        alltime: object = None,
        today_winners: object = None,
        today_date: Optional[str] = None,
    ) -> dict:
        """Merge localStorage migration payload into the channel board.

        Per-nick counts use max(server, imported) so the import is idempotent
        and never lowers an existing score.
        Today's board is merged only when today_date matches the current day.
        """
        ch = normalize_channel(channel)
        alltime_map = self._normalize_counts(alltime)
        today_map = self._normalize_counts(today_winners)
        with self._lock:
            entry = self._channel_entry(ch)
            changed = self._merge_max(entry["alltime"], alltime_map)
            if today_map and (today_date or "") == _today():
                changed = self._merge_max(entry["today"]["winners"], today_map) or changed
            if changed:
                self._save()
            return self._snapshot(entry, ch)
