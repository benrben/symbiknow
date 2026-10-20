"""Request-local timings/counts only; never record queries, text or credentials."""

from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

CURRENT = ContextVar("search_metrics", default=None)


def add(name, value):
    metrics = CURRENT.get()
    if metrics is not None:
        metrics[name] = metrics.get(name, 0) + value


@contextmanager
def stage(name):
    start = perf_counter()
    try:
        yield
    finally:
        add(name + "_seconds", perf_counter() - start)


@contextmanager
def timed_lock(lock, name):
    start = perf_counter()
    lock.acquire()
    add(name + "_wait_seconds", perf_counter() - start)
    held = perf_counter()
    try:
        yield
    finally:
        add(name + "_hold_seconds", perf_counter() - held)
        lock.release()
