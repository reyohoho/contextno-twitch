from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .game import GameV2, WordNotInVocabError, pick_secret
from .registry import BackendRegistry
from .store import GameStoreV2


router = APIRouter(prefix="/api/v2")

registry = BackendRegistry()
store = GameStoreV2()


class CreateGameBody(BaseModel):
    backend: str = Field(default="navec", description="navec | fasttext")
    secret: Optional[str] = None


class GuessBody(BaseModel):
    word: str


def _get_game(game_id: str) -> GameV2:
    g = store.get(game_id)
    if g is None:
        raise HTTPException(404, "game not found")
    return g


@router.get("/backends")
def list_backends() -> dict:
    return {
        "known": registry.known_backends,
        "backends": registry.info(),
    }


@router.post("/games")
def create_game(body: CreateGameBody) -> dict:
    try:
        bundle = registry.get(body.backend)
    except KeyError as e:
        raise HTTPException(400, str(e))

    if body.secret:
        secret = body.secret.strip().lower()
        if not bundle.embedder.has_word(secret):
            raise HTTPException(400, f"слово '{secret}' нет в словаре бэкенда")
    else:
        secret = pick_secret(bundle.secret_pool)

    try:
        game = GameV2(bundle.embedder, secret)
    except WordNotInVocabError as e:
        raise HTTPException(400, str(e))

    store.add(game)
    return {
        "game_id": game.game_id,
        "backend": bundle.embedder.id,
        "vocab_size": bundle.embedder.vocab_size,
    }


@router.get("/games/{game_id}")
def get_game(game_id: str) -> dict:
    return _get_game(game_id).to_dict()


@router.post("/games/{game_id}/guess")
def post_guess(game_id: str, body: GuessBody) -> dict:
    return _get_game(game_id).guess(body.word)


@router.post("/games/{game_id}/tip")
def post_tip(game_id: str) -> dict:
    return _get_game(game_id).tip()


@router.post("/games/{game_id}/give-up")
def post_give_up(game_id: str) -> dict:
    return _get_game(game_id).give_up()
