from __future__ import annotations

import random
import threading
import uuid
from typing import Optional

import numpy as np

from .embedder import Embedder


class WordNotInVocabError(ValueError):
    pass


class GameV2:
    def __init__(self, embedder: Embedder, secret: str) -> None:
        if not embedder.has_word(secret):
            raise WordNotInVocabError(f"secret '{secret}' нет в словаре")

        self.game_id = str(uuid.uuid4())
        self.embedder = embedder
        self.secret = secret
        self.guesses: list[dict] = []
        self.tips_used = 0
        self.won = False
        self.given_up = False
        self._lock = threading.Lock()

        sims = embedder.similarities_from(secret)
        assert sims is not None
        order = np.argsort(-sims, kind="stable")
        ranks = np.empty(order.shape[0], dtype=np.int32)
        ranks[order] = np.arange(1, order.shape[0] + 1, dtype=np.int32)

        self._order = order
        self._ranks = ranks

    @property
    def vocab_size(self) -> int:
        return self.embedder.vocab_size

    def _rank_of(self, word: str) -> Optional[int]:
        idx = self.embedder.index_of(word)
        if idx is None:
            return None
        return int(self._ranks[idx])

    def _word_at_rank(self, rank: int) -> str:
        rank = max(1, min(rank, self.vocab_size))
        idx = int(self._order[rank - 1])
        return self.embedder.vocab[idx]

    def guess(self, word: str) -> dict:
        word = (word or "").strip().lower()
        if not word:
            return {"error": "пустой ввод"}

        with self._lock:
            if self.won or self.given_up:
                return {"error": "игра завершена"}

            rank = self._rank_of(word)
            if rank is None:
                return {"error": "нет в словаре", "word": word}

            existing = next((g for g in self.guesses if g["word"] == word), None)
            if existing is None:
                self.guesses.append({"word": word, "rank": rank, "tip": False})
                repeated = False
            else:
                repeated = True

            if rank == 1:
                self.won = True

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

            best = min((g["rank"] for g in self.guesses), default=self.vocab_size)
            if best <= 3:
                return {"error": "подсказка не нужна — вы уже очень близко"}

            target_rank = max(2, best // 2)
            attempt = 0
            while attempt < 20:
                word = self._word_at_rank(target_rank)
                if not any(g["word"] == word for g in self.guesses):
                    break
                target_rank = max(2, target_rank - 1)
                attempt += 1
            else:
                return {"error": "подсказка не найдена"}

            rank = self._rank_of(word)
            assert rank is not None
            self.guesses.append({"word": word, "rank": rank, "tip": True})
            self.tips_used += 1
            return {"word": word, "rank": rank, "tips_used": self.tips_used}

    def give_up(self) -> dict:
        with self._lock:
            self.given_up = True
            self.won = True
            return {"secret": self.secret}

    def to_dict(self) -> dict:
        out: dict = {
            "game_id": self.game_id,
            "backend": self.embedder.id,
            "vocab_size": self.vocab_size,
            "guesses": self.guesses,
            "won": self.won,
            "given_up": self.given_up,
            "tips_used": self.tips_used,
        }
        if self.given_up or self.won:
            out["secret"] = self.secret
        return out


def pick_secret(pool: list[str]) -> str:
    if not pool:
        raise RuntimeError("пустой пул секретов")
    return random.choice(pool)
