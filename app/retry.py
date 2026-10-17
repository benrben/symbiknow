"""Durable per-version indexing retry policy. New heads bypass old failures."""

import time
from pathlib import Path

from .organization_edits import atomic


def path(data_dir, identity):
    return Path(data_dir) / "temp" / "index-retries" / (identity + ".json")


def state(data_dir, metadata):
    import json

    file = path(data_dir, metadata["document_id"])
    value = json.loads(file.read_text()) if file.exists() else {}
    return value if value.get("version") == metadata["version"] else {}


def due(data_dir, metadata, now=None):
    value = state(data_dir, metadata)
    return not value.get("paused") and value.get("next_retry", 0) <= (
        time.time() if now is None else now
    )


def failed(data_dir, metadata, error, permanent=False, now=None):
    attempts = state(data_dir, metadata).get("attempts", 0) + 1
    value = {
        "version": metadata["version"],
        "attempts": attempts,
        "next_retry": (time.time() if now is None else now)
        + min(3600, 30 * 2 ** min(attempts - 1, 7)),
        "paused": permanent,
        "error": str(error)[:1000],
    }
    atomic(path(data_dir, metadata["document_id"]), value)
    return value


def clear(data_dir, identity):
    path(data_dir, identity).unlink(missing_ok=True)
