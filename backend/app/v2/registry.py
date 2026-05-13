from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Callable

from .embedder import (
    Embedder,
    NavecEmbedder,
    NAVEC_LEMMA_CACHE_PATH,
    RUSVECTORES_LEMMA_CACHE_PATH,
    RusVectoresEmbedder,
)
from .secrets import build_secret_pool


logger = logging.getLogger(__name__)


@dataclass
class BackendBundle:
    embedder: Embedder
    secret_pool: list[str]


_FACTORIES: dict[str, Callable[[], Embedder]] = {
    "navec": NavecEmbedder,
    "rusvectores": RusVectoresEmbedder,
}

_LEMMA_CACHE_PATHS: dict[str, str] = {
    "navec": NAVEC_LEMMA_CACHE_PATH,
    "rusvectores": RUSVECTORES_LEMMA_CACHE_PATH,
}


def _count_cache_lines(path: str) -> int | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except OSError:
        return None


class BackendRegistry:
    def __init__(self) -> None:
        self._bundles: dict[str, BackendBundle] = {}
        self._locks: dict[str, threading.Lock] = {
            name: threading.Lock() for name in _FACTORIES
        }

    @property
    def known_backends(self) -> list[str]:
        return list(_FACTORIES.keys())

    def is_loaded(self, name: str) -> bool:
        return name in self._bundles

    def get(self, name: str) -> BackendBundle:
        if name not in _FACTORIES:
            raise KeyError(f"неизвестный бэкенд: {name!r}")
        bundle = self._bundles.get(name)
        if bundle is not None:
            return bundle
        with self._locks[name]:
            bundle = self._bundles.get(name)
            if bundle is not None:
                return bundle
            logger.info("loading backend %r ...", name)
            embedder = _FACTORIES[name]()
            logger.info(
                "backend %r loaded: vocab=%d dim=%d",
                name,
                embedder.vocab_size,
                embedder.dim,
            )
            pool = build_secret_pool(embedder)
            logger.info("backend %r: secret pool size=%d", name, len(pool))
            bundle = BackendBundle(embedder=embedder, secret_pool=pool)
            self._bundles[name] = bundle
            return bundle

    def info(self) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        for name in _FACTORIES:
            bundle = self._bundles.get(name)
            if bundle is None:
                size = _count_cache_lines(_LEMMA_CACHE_PATHS.get(name, ""))
                entry: dict[str, object] = {"id": name, "loaded": False}
                if size is not None:
                    entry["vocab_size"] = size
                out.append(entry)
            else:
                out.append(
                    {
                        "id": name,
                        "loaded": True,
                        "vocab_size": bundle.embedder.vocab_size,
                        "dim": bundle.embedder.dim,
                        "secret_pool_size": len(bundle.secret_pool),
                    }
                )
        return out
