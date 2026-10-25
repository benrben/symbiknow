"""Folder transfers: per-file commits and bounded, version-pinned ZIP snapshots."""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
import uuid
import zipfile
from pathlib import Path

from symbiknow.organization import edits as organization_edits
from symbiknow.library import storage
from symbiknow.transfers import exports

MAX_EXPORT_FILES = 1000
MAX_EXPORT_BYTES = 1024**3
EXPORT_TTL = 600
EXPORT_SLOTS = 4
_EXPORT_LOCK = exports.LOCK
_UPLOAD_LOCK = threading.RLock()


def staged_input(data_dir, identity):
    if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
        raise ValueError("Invalid staged folder upload identity")
    return Path(data_dir) / "temp" / "folder-upload-jobs" / (identity + ".json")


def upload_sources(payload):
    """Stable original identities, including new files not yet committed."""
    request = uuid.UUID(payload["request_id"])
    sources = set()
    for item in payload["files"]:
        identity = item.get("document_id")
        if not identity:
            relative = "/".join(relative_parts(item["relative_path"])).casefold()
            file_request = str(uuid.uuid5(request, relative))
            identity = str(uuid.uuid5(uuid.NAMESPACE_URL, "symbiknow:upload:" + file_request))
        sources.add(identity)
    return sources


def cleanup_staged(context, *, now=None):
    """Expire inactive folder input bytes; job and upload receipts stay durable."""
    from symbiknow.transfers.staging import IDLE_SECONDS
    now = time.time() if now is None else now
    removed = 0
    # The adapter renews input mtime under this lock before retry admission.
    with context.write_lock:
        active = context.work.active_inputs("folder-upload")
        for file in (context.DATA_DIR / "temp" / "folder-upload-jobs").glob("*.json"):
            if not re.fullmatch(r"[0-9a-f]{64}", file.stem) or file.is_symlink() or file.stem in active:
                continue
            try:
                if now - file.stat().st_mtime >= IDLE_SECONDS:
                    file.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                logging.getLogger(__name__).warning("Could not expire folder upload %s", file.stem, exc_info=True)
    return removed


def purge_staged_document(data_dir, identity):
    for path in (Path(data_dir) / "temp" / "folder-upload-jobs").glob("*.json"):
        try:
            sources = upload_sources(json.loads(path.read_text()))
        except (ValueError, KeyError, TypeError, FileNotFoundError):
            continue
        if identity in sources:
            path.unlink(missing_ok=True)


