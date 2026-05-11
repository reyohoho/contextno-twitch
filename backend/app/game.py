from __future__ import annotations

import threading
from typing import Optional

from .contextno import Game


class GameStore:
    def __init__(self) -> None:
        self.games: dict[str, Game] = {}
        self._lock = threading.Lock()

    def add(self, game: Game) -> Game:
        with self._lock:
            self.games[game.game_id] = game
        return game

    def get(self, game_id: str) -> Optional[Game]:
        return self.games.get(game_id)
