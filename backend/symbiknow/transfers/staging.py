"""Bounded, resumable upload bytes; durable receipts are never cache cleanup."""
import json
import logging
from pathlib import Path
import threading
import time
import uuid

LOCK = threading.RLock()
IDLE_SECONDS = 24 * 3600
MAX_STAGED_FILES = 1024
MAX_STAGED_BYTES = 2 * 1024**3


def source_id(identity):
    return identity.get("document_id") or str(uuid.uuid5(
        uuid.NAMESPACE_URL, "symbiknow:upload:" + identity["request_id"]))


def purge_source(data_dir, document_id):
    # Called under original-deletion locks: never acquire LOCK (upload commits
    # acquire those locks in the opposite order). Atomic manifests and tombstone
    # checks before/after each chunk make concurrent writers fail safely. Startup
    # replays deletion receipts if a process exits before its post-write check.
    root = Path(data_dir)
    for part in parts(root):
        manifest = part.with_suffix(".json")
        try:
            if not manifest.is_symlink() and source_id(json.loads(manifest.read_text())["identity"]) == document_id:
                part.unlink(missing_ok=True)
        except (OSError, ValueError, KeyError, TypeError):
            continue


def reject_deleted(context, identity):
    from symbiknow.library import storage
    document_id = storage._validate_id(source_id(identity))
    if storage._deletion_path(context.DATA_DIR, document_id).exists():
        purge_source(context.DATA_DIR, document_id)
        raise storage.VersionConflict("This document was deleted. Upload with a new request ID to create a new document.")


def parts(root):
    for path in (root / "temp").glob("*.part"):
        try:
            if str(uuid.UUID(path.stem)) == path.stem and not path.is_symlink():
                yield path
        except ValueError:
            continue


def cleanup(context, *, now=None):
    """Expire inactive bytes only. Preserve request identity and commit receipts."""
    now = time.time() if now is None else now
    removed = 0
    with LOCK:
        for part in parts(context.DATA_DIR):
            manifest = part.with_suffix(".json")
            try:
                if manifest.is_symlink():
                    continue
                last_activity = max(part.stat().st_mtime, manifest.stat().st_mtime if manifest.exists() else 0)
                if now - last_activity < IDLE_SECONDS:
                    continue
                state = json.loads(manifest.read_text()) if manifest.exists() else {}
                try:
                    job = context.work.get("jobs", "upload-" + part.stem)
                except FileNotFoundError:
                    job = None
                if job and job["state"] in {"queued", "running"}:
                    continue
                if state and not state.get("result"):
                    from symbiknow.organization.edits import atomic
                    state.pop("queued", None)
                    state["expired"] = True
                    atomic(manifest, state)
                part.unlink()
                removed += 1
            except (OSError, ValueError, TypeError):
                logging.getLogger(__name__).warning("Could not expire upload %s", part.stem, exc_info=True)
    return removed


def admit(context, part, additional):
    """Called under LOCK before writing; account for actual bytes, including retries."""
    staged = list(parts(context.DATA_DIR))
    if not part.exists() and len(staged) >= MAX_STAGED_FILES:
        raise ValueError("Too many unfinished uploads; finish an upload or retry after its 24-hour expiry")
    limit = max(MAX_STAGED_BYTES, context.MAX_FILE)
    if sum(path.stat().st_size for path in staged) + additional > limit:
        raise ValueError("Upload staging is full; finish an upload or retry after its 24-hour expiry")
