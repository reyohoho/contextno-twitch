from __future__ import annotations

import csv
import os
import re
from typing import Iterable

from .embedder import DATA_DIR, Embedder


FREQ_CSV_PATH = os.path.join(DATA_DIR, "freqrnc2011.csv")

DEFAULT_POOL_SIZE = 5000
MIN_FREQ_IPM = 1.0
MIN_LEN = 3
MAX_LEN = 20

_CYRILLIC_RE = re.compile(r"^[а-яё]+$")


def _iter_freq_lemmas(path: str = FREQ_CSV_PATH) -> Iterable[tuple[str, str, float]]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            lemma = (row.get("Lemma") or "").strip().lower()
            pos = (row.get("PoS") or "").strip()
            try:
                freq = float(row.get("Freq(ipm)") or 0)
            except ValueError:
                continue
            if lemma and pos:
                yield lemma, pos, freq


def build_secret_pool(
    embedder: Embedder,
    *,
    size: int = DEFAULT_POOL_SIZE,
    min_freq_ipm: float = MIN_FREQ_IPM,
    pos_filter: tuple[str, ...] = ("s",),
) -> list[str]:
    candidates: list[tuple[str, float]] = []
    for lemma, pos, freq in _iter_freq_lemmas():
        if pos not in pos_filter:
            continue
        if freq < min_freq_ipm:
            continue
        if not (MIN_LEN <= len(lemma) <= MAX_LEN):
            continue
        if not _CYRILLIC_RE.match(lemma):
            continue
        if not embedder.has_word(lemma):
            continue
        candidates.append((lemma, freq))

    candidates.sort(key=lambda x: x[1], reverse=True)
    pool = [lemma for lemma, _ in candidates[:size]]
    return pool
