from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .contextno import (
    ContextnoClient,
    Game,
    WordNotFoundError,
    resolve_challenge,
)
from .game import GameStore


client = ContextnoClient()
store = GameStore()

app = FastAPI(title="contextnorf-backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateGameBody(BaseModel):
    mode: str = Field(default="random", description="random | latest")
    secret: Optional[str] = None
    challenge_id: Optional[str] = None
    author_id: Optional[str] = None


class GuessBody(BaseModel):
    word: str


def _get(game_id: str) -> Game:
    g = store.get(game_id)
    if g is None:
        raise HTTPException(404, "game not found")
    return g


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/games")
def create_game(body: CreateGameBody) -> dict:
    try:
        challenge = resolve_challenge(
            client,
            mode=body.mode,
            secret=body.secret,
            challenge_id=body.challenge_id,
            author_id=body.author_id,
        )
    except WordNotFoundError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    game = store.add(Game(client, challenge))
    return {"game_id": game.game_id, "challenge": game.challenge}


@app.get("/api/games/{game_id}")
def get_game(game_id: str) -> dict:
    return _get(game_id).to_dict()


@app.post("/api/games/{game_id}/guess")
def post_guess(game_id: str, body: GuessBody) -> dict:
    return _get(game_id).guess(body.word)


@app.post("/api/games/{game_id}/tip")
def post_tip(game_id: str) -> dict:
    return _get(game_id).tip()


@app.post("/api/games/{game_id}/give-up")
def post_give_up(game_id: str) -> dict:
    return _get(game_id).give_up()
