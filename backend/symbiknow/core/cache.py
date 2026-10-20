"""Shared dependency identities and bounded, successful derived-work reuse."""

import asyncio
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
import copy
import hashlib
import json
import sys
import threading


def dependency_key(namespace, **dependencies):
    """Canonical identity; callers supply every revision that can change the result."""
    payload = json.dumps(dependencies, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                         allow_nan=False).encode("utf-8")
    return f"{namespace}:{hashlib.sha256(payload).hexdigest()}"


def owned_bytes(value):
    seen = set()

    def size(item):
        if id(item) in seen:
            return 0
        seen.add(id(item))
        total = sys.getsizeof(item)
        if isinstance(item, dict):
            total += sum(size(k) + size(v) for k, v in item.items())
        elif isinstance(item, (list, tuple, set)):
            total += sum(size(v) for v in item)
        return total

    return size(value)


class ByteLRU(OrderedDict):
    def __init__(self, max_entries=512, max_bytes=8 * 1024**2):
        if max_entries < 0 or max_bytes < 0:
            raise ValueError("Cache budgets must be nonnegative")
        super().__init__()
        self.max_entries, self.max_bytes = max_entries, max_bytes
        self.sizes, self.bytes = {}, 0
        self.hits = self.misses = self.evictions = 0

    def __getitem__(self, key):
        try:
            value = super().__getitem__(key)
        except KeyError:
            self.misses += 1
            raise
        self.hits += 1
        self.move_to_end(key)
        return value

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __setitem__(self, key, value):
        if key in self:
            self.__delitem__(key)
        super().__setitem__(key, value)
        self.sizes[key] = owned_bytes(key) + owned_bytes(value)
        self.bytes += self.sizes[key]
        while len(self) > self.max_entries or self.bytes > self.max_bytes:
            self.popitem(last=False)
            self.evictions += 1

    def __delitem__(self, key):
        super().__delitem__(key)
        self.bytes -= self.sizes.pop(key)

    def pop(self, key, *default):
        if key not in self:
            if default:
                return default[0]
            raise KeyError(key)
        value = super().__getitem__(key)
        self.__delitem__(key)
        return value

    def popitem(self, last=True):
        key, value = super().popitem(last=last)
        self.bytes -= self.sizes.pop(key)
        return key, value

    def clear(self):
        super().clear()
        self.sizes.clear()
        self.bytes = 0

    def stats(self):
        return dict(entries=len(self), bytes=self.bytes, hits=self.hits,
                    misses=self.misses, evictions=self.evictions)


class CacheBusy(RuntimeError):
    """The bounded derived-work queue is full; durable callers may retry."""


class CoalescingCache:
    """One computation per key, bounded retention and active distinct keys.

    Synchronous callers compute on their own thread. Async callers share a bounded
    executor and shield their waiter so cancelling one never cancels other users.
    Cached values must be immutable or copied by the consuming domain owner.
    """

    def __init__(self, max_entries=512, max_bytes=8 * 1024**2, max_inflight=8):
        if max_inflight < 1:
            raise ValueError("At least one in-flight slot is required")
        self.values = ByteLRU(max_entries, max_bytes)
        self.max_inflight = max_inflight
        self.lock = threading.RLock()
        self.flights = {}
        self.coalesced = self.computations = 0
        self.pool = None
        self.closed = False

    def _claim(self, key):
        with self.lock:
            if self.closed:
                raise RuntimeError("Derived-work cache is closed")
            if key in self.values:
                ready = Future()
                ready.set_result(self.values[key])
                return ready, False
            self.values.misses += 1
            if key in self.flights:
                self.coalesced += 1
                return self.flights[key], False
            if len(self.flights) >= self.max_inflight:
                raise CacheBusy("Derived-work queue is full; retry shortly")
            future = self.flights[key] = Future()
            self.computations += 1
            return future, True

    def _compute(self, key, future, function):
        try:
            value = function()
            with self.lock:
                self.values[key] = value
            future.set_result(value)
        except BaseException as exc:
            future.set_exception(exc)
        finally:
            with self.lock:
                self.flights.pop(key, None)

    def get_or_compute(self, key, function, *, return_reused=False):
        future, owner = self._claim(key)
        if owner:
            self._compute(key, future, function)
        value = future.result()
        return (value, not owner) if return_reused else value

    async def wait(self, key, function):
        future, owner = self._claim(key)
        if owner:
            with self.lock:
                if self.closed:
                    future.set_exception(RuntimeError("Derived-work cache is closed"))
                    self.flights.pop(key, None)
                else:
                    if self.pool is None:
                        self.pool = ThreadPoolExecutor(max_workers=self.max_inflight,
                                                       thread_name_prefix="symbiknow-cache")
                    self.pool.submit(self._compute, key, future, function)
        return await asyncio.shield(asyncio.wrap_future(future))

    def stats(self):
        with self.lock:
            return dict(self.values.stats(), inflight=len(self.flights),
                        coalesced=self.coalesced, computations=self.computations)

    def close(self):
        with self.lock:
            self.closed = True
            pending = list(self.flights.values())
        if self.pool:
            self.pool.shutdown(wait=True)
        for future in pending:
            try:
                future.result()
            except Exception:
                pass
        with self.lock:
            self.values.clear()


def reuse_success(cache, key, function, *, lock, flights, successful=lambda value: True,
                  publication_key=None):
    """Share an existing namespace's cache and flights; return a private result and hit flag.

    The second lookup closes the race between an initial miss and claiming work.
    Provider exceptions never enter retention. A flight is scoped to the actual
    cache instance as well, so replacing one library's owner cannot share work.
    """
    with lock:
        if key in cache:
            return copy.deepcopy(cache[key]), True
        cache.misses += 1

    def compute():
        with lock:
            if key in cache:
                return copy.deepcopy(cache[key]), True
        value = function()
        with lock:
            if successful(value):
                cache[publication_key(value) if publication_key else key] = copy.deepcopy(value)
        return value, False

    (value, hit), coalesced = flights.get_or_compute((id(cache), key), compute,
                                                   return_reused=True)
    return copy.deepcopy(value), hit or coalesced
