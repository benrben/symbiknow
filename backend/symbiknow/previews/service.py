"""One owner for bounded preview work, keyed in-flight coalescing and disk cleanup."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import threading
import time

# Includes original raster/PDF renderer settings. Extraction-based cards bind
# their response reuse to the published index and organization revisions.
RENDERER_REVISION = "preview-2"


class PreviewBusy(ValueError):
    pass


class PreviewJobs:
    def __init__(self, workers=2, capacity=10):
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="symbiknow-preview")
        self.capacity = capacity
        self.lock = threading.RLock()
        self.flights = {}

    def submit(self, key, function, *args):
        with self.lock:
            if key in self.flights:
                return self.flights[key]
            if len(self.flights) >= self.capacity:
                raise PreviewBusy("Preview queue is full; retry shortly")
            future = self.pool.submit(function, *args)
            self.flights[key] = future

            def finished(_):
                with self.lock:
                    self.flights.pop(key, None)

            future.add_done_callback(finished)
            return future

    def run(self, key, function, *args):
        return self.submit(key, function, *args).result()

    async def wait(self, key, function, *args):
        # Canceling a waiter must not cancel shared work or release a running renderer's slot.
        return await asyncio.shield(asyncio.wrap_future(self.submit(key, function, *args)))

    def drain(self):
        with self.lock:
            futures = list(self.flights.values())
            for future in futures:
                future.cancel()  # Only queued jobs; running renderers retain capacity.
        for future in futures:
            try:
                future.result()
            except Exception:
                pass

    def shutdown(self):
        self.pool.shutdown(wait=True, cancel_futures=True)


JOBS = PreviewJobs()


def prune(root, keep):
    budget = int(os.getenv("SYMBIKNOW_PREVIEW_CACHE_BYTES", str(256 * 1024**2)))
    age = float(os.getenv("SYMBIKNOW_PREVIEW_CACHE_SECONDS", str(7 * 86400)))
    total = 0
    for path in sorted(Path(root).glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True):
        total += path.stat().st_size
        if path != keep and (total > budget or time.time() - path.stat().st_mtime > age):
            path.unlink(missing_ok=True)
            path.with_suffix(".json").unlink(missing_ok=True)
