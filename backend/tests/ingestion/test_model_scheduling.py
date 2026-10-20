"""Scheduling fairness without loading any model weights."""

from concurrent.futures import ThreadPoolExecutor
import threading

import numpy as np
import pytest

from symbiknow.embeddings.runtime import ModelManager
from symbiknow.embeddings.scheduling import ModelBusy, ModelTurns


def test_manual_scan_queries_use_background_lane_without_changing_interactive_queries():
    from symbiknow.embeddings.scheduling import BACKGROUND_WORK
    from tests.ingestion.test_embedding_reuse import Runtime
    lanes = []

    class ObservedRuntime(Runtime):
        def encode(self, items, **kwargs):
            lanes.append(owner.turns.stats()["active"])
            return super().encode(items, **kwargs)

    owner = ModelManager(factory=ObservedRuntime, timeout=0)
    try:
        token = BACKGROUND_WORK.set(True)
        try:
            owner.embed_query("scan candidate")
        finally:
            BACKGROUND_WORK.reset(token)
        owner.embed_query("interactive question")
        assert lanes == ["background", "interactive"]
    finally:
        owner.unload(force=True)


def waiting(turns, count):
    with turns.condition:
        assert turns.condition.wait_for(
            lambda: len(turns.background) + len(turns.interactive) == count, timeout=3
        )


def test_interactive_priority_and_bounded_background_starvation():
    turns = ModelTurns(capacity=10, interactive_reserve=2, interactive_burst=4)
    entered, release = threading.Event(), threading.Event()
    order = []

    def run(name, interactive=False, block=False):
        with turns.turn(interactive=interactive):
            order.append(name)
            if block:
                entered.set()
                assert release.wait(5)

    with ThreadPoolExecutor(9) as pool:
        first = pool.submit(run, "active", block=True)
        assert entered.wait(3)
        futures = []
        for ordinal in range(2):
            futures.append(pool.submit(run, f"b{ordinal}"))
            waiting(turns, ordinal + 1)
        for ordinal in range(6):
            futures.append(pool.submit(run, f"q{ordinal}", interactive=True))
            waiting(turns, ordinal + 3)
        release.set()
        first.result()
        for future in futures:
            future.result()
    assert order == ["active", "q0", "q1", "q2", "q3", "b0", "q4", "q5", "b1"]
    assert turns.stats()["completed"] == 9
    assert turns.stats()["active"] is None


def test_queue_reserves_interactive_capacity_and_releases_after_exception():
    turns = ModelTurns(capacity=3, interactive_reserve=1)
    entered, release = threading.Event(), threading.Event()

    def run():
        with turns.turn():
            entered.set()
            assert release.wait(5)

    with ThreadPoolExecutor(4) as pool:
        first = pool.submit(run)
        assert entered.wait(3)
        second, third = pool.submit(run), pool.submit(run)
        waiting(turns, 2)
        with pytest.raises(ModelBusy):
            with turns.turn():
                pytest.fail("saturated background lane was accepted")
        query = pool.submit(lambda: query_turn(turns))
        waiting(turns, 3)
        with pytest.raises(ModelBusy):
            with turns.turn(interactive=True):
                pytest.fail("saturated queue was accepted")
        release.set()
        for future in [first, second, third, query]:
            future.result()
    with pytest.raises(ValueError):
        with turns.turn():
            raise ValueError("fixture failure")
    with turns.turn():
        assert turns.stats()["active"] == "background"


def query_turn(turns):
    with turns.turn(interactive=True):
        return "interactive"


def test_model_manager_routes_queries_to_interactive_lane_and_keeps_one_owner():
    entered, release = threading.Event(), threading.Event()
    calls = []

    class Runtime:
        vision = False
        model = object()

        def __init__(self, **kwargs):
            self.vision = kwargs["vision"]
            self.model = object()

        def encode(self, items, **kwargs):
            calls.extend(items)
            if len(calls) == 1:
                entered.set()
                assert release.wait(5)
            return np.ones((len(items), 3), dtype=np.float32)

        def clear(self):
            pass

    owner = ModelManager(factory=Runtime, timeout=0)
    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(owner.embed_documents, ["first"])
        assert entered.wait(3)
        background = pool.submit(owner.embed_documents, ["second"])
        waiting(owner.turns, 1)
        query = pool.submit(owner.embed_query, "interactive")
        waiting(owner.turns, 2)
        release.set()
        for future in [first, background, query]:
            assert future.result().dtype == np.float32
    assert "interactive" in calls[1] and "second" in calls[2]
    assert owner.loads == 1
    assert owner.stats()["queue"]["high_water"] == 2
    owner.unload(force=True)


def test_processor_batches_independent_images_instead_of_one_multi_image_source():
    from symbiknow.embeddings.runtime import _features

    first, second = object(), object()
    requests = []

    def processor(**kwargs):
        requests.append(kwargs)
        return dict(input_ids=np.ones((len(kwargs["images"]), 4)))

    assert _features(processor, [first, second], images=True)["input_ids"].shape[0] == 2
    assert requests[0]["images"] == [[first], [second]]
    assert requests[0]["padding"] is True
    _features(processor, [first], images=True)
    assert requests[1]["images"] == [[first]]


def test_model_owner_rejects_loss_of_per_source_vector_identity():
    from symbiknow.embeddings.runtime import EmbeddingUnavailable

    class Broken:
        vision = True

        def __init__(self, **kwargs):
            self.model = object()

        def encode(self, *args, **kwargs):
            return np.ones((1, 3), dtype=np.float32)

        def clear(self):
            pass

    owner = ModelManager(factory=Broken, timeout=0)
    with pytest.raises(EmbeddingUnavailable, match="vector count"):
        owner.embed_images([object(), object()])
    owner.unload(force=True)
