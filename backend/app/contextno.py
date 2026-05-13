from __future__ import annotations

import threading
import uuid
from typing import Optional

import httpx


API_BASE = "https://api.contextno.com"
ORIGIN = "https://xn--e1ajbkccewgd.xn--p1ai"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Origin": ORIGIN,
    "Referer": ORIGIN + "/",
    "Accept": "application/json, text/plain, */*",
}

VALID_MODES = {"random", "latest"}


class WordNotFoundError(ValueError):
    pass


class ContextnoClient:
    def __init__(self, timeout: float = 15.0) -> None:
        self._http = httpx.Client(headers=HEADERS, timeout=timeout)

    def _req(self, method: str, path: str, **kw) -> dict:
        try:
            r = self._http.request(method, API_BASE + path, **kw)
        except httpx.HTTPError as e:
            raise RuntimeError(f"upstream error: {e}") from e
        try:
            data = r.json()
        except Exception:
            data = None
        if data is None:
            raise RuntimeError(f"upstream {r.status_code} on {path}: {r.text[:200]}")
        if r.status_code >= 500:
            raise RuntimeError(f"upstream {r.status_code} on {path}: {data}")
        return data

    def latest(self) -> dict:
        return self._req("GET", "/latest-challenge")

    def random(self) -> dict:
        return self._req("GET", "/random-challenge")

    def info(self, challenge_id: str) -> dict:
        return self._req(
            "GET", "/challenge-info", params={"challenge_id": challenge_id}
        )

    def publish(self, author_id: str, word: str) -> dict:
        return self._req(
            "POST",
            "/publish_challenge",
            json={"author_id": author_id, "word": word},
        )

    def score(self, challenge_id: str, word: str, challenge_type: str) -> dict:
        return self._req(
            "GET",
            "/score",
            params={
                "challenge_id": challenge_id,
                "word": word,
                "challenge_type": challenge_type,
            },
        )

    def tip(self, challenge_id: str, challenge_type: str, last_word_rank: int) -> dict:
        return self._req(
            "GET",
            "/tip",
            params={
                "challenge_id": challenge_id,
                "challenge_type": challenge_type,
                "last_word_rank": last_word_rank,
            },
        )


class Game:
    def __init__(self, client: ContextnoClient, challenge: dict) -> None:
        self.game_id = str(uuid.uuid4())
        self.client = client
        self.challenge = challenge
        self.challenge_id = challenge["id"]
        self.challenge_type = challenge.get("challenge_type", "official")
        self.guesses: list[dict] = []
        self.tips_used = 0
        self.won = False
        self.given_up = False
        self.secret: Optional[str] = None
        self._lock = threading.Lock()

    def guess(self, word: str) -> dict:
        word = (word or "").strip().lower()
        if not word:
            return {"error": "пустой ввод"}
        with self._lock:
            if self.won or self.given_up:
                return {"error": "игра завершена"}

            try:
                r = self.client.score(self.challenge_id, word, self.challenge_type)
            except RuntimeError as e:
                return {"error": str(e)}
            if r.get("error"):
                return {"error": r["error"], "word": word}

            rank = int(r["distance"])
            existing = next((g for g in self.guesses if g["word"] == word), None)
            if existing is None:
                self.guesses.append({"word": word, "rank": rank, "tip": False})
                repeated = False
            else:
                repeated = True

            if rank == 1:
                self.won = True
                self.secret = word

            return {
                "word": word,
                "rank": rank,
                "won": self.won,
                "repeated": repeated,
            }

    def tip(self) -> dict:
        with self._lock:
            if self.won or self.given_up:
                return {"error": "игра завершена"}
            best = min((g["rank"] for g in self.guesses), default=None)
            if best is None or best <= 2:
                best = 5000
            try:
                r = self.client.tip(self.challenge_id, self.challenge_type, best)
            except RuntimeError as e:
                return {"error": str(e)}
            if r.get("error"):
                return {"error": r["error"]}
            word = r["word"]
            rank = int(r["distance"])
            if not any(g["word"] == word for g in self.guesses):
                self.guesses.append({"word": word, "rank": rank, "tip": True})
            self.tips_used += 1
            return {"word": word, "rank": rank, "tips_used": self.tips_used}

    def give_up(self) -> dict:
        with self._lock:
            self.given_up = True
            self.won = True
            try:
                r = self.client.tip(self.challenge_id, self.challenge_type, 2)
                if int(r.get("distance") or 0) == 1 and r.get("word"):
                    self.secret = r["word"]
                    return {"secret": self.secret}
            except RuntimeError:
                pass
            return {"secret": None}

    def to_dict(self) -> dict:
        out: dict = {
            "game_id": self.game_id,
            "challenge": self.challenge,
            "guesses": self.guesses,
            "won": self.won,
            "given_up": self.given_up,
            "tips_used": self.tips_used,
        }
        if (self.given_up or self.won) and self.secret:
            out["secret"] = self.secret
        return out


def resolve_challenge(
    client: ContextnoClient,
    mode: str = "random",
    secret: Optional[str] = None,
    challenge_id: Optional[str] = None,
    author_id: Optional[str] = None,
) -> dict:
    if secret and challenge_id:
        raise ValueError("укажите либо secret, либо challenge_id, не оба")

    if challenge_id:
        return client.info(challenge_id.strip())

    if secret:
        if not author_id:
            raise ValueError("author_id обязателен при загадывании своего слова")
        r = client.publish(author_id.strip(), secret.strip().lower())
        if r.get("error"):
            raise WordNotFoundError(r.get("message") or "слово не найдено в словаре")
        return {
            "id": r["challenge_id"],
            "name": r.get("challenge_name") or "пользовательская",
            "challenge_type": "unofficial",
            "created_at": None,
        }

    if mode not in VALID_MODES:
        raise ValueError(f"unknown mode: {mode!r}")
    return client.latest() if mode == "latest" else client.random()
