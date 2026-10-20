"""Bounded normalized-vector reuse without model weights or library facts."""

from concurrent.futures import ThreadPoolExecutor
import threading

import numpy as np
import pytest

from symbiknow.embeddings.runtime import EmbeddingUnavailable, ModelManager


class Runtime:
    def __init__(self, vision=False):
        self.model = object()
        self.vision = vision
        self.calls = 0

    def encode(self, items, **kwargs):
        self.calls += 1
        return np.full((len(items), 3), 2 if self.vision else 1, dtype=np.float32)

    def clear(self):
        pass


def test_exact_query_and_title_inputs_reuse_private_bounded_arrays():
    owner = ModelManager(factory=Runtime, timeout=0)
    try:
        first = owner.embed_query("cat")
        first[:] = 999
        assert np.array_equal(owner.embed_query("cat"), [1, 1, 1])
        assert owner.runtime.calls == 1
        docs = owner.embed_documents(["cat", "dog"], "Title")
        docs[:] = 999
        assert np.all(owner.embed_documents(["cat", "dog"], "Title") == 1)
        assert owner.runtime.calls == 2
        owner.embed_documents(["dog", "cat"], "Title")
        owner.embed_documents(["cat", "dog"], "Different title")
        owner.embed_query("title: Title | text: cat")
        assert owner.runtime.calls == 5
        assert owner.query_vectors.bytes <= 1024**2
        assert owner.document_vectors.bytes <= 8 * 1024**2
        assert owner.query_vectors.max_entries == 128 and owner.document_vectors.max_entries == 64
    finally:
        owner.unload(force=True)
    assert owner.query_vectors.bytes == owner.document_vectors.bytes == 0


def test_duplicate_inflight_inputs_share_work_but_unrelated_cache_hit_progresses():
    entered, release = threading.Event(), threading.Event()

    class Slow(Runtime):
        def encode(self, items, **kwargs):
            if "blocked" in items[0]:
                entered.set()
                assert release.wait(5)
            return super().encode(items, **kwargs)

    owner = ModelManager(factory=Slow, timeout=0)
    owner.embed_query("cached")
    try:
        with ThreadPoolExecutor(4) as pool:
            first = pool.submit(owner.embed_query, "blocked")
            assert entered.wait(3)
            second = pool.submit(owner.embed_query, "blocked")
            warm = pool.submit(owner.embed_query, "cached")
            try:
                assert np.all(warm.result(timeout=2) == 1)
            finally:
                release.set()
            a, b = first.result(), second.result()
            a[:] = 999
            assert np.all(b == 1)
        assert owner.runtime.calls == 2
    finally:
        owner.unload(force=True)


def test_actual_vision_precision_gets_its_own_text_vector_identity():
    owner = ModelManager(factory=Runtime, timeout=0)
    try:
        assert np.all(owner.embed_query("cat") == 1)
        owner.embed_images([object()])
        assert owner.loads == 2 and owner.runtime.vision
        assert np.all(owner.embed_query("cat") == 2)
        assert np.all(owner.embed_query("cat") == 2)
        assert owner.runtime.calls == 2  # image plus one text query on vision weights
        owner.job_boundary()
        assert owner.query_vectors.bytes == 0
        assert np.all(owner.embed_query("cat") == 1)
        assert owner.loads == 3
    finally:
        owner.unload(force=True)


def test_runtime_configuration_changes_invalidate_and_reload(monkeypatch):
    owner = ModelManager(factory=Runtime, timeout=0)
    try:
        owner.embed_query("cat")
        owner.embed_query("cat")
        assert owner.loads == 1
        monkeypatch.setenv("SYMBIKNOW_EMBEDDING_DIMENSION", "256")
        owner.embed_query("cat")
        assert owner.loads == 2
        monkeypatch.setenv("SYMBIKNOW_EMBEDDING_DEVICE", "cpu")
        owner.embed_query("cat")
        assert owner.loads == 3
    finally:
        owner.unload(force=True)


def test_failure_and_malformed_shape_never_enter_cache():
    class Broken(Runtime):
        def encode(self, items, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("temporary model failure")
            if self.calls == 2:
                return np.ones(3)
            if self.calls == 3:
                return np.full((1, 3), np.nan)
            return np.ones((1, 3), dtype=np.float32)

    owner = ModelManager(factory=Broken, timeout=0)
    try:
        for _ in range(3):
            with pytest.raises(EmbeddingUnavailable):
                owner.embed_query("cat")
            assert not owner.query_vectors
        assert np.all(owner.embed_query("cat") == 1)
        assert np.all(owner.embed_query("cat") == 1)
        assert owner.runtime.calls == 4
    finally:
        owner.unload(force=True)


def test_idle_retains_only_bounded_normalized_vectors_and_force_unload_clears():
    owner = ModelManager(factory=Runtime, timeout=0)
    owner.embed_query("cat")
    owner.unload()  # Normal idle cleanup, not explicit memory reset.
    assert owner.runtime is None
    assert np.all(owner.embed_query("cat") == 1) and owner.loads == 1
    owner.unload(force=True)
    assert not owner.query_vectors
    owner.embed_query("cat")
    assert owner.loads == 2
    owner.unload(force=True)


def test_cache_eviction_is_count_and_byte_bounded():
    owner = ModelManager(factory=Runtime, timeout=0)
    try:
        owner.query_vectors.max_entries = 2
        owner.document_vectors.max_bytes = 1
        for text in ["a", "b", "c"]:
            owner.embed_query(text)
            owner.embed_documents([text])
        assert len(owner.query_vectors) == 2 and not owner.document_vectors
        owner.embed_query("a")
        assert owner.runtime.calls == 7
    finally:
        owner.unload(force=True)


def test_queued_text_is_cached_under_actual_precision_after_vision_transition(monkeypatch):
    owner = ModelManager(factory=Runtime, timeout=0)
    entered, release = threading.Event(), threading.Event()
    encode = owner._encode

    def delayed(items, vision=False, **kwargs):
        if not vision:
            entered.set()
            assert release.wait(5)
        return encode(items, vision=vision, **kwargs)

    monkeypatch.setattr(owner, "_encode", delayed)
    try:
        with ThreadPoolExecutor(1) as pool:
            query = pool.submit(owner.embed_query, "cat")
            assert entered.wait(3)
            owner.embed_images([object()])
            release.set()
            assert np.all(query.result() == 2)
        assert len(owner.query_vectors) == 1
        assert np.all(owner.embed_query("cat") == 2)
        assert owner.runtime.calls == 2
    finally:
        release.set()
        owner.unload(force=True)


def test_force_unload_epoch_prevents_late_inflight_cache_repopulation(monkeypatch):
    owner = ModelManager(factory=Runtime, timeout=0)
    encoded, release = threading.Event(), threading.Event()
    encode = owner._encode

    def delayed(*args, **kwargs):
        result = encode(*args, **kwargs)
        encoded.set()
        assert release.wait(5)
        return result

    monkeypatch.setattr(owner, "_encode", delayed)
    try:
        with ThreadPoolExecutor(1) as pool:
            query = pool.submit(owner.embed_query, "cat")
            assert encoded.wait(3)
            owner.unload(force=True)
            release.set()
            assert np.all(query.result() == 1)
        assert owner.runtime is None and not owner.query_vectors
        owner.embed_query("cat")
        assert owner.loads == 2
    finally:
        release.set()
        owner.unload(force=True)
