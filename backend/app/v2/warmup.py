from __future__ import annotations

import logging
import sys

from .embedder import (
    NAVEC_LEMMA_CACHE_PATH,
    NAVEC_PATH,
    RUSVECTORES_LEMMA_CACHE_PATH,
    RUSVECTORES_PATH,
    build_navec_lemma_cache,
    build_rusvectores_lemma_cache,
)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    n_navec = build_navec_lemma_cache(NAVEC_PATH, NAVEC_LEMMA_CACHE_PATH)
    print(f"navec lemma cache: {n_navec} entries at {NAVEC_LEMMA_CACHE_PATH}")
    n_rv = build_rusvectores_lemma_cache(RUSVECTORES_PATH, RUSVECTORES_LEMMA_CACHE_PATH)
    print(f"rusvectores lemma cache: {n_rv} entries at {RUSVECTORES_LEMMA_CACHE_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
