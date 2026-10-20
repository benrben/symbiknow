"""Bounded fair turns around the single embedding model owner."""

from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
import threading
import time

BACKGROUND_WORK = ContextVar("background_model_work", default=False)


class ModelBusy(RuntimeError):
    """Transient queue saturation; committed ingestion remains retryable."""


class ModelTurns:
    def __init__(self, capacity=32, interactive_reserve=4, interactive_burst=4):
        if capacity < 2 or not 0 < interactive_reserve < capacity or interactive_burst < 1:
            raise ValueError("Invalid model scheduling budgets")
        self.capacity = capacity
        self.background_capacity = capacity - interactive_reserve
        self.interactive_burst = interactive_burst
        self.condition = threading.Condition()
        self.interactive, self.background = deque(), deque()
        self.active = None
        self.streak = 0
        self.high_water = self.completed = 0
        self.wait_seconds = 0.

    def _selected(self):
        if self.interactive and (not self.background or self.streak < self.interactive_burst):
            return self.interactive[0]
        if self.background:
            return self.background[0]
        return None

    @contextmanager
    def turn(self, *, interactive=False):
        queue = self.interactive if interactive else self.background
        ticket = object()
        started = time.monotonic()
        with self.condition:
            waiting = len(self.interactive) + len(self.background)
            if waiting >= self.capacity or (not interactive and len(queue) >= self.background_capacity):
                raise ModelBusy("Embedding work queue is full; retry shortly")
            queue.append(ticket)
            self.high_water = max(self.high_water, waiting + 1)
            self.condition.notify_all()
            try:
                while self.active is not None or self._selected() is not ticket:
                    self.condition.wait()
            except BaseException:
                queue.remove(ticket)
                self.condition.notify_all()
                raise
            queue.popleft()
            self.active = "interactive" if interactive else "background"
            self.streak = min(self.interactive_burst, self.streak + 1) if interactive else 0
            waited = time.monotonic() - started
            self.wait_seconds += waited
        from symbiknow.search.metrics import add

        add("model_queue_wait_seconds", waited)
        try:
            yield
        finally:
            with self.condition:
                self.completed += 1
                self.active = None
                self.condition.notify_all()

    def stats(self):
        with self.condition:
            return dict(interactive_waiting=len(self.interactive),
                        background_waiting=len(self.background), active=self.active,
                        capacity=self.capacity, high_water=self.high_water,
                        completed=self.completed, wait_seconds=self.wait_seconds,
                        interactive_burst=self.interactive_burst)
