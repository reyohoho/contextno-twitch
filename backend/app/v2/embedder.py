from __future__ import annotations

import logging
import os
import re
from abc import ABC, abstractmethod
from typing import Iterable, Optional

import numpy as np


logger = logging.getLogger(__name__)

DATA_DIR = os.environ.get("CONTEXTNORF_DATA_DIR", "/app/data")
NAVEC_PATH = os.path.join(DATA_DIR, "navec_hudlit.tar")
NAVEC_LEMMA_CACHE_PATH = os.path.join(DATA_DIR, "navec_lemmas.txt")
RUSVECTORES_PATH = os.path.join(DATA_DIR, "rusvectores_ruscorpora.bin")
RUSVECTORES_LEMMA_CACHE_PATH = os.path.join(DATA_DIR, "rusvectores_lemmas.txt")

RUSVECTORES_ALLOWED_POS = ("NOUN",)

_CYRILLIC_RE = re.compile(r"^[а-яё-]+$")
_MIN_LEN = 2

_BAD_TAGS = ("Name", "Surn", "Patr", "Geox", "Orgn", "Trad", "Abbr")


def _is_clean_lemma(word: str, morph) -> bool:
    parses = morph.parse(word)
    if not parses:
        return False
    lemma_parses = [p for p in parses if p.normal_form == word]
    if not lemma_parses:
        return False
    good = [p for p in lemma_parses if not any(t in p.tag for t in _BAD_TAGS)]
    if not good:
        return False
    return any(p.tag.POS == "NOUN" for p in good)


def _l2_normalize(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return m / norms


class Embedder(ABC):
    id: str
    vocab: list[str]
    word_to_idx: dict[str, int]
    matrix: np.ndarray

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    @property
    def dim(self) -> int:
        return int(self.matrix.shape[1])

    def has_word(self, word: str) -> bool:
        return word in self.word_to_idx

    def index_of(self, word: str) -> Optional[int]:
        return self.word_to_idx.get(word)

    def vector_of(self, word: str) -> Optional[np.ndarray]:
        i = self.word_to_idx.get(word)
        if i is None:
            return None
        return self.matrix[i]

    def similarities_from(self, word: str) -> Optional[np.ndarray]:
        v = self.vector_of(word)
        if v is None:
            return None
        return self.matrix @ v

    @abstractmethod
    def _load(self) -> None: ...


def _iter_navec_lemmas(navec_words: Iterable[str]) -> Iterable[str]:
    import pymorphy3

    morph = pymorphy3.MorphAnalyzer()
    for w in navec_words:
        if len(w) < _MIN_LEN:
            continue
        if not _CYRILLIC_RE.match(w):
            continue
        if _is_clean_lemma(w, morph):
            yield w


def build_navec_lemma_cache(
    navec_path: str = NAVEC_PATH,
    cache_path: str = NAVEC_LEMMA_CACHE_PATH,
) -> int:
    from navec import Navec

    logger.info("loading Navec from %s ...", navec_path)
    navec = Navec.load(navec_path)
    logger.info("filtering %d words → lemmas via pymorphy3 ...", len(navec.vocab.words))
    lemmas = list(_iter_navec_lemmas(navec.vocab.words))
    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        for w in lemmas:
            f.write(w + "\n")
    os.replace(tmp_path, cache_path)
    logger.info("saved %d lemmas → %s", len(lemmas), cache_path)
    return len(lemmas)


class NavecEmbedder(Embedder):
    id = "navec"

    def __init__(
        self,
        path: str = NAVEC_PATH,
        lemma_cache_path: str = NAVEC_LEMMA_CACHE_PATH,
    ) -> None:
        self.path = path
        self.lemma_cache_path = lemma_cache_path
        self._load()

    def _load(self) -> None:
        from navec import Navec

        if not os.path.exists(self.lemma_cache_path):
            build_navec_lemma_cache(self.path, self.lemma_cache_path)

        navec = Navec.load(self.path)
        navec_set = set(navec.vocab.words)

        with open(self.lemma_cache_path, "r", encoding="utf-8") as f:
            lemmas = [line.strip() for line in f if line.strip()]

        vocab: list[str] = [w for w in lemmas if w in navec_set]
        N = len(vocab)
        D = int(navec.pq.dim)

        matrix = np.empty((N, D), dtype=np.float32)
        for i, w in enumerate(vocab):
            matrix[i] = navec[w]

        self.vocab = vocab
        self.word_to_idx = {w: i for i, w in enumerate(vocab)}
        self.matrix = _l2_normalize(matrix)


def _iter_rusvectores_lemmas(index_to_key: Iterable[str]) -> Iterable[str]:
    import pymorphy3

    morph = pymorphy3.MorphAnalyzer()
    allowed = set(RUSVECTORES_ALLOWED_POS)
    seen: set[str] = set()
    for key in index_to_key:
        if "_" not in key:
            continue
        lemma, _, pos = key.rpartition("_")
        if pos not in allowed:
            continue
        if len(lemma) < _MIN_LEN:
            continue
        if not _CYRILLIC_RE.match(lemma):
            continue
        if lemma in seen:
            continue
        if not _is_clean_lemma(lemma, morph):
            continue
        seen.add(lemma)
        yield lemma


def build_rusvectores_lemma_cache(
    model_path: str = RUSVECTORES_PATH,
    cache_path: str = RUSVECTORES_LEMMA_CACHE_PATH,
) -> int:
    from gensim.models import KeyedVectors

    logger.info("loading RusVectores from %s ...", model_path)
    kv = KeyedVectors.load_word2vec_format(model_path, binary=True)
    logger.info("filtering %d keys → clean lemmas via pymorphy3 ...", len(kv.index_to_key))
    lemmas = list(_iter_rusvectores_lemmas(kv.index_to_key))
    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        for w in lemmas:
            f.write(w + "\n")
    os.replace(tmp_path, cache_path)
    logger.info("saved %d lemmas → %s", len(lemmas), cache_path)
    return len(lemmas)


class RusVectoresEmbedder(Embedder):
    id = "rusvectores"

    def __init__(
        self,
        path: str = RUSVECTORES_PATH,
        lemma_cache_path: str = RUSVECTORES_LEMMA_CACHE_PATH,
    ) -> None:
        self.path = path
        self.lemma_cache_path = lemma_cache_path
        self._load()

    def _load(self) -> None:
        from gensim.models import KeyedVectors

        if not os.path.exists(self.lemma_cache_path):
            build_rusvectores_lemma_cache(self.path, self.lemma_cache_path)

        kv = KeyedVectors.load_word2vec_format(self.path, binary=True)

        with open(self.lemma_cache_path, "r", encoding="utf-8") as f:
            cached: set[str] = {line.strip() for line in f if line.strip()}

        allowed = set(RUSVECTORES_ALLOWED_POS)
        seen: set[str] = set()
        vocab: list[str] = []
        old_indices: list[int] = []

        for old_idx, key in enumerate(kv.index_to_key):
            if "_" not in key:
                continue
            lemma, _, pos = key.rpartition("_")
            if pos not in allowed:
                continue
            if lemma in seen:
                continue
            if lemma not in cached:
                continue
            seen.add(lemma)
            vocab.append(lemma)
            old_indices.append(old_idx)

        matrix = kv.vectors[old_indices].astype(np.float32, copy=True)

        self.vocab = vocab
        self.word_to_idx = {w: i for i, w in enumerate(vocab)}
        self.matrix = _l2_normalize(matrix)
