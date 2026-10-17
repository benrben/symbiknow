"""Original bytes and permanent versions, managed entirely by rocfl / OCFL.

One OCFL object contains ``original`` and versioned ``metadata.json``. User
filenames are metadata, never storage paths. No OCFL inventory is written here.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
import fcntl
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
import time

ROCFL_VERSION = "1.7.0"
_WRITE_LOCK = threading.RLock()
_LOCK_FD = threading.local()
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_VERSION = re.compile(r"v[1-9][0-9]*\Z")


class StorageError(RuntimeError):
    pass


class VersionConflict(ValueError):
    pass


@lru_cache(maxsize=8)
def _check_binary(binary: str) -> str:
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise StorageError("Install native rocfl 1.7.0 and set ROCFL_BIN; see README") from exc
    if result.stdout.decode().strip() != f"rocfl {ROCFL_VERSION}":
        raise StorageError(
            f"Required rocfl {ROCFL_VERSION}; found {result.stdout.decode().strip()}"
        )
    return binary


def _binary() -> str:
    local = Path(__file__).resolve().parent.parent / ".tools/native/bin/rocfl"
    binary = os.environ.get("ROCFL_BIN") or (
        str(local) if local.exists() else shutil.which("rocfl")
    )
    if not binary:
        raise StorageError("rocfl 1.7.0 is missing; install it and set ROCFL_BIN")
    return _check_binary(binary)


def _run(data_dir: str | Path, *args: str, missing_ok: bool = False) -> bytes | None:
    result = subprocess.run(
        [_binary(), "--no-styles", "-r", str(Path(data_dir).resolve() / "files"), *args],
        capture_output=True,
        # A killed Python daemon leaves an in-flight rocfl command running and
        # holding the inherited flock. Restart cannot race that commit.
        start_new_session=True,
        pass_fds=(getattr(_LOCK_FD, "fd"),) if hasattr(_LOCK_FD, "fd") else (),
    )
    if result.returncode:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        if "Not found:" in error:
            if missing_ok:
                return None
            raise FileNotFoundError(error)
        raise StorageError(f"rocfl {args[0]} failed: {error}")
    return result.stdout


def _validate_id(document_id: str) -> str:
    if not isinstance(document_id, str) or not _ID.fullmatch(document_id):
        raise ValueError("document_id must be 1–128 letters, digits, underscores or hyphens")
    return document_id


def _validate_version(version: str | None) -> None:
    if version is not None and (not isinstance(version, str) or not _VERSION.fullmatch(version)):
        raise ValueError("version must have the form v1, v2, ...")


@contextmanager
def _write_lock(data_dir: str | Path):
    root = Path(data_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK, (root / "storage.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        _LOCK_FD.fd = lock.fileno()
        try:
            yield
        finally:
            del _LOCK_FD.fd
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


@contextmanager
def read_snapshot(data_dir: str | Path):
    """Hold the same cross-process lock used by every supported storage writer.

    Read-only snapshot; do not nest another storage lock or do network work here.
    """
    with _write_lock(data_dir):
        yield


def init_storage(data_dir: str | Path) -> None:
    """Initialize an OCFL repository without touching an existing repository."""
    with _write_lock(data_dir):
        root = Path(data_dir).resolve()
        (root / "temp").mkdir(exist_ok=True)
        files = root / "files"
        if not (files / "0=ocfl_1.1").exists():
            _run(root, "init")


def read_metadata(data_dir: str | Path, document_id: str, version: str | None = None) -> dict:
    _validate_id(document_id)
    _validate_version(version)
    options = ["-v", version] if version else []
    raw = _run(data_dir, "cat", *options, document_id, "metadata.json")
    metadata = json.loads(raw)
    if metadata["document_id"] != document_id or (version and metadata["version"] != version):
        raise StorageError("Version metadata does not match requested object")
    return metadata


def current_version(data_dir: str | Path, document_id: str) -> str | None:
    from .search_metrics import add, stage

    add("head_reads", 1)
    with stage("head_reads"):
        try:
            return read_metadata(data_dir, document_id)["version"]
        except FileNotFoundError:
            return None


def list_versions(data_dir: str | Path, document_id: str) -> list[dict]:
    _validate_id(document_id)
    raw = _run(data_dir, "log", "-ct", document_id)
    # rocfl right-aligns this column even in TSV output: at v10, v1 becomes
    # " v1". Remove display padding before sorting or requesting stored versions.
    versions = [line.split("\t", 1)[0].strip() for line in raw.decode().splitlines() if line]
    return [
        read_metadata(data_dir, document_id, version)
        for version in sorted(versions, key=lambda v: int(v[1:]))
    ]


def list_documents(data_dir: str | Path) -> list[dict]:
    """Scan OCFL once for restart reconciliation; not intended for each query."""
    raw = _run(data_dir, "ls", "-ot")
    return [
        read_metadata(data_dir, document_id)
        for document_id in raw.decode().splitlines()
        if document_id
    ]


def read_file(
    data_dir: str | Path, document_id: str, version: str | None = None
) -> tuple[bytes, dict]:
    metadata = read_metadata(data_dir, document_id, version)
    # Pin to metadata's version even when caller requested current, avoiding a
    # concurrent update mixing old metadata with new file bytes.
    content = _run(data_dir, "cat", "-v", metadata["version"], document_id, "original")
    if (
        len(content) != metadata["size"]
        or hashlib.sha256(content).hexdigest() != metadata["sha256"]
    ):
        raise StorageError("Original byte integrity check failed")
    return content, metadata


def save_file(
    data_dir: str | Path,
    content: bytes,
    filename: str,
    mime_type: str | None = None,
    source: str | None = None,
    document_id: str | None = None,
    request_id: str | None = None,
    expected_version: str | None = None,
) -> dict:
    """Commit bytes before returning. Retries with a request_id create no version.

    Request IDs are scoped to a document. A new upload with a supplied request ID
    gets a deterministic UUID so a lost first response can be retried safely.
    A fresh upload of identical bytes still creates an independent OCFL version.
    """
    if not isinstance(content, (bytes, Path)):
        raise TypeError("content must be bytes or a staged Path")
    if not isinstance(filename, str) or not filename or "\x00" in filename:
        raise ValueError("filename must be nonempty text without NUL")
    if request_id is not None and (
        not isinstance(request_id, str) or not request_id or len(request_id) > 200
    ):
        raise ValueError("request_id must be 1–200 characters")
    if source is not None and not isinstance(source, str):
        raise ValueError("source must be text")
    if mime_type is not None and not isinstance(mime_type, str):
        raise ValueError("mime_type must be text")
    _validate_version(expected_version)
    if document_id is None:
        document_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, "symbiknow:upload:" + request_id)
            if request_id
            else uuid.uuid4()
        )
    _validate_id(document_id)
    request_id = request_id or str(uuid.uuid4())
    fields = {
        "document_id": document_id,
        "filename": filename,
        "mime_type": mime_type or mimetypes.guess_type(filename)[0] or "application/octet-stream",
        "source": source,
        "request_id": request_id,
        "sha256": _digest_path(content)
        if isinstance(content, Path)
        else hashlib.sha256(content).hexdigest(),
        "size": content.stat().st_size if isinstance(content, Path) else len(content),
    }
    init_storage(data_dir)
    with _write_lock(data_dir):
        if _deletion_path(data_dir, document_id).exists():
            raise VersionConflict(
                "This document was deleted. Upload with a new request ID to create a new document."
            )
        head = current_version(data_dir, document_id)
        if head:
            receipts = _repair_receipts(data_dir, document_id, head)
            receipt = receipts / (hashlib.sha256(request_id.encode()).hexdigest() + ".json")
            if not receipt.exists():
                # Detect a partially lost derived lookup before interpreting a miss.
                # Enumerate tiny receipt filenames, never historical OCFL metadata.
                count = sum(1 for entry in receipts.glob("*.json") if entry.name != "head.json")
                if count != int(head[1:]):
                    (receipts / "head.json").unlink(missing_ok=True)
                    _repair_receipts(data_dir, document_id, head)
            if receipt.exists():
                # OCFL remains authoritative, including after a lost commit response.
                previous = read_metadata(
                    data_dir, document_id, json.loads(receipt.read_text())["version"]
                )
                if any(previous.get(key) != value for key, value in fields.items()):
                    raise VersionConflict(
                        "request_id was already used with different file contents or metadata"
                    )
                return previous
        if expected_version is not None and expected_version != head:
            raise VersionConflict(f"Expected {expected_version}, found {head or 'no version'}")
        version = f"v{int(head[1:]) + 1}" if head else "v1"
        metadata = {
            **fields,
            "version": version,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        # Discard incomplete prior staging for this object. Committed history is
        # never reset; an interrupted upload can then be retried from its bytes.
        _run(data_dir, "reset", document_id, missing_ok=True)
        if not head:
            _run(data_dir, "new", document_id)
        with tempfile.TemporaryDirectory(
            prefix="upload-", dir=Path(data_dir).resolve() / "temp"
        ) as temp:
            for name, value in (
                ("original", content),
                ("metadata.json", json.dumps(metadata, ensure_ascii=False).encode()),
            ):
                path = Path(temp) / name
                with path.open("wb") as output:
                    if isinstance(value, Path):
                        with value.open("rb") as source_file:
                            shutil.copyfileobj(source_file, output, length=1024 * 1024)
                    else:
                        output.write(value)
                    output.flush()
                    os.fsync(output.fileno())
                if name == "original" and (
                    _digest_path(path) != fields["sha256"] or path.stat().st_size != fields["size"]
                ):
                    raise StorageError(
                        "Staged original changed during upload; retry from the original file"
                    )
                _run(data_dir, "cp", document_id, str(path), "--", name)
            _run(data_dir, "commit", "-n", "Symbiknow", "-m", "upload " + request_id, document_id)
        _repair_receipts(data_dir, document_id, version)
        return metadata


def _deletion_path(data_dir, document_id):
    return Path(data_dir).resolve() / "temp" / "deleted-documents" / f"{document_id}.json"


def delete_document(data_dir, document_id, expected_version):
    """Purge an entire OCFL object with a durable receipt and a current-head guard."""
    _validate_id(document_id)
    _validate_version(expected_version)
    if expected_version is None:
        raise ValueError("Deletion requires expected_version")
    with _write_lock(data_dir):
        path = _deletion_path(data_dir, document_id)
        head = current_version(data_dir, document_id)
        if path.exists():
            if json.loads(path.read_text())["version"] != expected_version:
                raise VersionConflict("Deletion receipt refers to a different version")
            if head is None:
                return
        if head is None:
            raise FileNotFoundError("Document not found")
        if head != expected_version:
            raise VersionConflict(
                f"Expected {expected_version}, found {head}; review the latest version before deleting"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as handle:
            json.dump({"document_id": document_id, "version": head}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        _run(data_dir, "purge", "--force", document_id)
    clear_deleted_caches(data_dir, document_id)


def clear_deleted_caches(data_dir, document_id):
    # A leased FileResponse may not have opened its file yet. Keep its pinned
    # path until the last reader exits; new reads still fail OCFL validation.
    with _TRANSFER_LOCK:
        root = Path(data_dir) / "temp"
        for file in (root / "transfers").glob(f"{document_id}-*.bin"):
            file = file.resolve()
            if _TRANSFER_ACTIVE.get(file):
                _TRANSFER_DELETED.add(file)
            else:
                file.unlink(missing_ok=True)
                _TRANSFER_VERIFIED.pop(file, None)
        shutil.rmtree(root / "receipts" / document_id, ignore_errors=True)
        for file in (root / "thumbnails").glob(f"{document_id}-*"):
            file.unlink(missing_ok=True)
        (root / "index-retries" / f"{document_id}.json").unlink(missing_ok=True)


def recover_deletions(data_dir):
    """Finish requested purges after a process interruption, before index reconciliation."""
    root = Path(data_dir).resolve() / "temp" / "deleted-documents"
    for path in sorted(root.glob("*.json")):
        receipt = json.loads(path.read_text())
        delete_document(data_dir, receipt["document_id"], receipt["version"])
        clear_deleted_caches(data_dir, receipt["document_id"])


def _digest_path(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _repair_receipts(data_dir, document_id, head):
    """One durable receipt per request, checkpointed only after all intervening commits.

    A missing lookup/head marker is repaired from OCFL, never treated as a miss.
    Caller owns the storage writer lock. OCFL version numbers are contiguous.
    """
    from .organization_edits import atomic

    root = Path(data_dir) / "temp" / "receipts" / document_id
    marker = root / "head.json"
    complete = json.loads(marker.read_text())["head"] if marker.exists() else "v0"
    for number in range(int(complete[1:]) + 1, int(head[1:]) + 1):
        metadata = read_metadata(data_dir, document_id, f"v{number}")
        key = hashlib.sha256(metadata["request_id"].encode()).hexdigest()
        atomic(root / (key + ".json"), {"version": metadata["version"]})
    if complete != head:
        atomic(marker, {"head": head})
    return root


def version_page(data_dir, document_id, offset=0, limit=30, head=None):
    """Newest first metadata page; additions cannot shift a pinned history head."""
    if offset < 0 or not 1 <= limit <= 100:
        raise ValueError("History offset/limit out of range")
    with read_snapshot(data_dir):
        _validate_version(head)
        head = read_metadata(data_dir, document_id, head)["version"]
        total = int(head[1:])
        numbers = range(total - offset, max(0, total - offset - limit), -1)
        return {
            "versions": [read_metadata(data_dir, document_id, f"v{n}") for n in numbers],
            "total": total,
            "head": head,
            "offset": offset,
            "has_more": offset + limit < total,
        }


_TRANSFER_LOCK = threading.RLock()
_TRANSFER_ACTIVE = {}
_TRANSFER_VERIFIED = {}
_TRANSFER_DELETED = set()


def _prune_transfers(root, keep=None):
    """Disk budget excludes open leases; over-budget active files leave on release."""
    budget = int(os.getenv("SYMBIKNOW_TRANSFER_CACHE_BYTES", str(1024**3)))
    age = float(os.getenv("SYMBIKNOW_TRANSFER_CACHE_SECONDS", "3600"))
    files = sorted(root.glob("*.bin"), key=lambda p: p.stat().st_mtime, reverse=True)
    size = 0
    for path in files:
        size += path.stat().st_size
        if (
            path != keep
            and not _TRANSFER_ACTIVE.get(path)
            and (size > budget or time.time() - path.stat().st_mtime > age)
        ):
            path.unlink(missing_ok=True)


@contextmanager
def verified_file(data_dir, document_id, version=None):
    """Stream rocfl once into a verified, version-pinned temporary file.

    Leases protect active readers from eviction. Storage lock covers validation and
    extraction, never network transfer/rendering. Only rocfl reads OCFL layout.
    """
    _validate_id(document_id)
    _validate_version(version)
    root = Path(data_dir).resolve() / "temp" / "transfers"
    with _TRANSFER_LOCK:
        with read_snapshot(data_dir):
            metadata = read_metadata(data_dir, document_id, version)
            root.mkdir(parents=True, exist_ok=True)
            path = root / f"{document_id}-{metadata['version']}-{metadata['sha256']}.bin"
            if not path.exists():
                staging = path.with_suffix(".tmp")
                try:
                    with staging.open("wb") as output, tempfile.TemporaryFile() as errors:
                        result = subprocess.run(
                            [
                                _binary(),
                                "--no-styles",
                                "-r",
                                str(Path(data_dir).resolve() / "files"),
                                "cat",
                                "-v",
                                metadata["version"],
                                document_id,
                                "original",
                            ],
                            stdout=output,
                            stderr=errors,
                            start_new_session=True,
                            pass_fds=(_LOCK_FD.fd,),
                        )
                        if result.returncode:
                            raise StorageError("rocfl streaming read failed")
                    if (
                        staging.stat().st_size != metadata["size"]
                        or _digest_path(staging) != metadata["sha256"]
                    ):
                        raise StorageError("Original byte integrity check failed")
                    staging.replace(path)
                    _TRANSFER_VERIFIED[path] = (
                        path.stat().st_ino,
                        path.stat().st_size,
                        path.stat().st_mtime_ns,
                    )
                finally:
                    staging.unlink(missing_ok=True)
            stamp = (path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns)
            if _TRANSFER_VERIFIED.get(path) != stamp:
                if (
                    path.stat().st_size != metadata["size"]
                    or _digest_path(path) != metadata["sha256"]
                ):
                    path.unlink(missing_ok=True)
                    raise StorageError(
                        "Cached original byte integrity check failed; retry to restore from OCFL"
                    )
            os.utime(path, None)
            _TRANSFER_VERIFIED[path] = (
                path.stat().st_ino,
                path.stat().st_size,
                path.stat().st_mtime_ns,
            )
            while len(_TRANSFER_VERIFIED) > 512:
                _TRANSFER_VERIFIED.pop(next(iter(_TRANSFER_VERIFIED)))
            _TRANSFER_ACTIVE[path] = _TRANSFER_ACTIVE.get(path, 0) + 1
        _prune_transfers(root, keep=path)
    try:
        yield path, metadata
    finally:
        with _TRANSFER_LOCK:
            _TRANSFER_ACTIVE[path] -= 1
            if not _TRANSFER_ACTIVE[path]:
                _TRANSFER_ACTIVE.pop(path)
                if path in _TRANSFER_DELETED:
                    path.unlink(missing_ok=True)
                    _TRANSFER_VERIFIED.pop(path, None)
                    _TRANSFER_DELETED.discard(path)
            _prune_transfers(root)
