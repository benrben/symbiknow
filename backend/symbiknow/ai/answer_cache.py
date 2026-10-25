"""Durable hosted-judge answers keyed by the exact request; no text is retained.

The key is a digest of the schema, model, endpoint and complete request (state
and questions), so any change to evidence, prompt or model misses. Entries hold
only the provider's answer labels, probabilities and usage: option keys such as
``o0`` or ``answer``, never document text. Acceptance gates apply after reuse,
so changing a gate never needs invalidation. Entries expire after a fixed age;
the directory is bounded by allocated bytes and evicts the oldest first.
Best-effort: any storage problem is a miss, never a failed judgment.

Layout, atomic publication and eviction follow jevgrep ``packages/core/src/cache.ts``
(MIT License, Copyright (c) 2026 David Zhang; full notice in ``ai/sensitive.py``).
"""

import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time
import uuid

SCHEMA = 1
TTL_SECONDS = 7 * 24 * 3600
MAX_BYTES = 256 * 1024**2
MAX_ENTRY_BYTES = 1024**2
_PENDING_SECONDS = 3600  # Abandoned publications after a crash.
_SWEEP_SECONDS = 3600


def _allocated(size, blocks=0):
    """Tiny files still occupy whole filesystem blocks; the byte bound counts them."""
    return max(math.ceil(size / 4096) * 4096, blocks * 512)


class AnswerCache:
    def __init__(self, data_dir, *, ttl=TTL_SECONDS, max_bytes=MAX_BYTES, now=time.time):
        self.root = Path(data_dir)
        self.entries = self.root / "temp" / "jev-answer-cache" / "entries"
        self.ttl, self.max_bytes, self.now = ttl, max_bytes, now
        self._lock = threading.Lock()
        self._estimate = 0
        self._swept_at = None

    @staticmethod
    def key(identity):
        payload = json.dumps([SCHEMA, identity], sort_keys=True, ensure_ascii=False,
                             separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode("utf-8", "surrogatepass")).hexdigest()

    def get(self, key):
        try:
            fd = os.open(self.entries / f"{key}.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            return None
        try:
            with os.fdopen(fd, "rb") as handle:
                data = handle.read(MAX_ENTRY_BYTES + 1)
            if len(data) > MAX_ENTRY_BYTES:
                return None
            value = json.loads(data.decode())
            age = self.now() - value["created_at"]
            if value.get("schema") != SCHEMA or not 0 <= age < self.ttl:
                return None
            response = value["response"]
            return response if isinstance(response, dict) else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def put(self, key, response):
        # A stale owner of a removed library must never recreate it.
        if not self.root.is_dir():
            return
        payload = json.dumps({"schema": SCHEMA, "created_at": self.now(), "response": response},
                             ensure_ascii=False, separators=(",", ":")).encode()
        if len(payload) > MAX_ENTRY_BYTES or _allocated(len(payload)) > self.max_bytes:
            return
        pending = self.entries / f".pending-{uuid.uuid4()}"
        try:
            self.entries.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.entries.parent, 0o700)
            os.chmod(self.entries, 0o700)
            fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
            os.replace(pending, self.entries / f"{key}.json")
        except OSError:
            pending.unlink(missing_ok=True)
            return
        with self._lock:
            self._estimate += _allocated(len(payload))
            due = (self._swept_at is None or self.now() - self._swept_at >= _SWEEP_SECONDS
                   or self._estimate > self.max_bytes)
        if due:
            self.sweep()

    def sweep(self):
        """Remove expired and abandoned files, then evict oldest to 7/8 of the budget."""
        with self._lock:
            retained, total, now = [], 0, self.now()
            try:
                names = list(os.scandir(self.entries))
            except OSError:
                return
            for entry in names:
                try:
                    info = entry.stat(follow_symlinks=False)
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    age = now - info.st_mtime
                    if entry.name.startswith(".pending-"):
                        if age > _PENDING_SECONDS:
                            os.unlink(entry.path)
                    elif not entry.name.endswith(".json"):
                        continue
                    elif age >= self.ttl:
                        os.unlink(entry.path)
                    else:
                        size = _allocated(info.st_size, getattr(info, "st_blocks", 0))
                        retained.append((info.st_mtime, entry.name, entry.path, size))
                        total += size
                except OSError:
                    continue
            if total > self.max_bytes:
                target = self.max_bytes - self.max_bytes // 8
                for _, _, path, size in sorted(retained):
                    if total <= target:
                        break
                    try:
                        os.unlink(path)
                        total -= size
                    except OSError:
                        pass
            self._estimate, self._swept_at = total, now
