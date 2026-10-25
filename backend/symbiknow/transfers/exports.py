"""Durable bounded selection exports, prepared by application workers."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import time
import threading
import uuid
import zipfile

from symbiknow.library import storage
from symbiknow.organization.edits import atomic


# Lock order: storage snapshot, then export lock. Archive creation itself stays
# outside both locks; only validated publication and range reads are protected.
LOCK = threading.RLock()


def dependencies(state):
    return state.get("documents", state.get("files", []))


def validate(data_dir, state):
    references = [(item["document_id"], item["version"]) for item in dependencies(state)]
    for offset in range(0, len(references), 800):
        if any(row is None for row in storage._read_metadata_many(data_dir, references[offset:offset + 800]).values()):
            raise FileNotFoundError("An exported source version is unavailable")


def _discard(receipt):
    for suffix in (".json", ".zip", ".tmp", ".pending"):
        receipt.with_suffix(suffix).unlink(missing_ok=True)


def purge_document(data_dir, identity):
    with LOCK:
        for directory in ("selection-exports", "folder-exports"):
            for receipt in (Path(data_dir) / "temp" / directory).glob("*.json"):
                try:
                    state = json.loads(receipt.read_text())
                    affected = any(item["document_id"] == identity for item in dependencies(state))
                except (ValueError, KeyError, TypeError):
                    affected = True  # An unprovable archive must not remain downloadable.
                if affected:
                    _discard(receipt)


def cleanup(data_dir):
    """Startup/periodic expiry also removes orphaned preparation files."""
    with LOCK:
        now = time.time()
        # The retired adapter-only export cache has no current readers/tokens.
        for file in (Path(data_dir) / "temp" / "exports").glob("*.zip"):
            file.unlink(missing_ok=True)
        for directory in ("selection-exports", "folder-exports"):
            root = Path(data_dir) / "temp" / directory
            for receipt in root.glob("*.json"):
                try:
                    expired = json.loads(receipt.read_text())["expires_at"] <= now
                except (ValueError, KeyError, TypeError):
                    expired = True
                if expired:
                    _discard(receipt)
            for file in root.glob("*"):
                if file.suffix in {".zip", ".tmp", ".pending"} and now - file.stat().st_mtime > 600:
                    if not file.with_suffix(".json").exists():
                        file.unlink(missing_ok=True)


class ExportUnavailable(ValueError):
    def __init__(self, failures):
        super().__init__("Download stopped: selected versions are unavailable")
        self.failures = failures


def prepare(context, items, token):
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("Select 1–100 files to download")
    token = str(uuid.UUID(token))
    root = context.DATA_DIR / "temp" / "selection-exports"
    root.mkdir(parents=True, exist_ok=True)
    receipt = root / (token + ".json")
    if receipt.exists():
        state = json.loads(receipt.read_text())
        if state["documents"] != items:
            raise ValueError("Export ID belongs to another selection")
        if state["expires_at"] <= time.time():
            raise ValueError("Export expired; start a new export")
        path(context, token)
        return {"url": "/api/export?token=" + token, "expires_in": max(0, int(state["expires_at"] - time.time()))}
    metadata, failures = [], []
    for item in items:
        try:
            metadata.append(context.originals.metadata(item["document_id"], item["version"]))
        except (FileNotFoundError, ValueError, KeyError):
            failures.append({"document_id": item.get("document_id"), "version": item.get("version"), "error": "Selected version is unavailable"})
    if failures:
        raise ExportUnavailable(failures)
    if sum(row["size"] for row in metadata) > 1024**3:
        raise ValueError("Bulk download is limited to 1 GiB; download smaller selections")
    cleanup(context.DATA_DIR)
    with LOCK:
        if sum(1 for _ in root.glob("*.json")) + sum(1 for _ in root.glob("*.pending")) >= 4:
            raise ValueError("Four exports are retained; reuse one or retry after expiry")
        reservation = root / (token + ".pending")
        reservation.touch()
    destination = root / (token + ".zip")
    staging = destination.with_suffix(".tmp")
    names = set()
    try:
        with zipfile.ZipFile(staging, "w", compression=zipfile.ZIP_STORED) as archive:
            for row in metadata:
                from symbiknow.transfers.folders import _archive_parts
                name = _archive_parts(row["filename"].replace("\\", "/").split("/")[-1])
                base, suffix, count = Path(name).stem, Path(name).suffix, 1
                while name.casefold() in names:
                    count += 1
                    name = f"{base} ({count}){suffix}"
                names.add(name.casefold())
                storage.prepare_ranges(context.DATA_DIR, row["document_id"], row["version"])
                with storage.verified_ranges(context.DATA_DIR, row["document_id"], row["version"]) as (reader, _), archive.open(name, "w", force_zip64=True) as target:
                    for offset in range(0, row["size"], context.MAX_CHUNK):
                        target.write(reader.read(offset, context.MAX_CHUNK))
        state = {"documents": items, "expires_at": time.time() + 600}
        with storage.read_snapshot(context.DATA_DIR), LOCK:
            validate(context.DATA_DIR, state)
            staging.replace(destination)
            try:
                atomic(receipt, state)
            except Exception:
                destination.unlink(missing_ok=True)
                raise
    finally:
        staging.unlink(missing_ok=True)
        reservation.unlink(missing_ok=True)
    return {"url": "/api/export?token=" + token, "expires_in": 600}


def path(context, token):
    token = str(uuid.UUID(token))
    file = context.DATA_DIR / "temp" / "selection-exports" / (token + ".zip")
    with storage.read_snapshot(context.DATA_DIR), LOCK:
        state = json.loads(file.with_suffix(".json").read_text())
        if state["expires_at"] <= time.time():
            _discard(file)
            raise FileNotFoundError("Export expired; prepare a new export")
        try:
            validate(context.DATA_DIR, state)
        except (FileNotFoundError, ValueError):
            _discard(file)
            raise FileNotFoundError("An exported file was deleted; prepare a new export") from None
        return file, len(state["documents"])


@contextmanager
def opened(context, token):
    """Admit and open under validation; never reopen the pathname while serving."""
    with storage.read_snapshot(context.DATA_DIR), LOCK:
        file, count = path(context, token)
        handle = file.open("rb")
        try:
            stat = os.fstat(handle.fileno())
        except BaseException:
            handle.close()
            raise
    try:
        yield handle, count, stat
    finally:
        handle.close()
