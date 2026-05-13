from __future__ import annotations

import threading
from typing import Optional

from .game import GameV2


class GameStoreV2:
    def __init__(self) -> None:
        self.games: dict[str, GameV2] = {}
        self._lock = threading.Lock()

    def add(self, game: GameV2) -> GameV2:
        with self._lock:
            self.games[game.game_id] = game
        return game

    def get(self, game_id: str) -> Optional[GameV2]:
        return self.games.get(game_id)