def relative_parts(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ValueError("relative_path must be a nonempty relative POSIX path")
    parts = value.split("/")
    if any(
        not p
        or p in {".", ".."}
        or p != p.strip()
        or len(p) > 200
        or any(ord(c) < 32 or ord(c) == 127 or c in "\\:›" for c in p)
        for p in parts
    ):
        raise ValueError(
            "Use relative paths without empty, dot, parent, drive or backslash segments"
        )
    return parts


def upload_folder(folder, files, request_id, *, context=None):
    from symbiknow.core.application import current_application

    server = context or current_application()

    server.transfers._batch(files)
    root = organization_edits.normalize(folder)
    if request_id is None:
        raise ValueError("request_id must be a UUID for the folder upload")
    identity = server.transfers._request_id(request_id)
    # Reject ambiguous paths before committing any file in this batch.
    paths = [relative_parts(item.get("relative_path")) for item in files]
    if len({"/".join(p).casefold() for p in paths}) != len(paths):
        raise ValueError("Duplicate relative paths in this batch")
    destinations = [organization_edits.normalize(" / ".join([root, *p[:-1]])) for p in paths]
    results = []
    with _UPLOAD_LOCK:
        journal = server.DATA_DIR / "temp" / "folder-uploads" / identity
        binding = journal / "folder.json"
        if binding.exists():
            if json.loads(binding.read_text())["folder"] != root:
                raise ValueError("Folder request_id reused with a different destination")
        else:
            organization_edits.atomic(binding, {"folder": root})
        for index, (item, parts, destination) in enumerate(zip(files, paths, destinations)):
            # Each path has its own stable upload identity, including across batches/restarts.
            file_request = str(uuid.uuid5(uuid.UUID(identity), "/".join(parts).casefold()))
            receipt_path = journal / f"{file_request}.json"
            receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
            transfer = {k: v for k, v in item.items() if k != "relative_path"}
            transfer.update(filename=parts[-1], request_id=file_request)
            binding_fields = {
                k: transfer.get(k)
                for k in (
                    "filename",
                    "mime_type",
                    "source",
                    "document_id",
                    "expected_version",
                    "total_size",
                    "sha256",
                )
            }
            binding_fields["relative_path"] = "/".join(parts)
            if receipt and receipt["identity"] != binding_fields:
                results.append(
                    {
                        "index": index,
                        "relative_path": "/".join(parts),
                        "stored": False,
                        "error": "Folder file request reused with different metadata",
                    }
                )
                continue
            if not receipt:
                receipt = {"identity": binding_fields, "assigned": False}
                organization_edits.atomic(receipt_path, receipt)
            result = server.transfers.upload([transfer])["files"][0]
            result.update(
                index=index,
                relative_path="/".join(parts),
                folder=destination,
                folder_assigned=False,
            )
            if result.get("stored"):
                try:
                    if not receipt.get("assigned"):
                        organization_edits.edit(
                            "move-documents",
                            {
                                "folder": destination,
                                "documents": [
                                    {
                                        "document_id": result["document_id"],
                                        "expected_version": result["version"],
                                    }
                                ],
                            },
                            context=server,
                        )
                        organization_edits.atomic(
                            receipt_path,
                            {
                                "identity": binding_fields,
                                "assigned": True,
                                "document_id": result["document_id"],
                                "version": result["version"],
                            },
                        )
                    # A retry must not undo a subsequent manual move.
                    result["folder_assigned"] = True
                    result["folder_assignment"] = "completed_for_upload"
                except Exception as exc:
                    result["error"] = f"File stored, folder assignment pending: {exc}"
                    result["hint"] = (
                        "Retry the same folder request and file bytes to finish assignment"
                    )
            results.append(result)
    return {
        "folder": root,
        "request_id": identity,
        "files": results,
        "complete": all(r.get("stored") and r.get("folder_assigned") for r in results),
    }


def _archive_parts(value):
    """Make portable archive names for existing arbitrary library metadata."""
    clean = "".join("_" if ord(c) < 32 or ord(c) == 127 or c in "\\/:›" else c for c in value)
    clean = clean.strip().rstrip(".")
    return clean if clean and clean not in {".", ".."} else "document"


def _snapshot(folder, context=None):
    from symbiknow.core.application import current_application

    server = context or current_application()
    from symbiknow.search.index import browse_documents

    with server.snapshots.read() as snapshot:
        page = browse_documents(server.DATA_DIR, limit=MAX_EXPORT_FILES + 1, folder=folder)
        rows = page["documents"]
        if not rows:
            raise ValueError("Folder not found or contains no files")
        if len(rows) > MAX_EXPORT_FILES:
            raise ValueError(f"Folder export limit is {MAX_EXPORT_FILES} files; select a subfolder")
        metadata = snapshot.metadata_many([row["document_id"] for row in rows])
        result = []
        for row in sorted(rows, key=lambda r: (r["folder"], r["document_id"])):
            meta = metadata[row["document_id"]]
            if not meta or meta["version"] != row["version"]:
                raise ValueError("Folder metadata changed; retry the export")
            result.append({**meta, "folder": row["folder"]})
        if sum(m["size"] for m in result) > MAX_EXPORT_BYTES:
            raise ValueError("Folder export limit is 1 GiB; select a smaller subfolder")
        return result


def _create_export(root, folder, context=None):
    from symbiknow.core.application import current_application

    server = context or current_application()

    rows = _snapshot(folder, server)
    token = str(uuid.uuid4())
    archive_path = root / f"{token}.zip"
    names = set()
    manifest = []
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for row in rows:
                tail = row["folder"][len(folder) :].removeprefix(" / ")
                parents = [_archive_parts(p) for p in tail.split(" / ")] if tail else []
                filename = _archive_parts(row["filename"])
                candidate = "/".join([*parents, filename])
                suffix = 1
                # Avoid case-insensitive duplicates and file/directory conflicts.
                while (
                    candidate.casefold() in names
                    or any(candidate.casefold().startswith(n + "/") for n in names)
                    or any(n.startswith(candidate.casefold() + "/") for n in names)
                ):
                    suffix += 1
                    # Prefix all components to resolve a parent that was a file.
                    candidate = "/".join(
                        [f"{p} ({suffix})" for p in parents]
                        + [f"{Path(filename).stem} ({suffix}){Path(filename).suffix}"]
                    )
                names.add(candidate.casefold())
                storage.prepare_ranges(server.DATA_DIR, row["document_id"], row["version"])
                with storage.verified_ranges(server.DATA_DIR, row["document_id"], row["version"]) as (reader, meta):
                    with archive.open(candidate, "w", force_zip64=True) as dest:
                        for offset in range(0, meta["size"], server.MAX_CHUNK):
                            dest.write(reader.read(offset, server.MAX_CHUNK))
                manifest.append(
                    {
                        "path": candidate,
                        "document_id": row["document_id"],
                        "version": row["version"],
                        "sha256": row["sha256"],
                        "size": row["size"],
                    }
                )
        state = {
            "transfer_id": token,
            "folder": folder,
            "expires_at": time.time() + EXPORT_TTL,
            "size": archive_path.stat().st_size,
            "sha256": storage._digest_path(archive_path),
            "file_count": len(rows),
            "files": manifest,
        }
        with storage.read_snapshot(server.DATA_DIR), _EXPORT_LOCK:
            exports.validate(server.DATA_DIR, state)
            organization_edits.atomic(root / f"{token}.json", state)
        return state
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise


def download_folder(folder, transfer_id=None, offset=0, length=None, *, context=None, on_snapshot=None):
    from symbiknow.core.application import current_application

    server = context or current_application()

    folder = organization_edits.normalize(folder)
    length = server.MAX_CHUNK if length is None else length
    if type(offset) is not int or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if type(length) is not int or not 1 <= length <= server.MAX_CHUNK:
        raise ValueError("length must be between 1 and the configured chunk limit")
    if transfer_id is None and offset:
        raise ValueError("Start at offset 0 without transfer_id")
    if transfer_id is not None:
        transfer_id = server.transfers._request_id(transfer_id)
    root = server.DATA_DIR / "temp" / "folder-exports"
    if transfer_id is None:
        with _EXPORT_LOCK:
            root.mkdir(parents=True, exist_ok=True)
            now = time.time()
            for path in root.glob("*"):
                if path.suffix in {".zip", ".json", ".tmp", ".pending"} and now - path.stat().st_mtime > EXPORT_TTL:
                    path.unlink(missing_ok=True)
            if len(list(root.glob("*.zip"))) + len(list(root.glob("*.pending"))) >= EXPORT_SLOTS:
                raise ValueError("Four folder exports are retained; reuse a transfer or retry after expiry")
            reservation = root / (str(uuid.uuid4()) + ".pending")
            reservation.touch()
        try:
            # Existing transfers remain readable during hashing/compression.
            transfer_id = _create_export(root, folder, server)["transfer_id"]
        finally:
            reservation.unlink(missing_ok=True)
    with storage.read_snapshot(server.DATA_DIR), _EXPORT_LOCK:
        root.mkdir(parents=True, exist_ok=True)
        for path in root.glob("*"):
            if (
                path.suffix in {".zip", ".json", ".tmp"}
                and time.time() - path.stat().st_mtime > EXPORT_TTL
            ):
                path.unlink(missing_ok=True)
        if transfer_id:
            path = root / f"{transfer_id}.json"
            if not path.exists():
                raise ValueError("Folder transfer expired or unknown; restart at offset 0")
            state = json.loads(path.read_text())
            if state["folder"] != folder or state["expires_at"] <= time.time():
                raise ValueError("Folder transfer expired or belongs to another folder")
        else:
            if len(list(root.glob("*.zip"))) >= EXPORT_SLOTS:
                raise ValueError(
                    "Four folder exports are retained; reuse a transfer or retry after expiry"
                )
            state = _create_export(root, folder, server)
        try:
            exports.validate(server.DATA_DIR, state)
        except (FileNotFoundError, ValueError):
            exports._discard(root / f"{state['transfer_id']}.json")
            raise ValueError("An exported file was deleted; restart the folder export") from None
        if on_snapshot:
            on_snapshot([item["document_id"] for item in state["files"]])
        if offset > state["size"]:
            raise ValueError("offset is beyond the archive size")
        with (root / f"{state['transfer_id']}.zip").open("rb") as handle:
            handle.seek(offset)
            content = handle.read(length)
        # The detailed manifest is in the archive-independent receipt on disk, not repeated per range.
        return {k: v for k, v in state.items() if k != "files"} | {
            "filename": _archive_parts(folder.split(" / ")[-1]) + ".zip",
            "mime_type": "application/zip",
            "offset": offset,
            "returned_bytes": len(content),
            "eof": offset + len(content) == state["size"],
            "content_base64": base64.b64encode(content).decode("ascii"),
        }
