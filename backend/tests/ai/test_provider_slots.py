"""Provider slots are granted in arrival order; a releasing caller cannot barge."""
import threading
import time

import pytest

from symbiknow.ai.jev import _FairSlots


def wait_until(condition, seconds=2):
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "condition not reached"
        time.sleep(0.001)


def test_waiter_is_served_before_the_releasing_caller_reacquires():
    slots, order = _FairSlots(1), []
    assert slots.acquire(1)
    granted, release = threading.Event(), threading.Event()

    def waiter():
        assert slots.acquire(5)
        order.append("waiter")
        granted.set()
        release.wait(5)
        slots.release()

    thread = threading.Thread(target=waiter)
    thread.start()
    wait_until(lambda: len(slots._queue) == 1)
    slots.release()
    # The busy caller asks again at once; the earlier waiter must win.
    assert not slots.acquire(0.05)
    assert granted.wait(2) and order == ["waiter"]
    release.set()
    assert slots.acquire(2)
    order.append("caller")
    thread.join(2)
    assert order == ["waiter", "caller"]


def test_timed_out_waiter_never_blocks_callers_behind_it():
    slots = _FairSlots(1)
    assert slots.acquire(1)
    assert not slots.acquire(0.02)
    assert not slots._queue
    slots.release()
    assert slots.acquire(0)


def test_free_slots_are_granted_without_waiting_and_over_release_fails():
    slots = _FairSlots(2)
    assert slots.acquire(0) and slots.acquire(0)
    assert not slots.acquire(0)
    slots.release()
    slots.release()
    with pytest.raises(ValueError):
        slots.release()
