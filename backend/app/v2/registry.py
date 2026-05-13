from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Callable

from .embedder import Embedder, NavecEmbedder, RusVectoresEmbedder
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

    def info(self) -> list[dict]:
        out = []
        for name in _FACTORIES:
            bundle = self._bundles.get(name)
            if bundle is None:
                out.append({"id": name, "loaded": False})
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
