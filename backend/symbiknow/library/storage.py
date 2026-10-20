"""Original bytes and permanent versions, managed entirely by rocfl / OCFL.

One OCFL object contains ``original`` and versioned ``metadata.json``. User
filenames are metadata, never storage paths. No OCFL inventory is written here.
"""

from __future__ import annotations

from symbiknow.core.paths import REPO_ROOT

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
import atexit
import select
from collections import OrderedDict
from types import MappingProxyType

ROCFL_VERSION = "1.7.0"
_METADATA_BYTES = 16 * 1024 * 1024
_WRITE_LOCK = threading.RLock()
_LOCK_FD = threading.local()
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_VERSION = re.compile(r"v[1-9][0-9]*\Z")


class StorageError(RuntimeError):
    pass


class _MetadataLimit(StorageError):
    """Explicit native byte budget; only this failure permits bounded splitting."""




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
    local = REPO_ROOT / ".tools/native/bin/rocfl"
    binary = os.environ.get("ROCFL_BIN") or (
        str(local) if local.exists() else shutil.which("rocfl")
    )
    if not binary:
        raise StorageError("rocfl 1.7.0 is missing; install it and set ROCFL_BIN")
    return _check_binary(binary)


def _run(data_dir: str | Path, *args: str, missing_ok: bool = False) -> bytes | None:
    from symbiknow.search.metrics import add

    add("storage_cli_launches", 1)
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
    if getattr(_LOCK_FD, "root", None) == root:
        yield
        return
    if hasattr(_LOCK_FD, "root"):
        raise StorageError("Cannot nest storage snapshots from different libraries")
    with _WRITE_LOCK, (root / "storage.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        _LOCK_FD.fd = lock.fileno()
        _LOCK_FD.root = root
        try:
            yield
        finally:
            del _LOCK_FD.fd
            del _LOCK_FD.root
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


@contextmanager
def read_snapshot(data_dir: str | Path):
    """Hold the same cross-process lock used by every supported storage writer.

    Read-only snapshot; do not nest another storage lock or do network work here.
    """
    with _write_lock(data_dir):
        yield


def source_revision(data_dir):
    """Invalidation token for supported writers, never a substitute for heads.

    Writers fsync a new token BEFORE any OCFL mutation while holding storage.lock.
    A crash after committing but before derived publication therefore cannot
    leave the old token visible. Callers compare this token only after an actual
    authoritative dependency validation and under the final storage snapshot.
    """
    file = Path(data_dir).resolve() / "temp" / "storage-revision.json"
    return json.loads(file.read_text())["revision"] if file.exists() else "initial"


def _begin_mutation(data_dir):
    from symbiknow.organization.edits import atomic

    atomic(
        Path(data_dir).resolve() / "temp" / "storage-revision.json",
        {"schema": 1, "revision": uuid.uuid4().hex},
    )


def init_storage(data_dir: str | Path) -> None:
    """Initialize an OCFL repository without touching an existing repository."""
    with _write_lock(data_dir):
        root = Path(data_dir).resolve()
        (root / "temp").mkdir(exist_ok=True)
        files = root / "files"
        if not (files / "0=ocfl_1.1").exists():
            _run(root, "init")


class _MetadataReader:
    """One bounded native reader per library; no cached head or inventory state."""

    def __init__(self, root):
        self.root = root
        self.lock = threading.RLock()
        self.process = None

    def close(self):
        process, self.process = self.process, None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for stream in (process.stdin, process.stdout):
                if stream:
                    stream.close()

    def _start(self):
        local = REPO_ROOT / ".tools/native/bin/symbiknow-ocfl-reader"
        binary = str(local) if local.exists() else shutil.which("symbiknow-ocfl-reader")
        if not binary:
            raise StorageError("Install the pinned OCFL reader: scripts/setup/install_ocfl_reader.sh")
        result = subprocess.run([binary, "--version"], capture_output=True, timeout=10)
        if (
            result.returncode
            or result.stdout.decode().strip() != "symbiknow-ocfl-reader 2 (rocfl 1.7.0)"
        ):
            raise StorageError("Unsupported native OCFL reader protocol")
        self.process = subprocess.Popen(
            [binary, str(self.root / "files")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        from symbiknow.search.metrics import add

        add("storage_reader_launches", 1)

    def request(self, references):
        from symbiknow.search.metrics import add

        payload = (
            json.dumps(
                {
                    "requests": [
                        {"document_id": identity, "version": version}
                        for identity, version in references
                    ]
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        if len(payload) > 1024 * 1024:
            raise ValueError("Storage metadata request exceeds byte budget")
        with self.lock:
            for attempt in range(2):
                try:
                    if self.process is None or self.process.poll() is not None:
                        self.close()
                        self._start()
                    add("storage_backend_batches", 1)
                    deadline = time.monotonic() + 30
                    descriptor = self.process.stdin.fileno()
                    os.set_blocking(descriptor, False)
                    offset = 0
                    while offset < len(payload):
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not select.select([], [descriptor], [], remaining)[1]:
                            raise TimeoutError("Native OCFL metadata request timed out")
                        try:
                            offset += os.write(descriptor, payload[offset:])
                        except BlockingIOError:
                            continue
                    response = bytearray()
                    while not response.endswith(b"\n"):
                        remaining = deadline - time.monotonic()
                        if (
                            remaining <= 0
                            or not select.select([self.process.stdout], [], [], remaining)[0]
                        ):
                            raise TimeoutError("Native OCFL metadata read timed out")
                        block = os.read(self.process.stdout.fileno(), 65536)
                        if not block:
                            raise BrokenPipeError("Native OCFL reader exited")
                        response.extend(block)
                        if len(response) > 16 * 1024 * 1024 + 1024:
                            raise StorageError("Native OCFL reader response exceeds byte budget")
                    result = json.loads(response)
                    if not isinstance(result, dict):
                        self.close()
                        raise StorageError("Invalid native OCFL response object")
                    if not result.get("ok"):
                        error = result.get("error", {})
                        exception = _MetadataLimit if error.get("kind") == "limit" else StorageError
                        raise exception("Native OCFL read failed: " + str(error))
                    metadata = result["metadata"]
                    if len(metadata) != len(references):
                        raise StorageError("Native OCFL reader response identity count mismatch")
                    return metadata
                except (OSError, TimeoutError, json.JSONDecodeError) as exc:
                    self.close()
                    add("storage_reader_restarts", 1)
                    if attempt:
                        raise StorageError("Native OCFL reader unavailable after restart") from exc


    def request_stream(self, reference):
        """Read exceptional historical metadata through bounded native frames.

        Temporary bytes belong to this request. Nothing escapes until the whole
        native read and JSON parse succeed; normal batches retain their fast path.
        """
        from symbiknow.search.metrics import add

        identity, version = reference
        payload = (json.dumps({"requests": [{"document_id": identity, "version": version}],
                               "stream": True}, separators=(",", ":")).encode() + b"\n")
        with self.lock:
            for attempt in range(2):
                try:
                    if self.process is None or self.process.poll() is not None:
                        self.close()
                        self._start()
                    add("storage_backend_batches", 1)
                    deadline = time.monotonic() + 30
                    descriptor = self.process.stdin.fileno()
                    os.set_blocking(descriptor, False)
                    offset = 0
                    while offset < len(payload):
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not select.select([], [descriptor], [], remaining)[1]:
                            raise TimeoutError("Native OCFL stream request timed out")
                        try:
                            offset += os.write(descriptor, payload[offset:])
                        except BlockingIOError:
                            continue
                    buffered = bytearray()
                    with tempfile.TemporaryFile() as staged:
                        while True:
                            while b"\n" not in buffered:
                                remaining = deadline - time.monotonic()
                                if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                                    raise TimeoutError("Native OCFL metadata stream timed out")
                                block = os.read(self.process.stdout.fileno(), 65536)
                                if not block:
                                    raise BrokenPipeError("Native OCFL reader exited during stream")
                                buffered.extend(block)
                                if b"\n" not in buffered and len(buffered) > 132 * 1024:
                                    raise StorageError("Native OCFL metadata stream frame exceeds budget")
                            line, _, tail = buffered.partition(b"\n")
                            if len(line) > 132 * 1024:
                                raise StorageError("Native OCFL metadata stream frame exceeds budget")
                            buffered = bytearray(tail)
                            frame = json.loads(line)
                            if not isinstance(frame, dict):
                                raise StorageError("Invalid native metadata stream frame")
                            deadline = time.monotonic() + 30
                            if "chunk_hex" in frame:
                                try:
                                    chunk = bytes.fromhex(frame["chunk_hex"])
                                except (TypeError, ValueError) as exc:
                                    raise StorageError("Invalid native metadata stream chunk") from exc
                                if len(chunk) > 65536:
                                    raise StorageError("Native metadata stream chunk exceeds budget")
                                staged.write(chunk)
                                continue
                            if not frame.get("complete"):
                                raise StorageError("Invalid native metadata stream terminal")
                            if not frame.get("ok"):
                                raise StorageError("Native OCFL stream failed: " + str(frame.get("error")))
                            if buffered:
                                raise StorageError("Unexpected trailing native metadata stream frame")
                            if frame.get("missing"):
                                if staged.tell():
                                    raise StorageError("Missing metadata stream contained bytes")
                                return None
                            staged.seek(0)
                            try:
                                metadata = json.load(staged)
                                if not isinstance(metadata, dict):
                                    raise StorageError("Stored metadata must be an object")
                                return metadata
                            except (ValueError, UnicodeError) as exc:
                                raise StorageError("Stored metadata is invalid JSON") from exc
                except (OSError, TimeoutError, json.JSONDecodeError) as exc:
                    self.close()
                    add("storage_reader_restarts", 1)
                    if attempt:
                        raise StorageError("Native OCFL metadata stream unavailable after restart") from exc
                except StorageError:
                    # A malformed stream may leave frames unread. Never reuse it.
                    self.close()
                    raise

    def request_bounded(self, references):
        try:
            return self.request(references)
        except _MetadataLimit:
            if len(references) == 1:
                return [self.request_stream(references[0])]
            middle = len(references) // 2
            return self.request_bounded(references[:middle]) + self.request_bounded(references[middle:])


_READERS = OrderedDict()
_READERS_LOCK = threading.RLock()


def close_readers():
    with _READERS_LOCK:
        for reader in _READERS.values():
            with reader.lock:
                reader.close()
        _READERS.clear()


atexit.register(close_readers)


def _read_metadata_many(data_dir, references):
    references = list(dict.fromkeys(references))
    if len(references) > 800:
        raise ValueError("Storage metadata shortlist exceeds 800 identities")
    for identity, version in references:
        _validate_id(identity)
        _validate_version(version)
    if not references:
        return {}
    root = Path(data_dir).resolve()
    from symbiknow.search.metrics import add, stage

    add("head_reads", len(references))
    add("head_batches", 1)
    with read_snapshot(root), stage("head_reads"):
        # Keep the registry lease through the request. Eviction cannot close a
        # selected reader and let it restart outside the bounded owner registry.
        with _READERS_LOCK:
            reader = _READERS.get(root)
            if reader is None:
                reader = _READERS[root] = _MetadataReader(root)
            _READERS.move_to_end(root)
            while len(_READERS) > 8:
                _, retired = _READERS.popitem(last=False)
                with retired.lock:
                    retired.close()
            values = reader.request_bounded(references)
    output = {}
    for (identity, version), metadata in zip(references, values):
        if metadata is not None:
            if not isinstance(metadata, dict) or metadata.get("document_id") != identity:
                raise StorageError("Version metadata does not match requested object")
            try:
                if not metadata.get("version"):
                    raise ValueError("Missing committed metadata version")
                _validate_version(metadata["version"])
            except (ValueError, KeyError) as exc:
                raise StorageError("Stored version metadata is invalid") from exc
            if version and metadata["version"] != version:
                raise StorageError("Version metadata does not match requested object")
        output[(identity, version)] = metadata
    return output


def metadata_many(data_dir, document_ids):
    """Fresh authoritative metadata in one native request; immutable outer mapping."""
    return MappingProxyType(
        {
            identity: value
            for (identity, _), value in _read_metadata_many(
                data_dir, [(identity, None) for identity in document_ids]
            ).items()
        }
    )


def heads_many(data_dir, document_ids):
    return MappingProxyType(
        {
            identity: value["version"] if value else None
            for identity, value in metadata_many(data_dir, document_ids).items()
        }
    )


def read_metadata(data_dir: str | Path, document_id: str, version: str | None = None) -> dict:
    result = _read_metadata_many(data_dir, [(document_id, version)])[(document_id, version)]
    if result is None:
        raise FileNotFoundError(f"Document {document_id} {version or 'head'} not found")
    return result


def current_version(data_dir: str | Path, document_id: str) -> str | None:
    return heads_many(data_dir, [document_id])[document_id]


def list_versions(data_dir: str | Path, document_id: str) -> list[dict]:
    _validate_id(document_id)
    raw = _run(data_dir, "log", "-ct", document_id)
    # rocfl right-aligns this column even in TSV output: at v10, v1 becomes
    # " v1". Remove display padding before sorting or requesting stored versions.
    versions = [line.split("\t", 1)[0].strip() for line in raw.decode().splitlines() if line]
    ordered = sorted(versions, key=lambda v: int(v[1:]))
    result = []
    for offset in range(0, len(ordered), 800):
        references = [(document_id, version) for version in ordered[offset : offset + 800]]
        result.extend(_read_metadata_many(data_dir, references).values())
    return result


def list_documents(data_dir: str | Path) -> list[dict]:
    """Scan OCFL once for restart reconciliation; not intended for each query."""
    raw = _run(data_dir, "ls", "-ot")
    identities = [identity for identity in raw.decode().splitlines() if identity]
    result = []
    for offset in range(0, len(identities), 800):
        result.extend(
            value
            for value in metadata_many(data_dir, identities[offset : offset + 800]).values()
            if value
        )
    return result


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
        metadata_bytes = json.dumps(metadata, ensure_ascii=False).encode()
        if len(metadata_bytes) > _METADATA_BYTES:
            raise ValueError("Serialized version metadata exceeds the 16 MiB commit limit")
        _begin_mutation(data_dir)
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
                ("metadata.json", metadata_bytes),
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
        _begin_mutation(data_dir)
        _run(data_dir, "purge", "--force", document_id)
    clear_deleted_caches(data_dir, document_id)


def clear_deleted_caches(data_dir, document_id):
    from symbiknow.ingestion.artifacts import discard_document
    discard_document(data_dir, document_id)
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
    from symbiknow.organization.edits import atomic

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
    if (not isinstance(offset, int) or isinstance(offset, bool) or offset < 0
            or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100):
        raise ValueError("History offset/limit out of range")
    with read_snapshot(data_dir):
        _validate_version(head)
        head = read_metadata(data_dir, document_id, head)["version"]
        total = int(head[1:])
        numbers = range(total - offset, max(0, total - offset - limit), -1)
        return {
            "versions": list(
                _read_metadata_many(data_dir, [(document_id, f"v{n}") for n in numbers]).values()
            ),
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
