from __future__ import annotations

import os
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
from .winners import WinnersStore


client = ContextnoClient()
store = GameStore()
winners = WinnersStore(os.environ.get("WINNERS_FILE", "/data/winners.json"))

app = FastAPI(title="contextnorf-backend", version="2.0.0")
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


class WinBody(BaseModel):
    nick: str


class ResetWinnersBody(BaseModel):
    scope: str = Field(default="today", description="today | alltime | all")


class ImportWinnersBody(BaseModel):
    alltime: dict[str, int] = Field(default_factory=dict)
    today: Optional[dict] = None


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


@app.get("/api/winners/{channel}")
def get_winners(channel: str) -> dict:
    try:
        return winners.get(channel)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/winners/{channel}/win")
def post_winner(channel: str, body: WinBody) -> dict:
    try:
        return winners.add_win(channel, body.nick)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/winners/{channel}/reset")
def post_reset_winners(channel: str, body: ResetWinnersBody) -> dict:
    try:
        return winners.reset(channel, body.scope)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/winners/{channel}/import")
def post_import_winners(channel: str, body: ImportWinnersBody) -> dict:
    today = body.today if isinstance(body.today, dict) else {}
    try:
        return winners.import_merge(
            channel,
            alltime=body.alltime,
            today_winners=today.get("winners"),
            today_date=today.get("date"),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
