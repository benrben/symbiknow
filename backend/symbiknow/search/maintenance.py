"""Coalesced, single-owner background maintenance of native search indexes."""
import logging
from pathlib import Path
import threading
import weakref

_OWNERS = weakref.WeakValueDictionary()
_LOCK = threading.Lock()


def notify(root):
    with _LOCK:
        owner = _OWNERS.get(str(Path(root).resolve()))
        if owner:
            owner.wake.set()


class MaintenanceWorker:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.wake, self.stop = threading.Event(), threading.Event()
        self.thread = threading.Thread(target=self.run, name="symbiknow-index-maintenance", daemon=True)
        with _LOCK:
            _OWNERS[str(self.root)] = self

    def start(self):
        self.wake.set()
        self.thread.start()

    def run(self):
        from symbiknow.search.index import maintain_online
        while not self.stop.is_set():
            self.wake.wait(30)
            if self.stop.is_set():
                break
            if not self.wake.is_set():
                continue
            self.wake.clear()
            try:
                maintain_online(self.root)
                from symbiknow.organization import readmodel
                readmodel.prune(self.root)
            except Exception:
                logging.getLogger(__name__).exception("Index maintenance will retry")
                self.wake.set()
            self.stop.wait(5)

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread.is_alive():
            self.thread.join()
        with _LOCK:
            _OWNERS.pop(str(self.root), None)
