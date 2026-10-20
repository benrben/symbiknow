"""Folder transfers: per-file commits and bounded, version-pinned ZIP snapshots."""

from __future__ import annotations

import base64
import json
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path

from symbiknow.organization import edits as organization_edits
from symbiknow.library import storage

MAX_EXPORT_FILES = 1000
MAX_EXPORT_BYTES = 1024**3
EXPORT_TTL = 600
EXPORT_SLOTS = 4
_EXPORT_LOCK = threading.RLock()


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


def upload_folder(folder, files, request_id):
    from symbiknow.core.application import current_application

    server = current_application()

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
    with server.write_lock:
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


def _snapshot(folder):
    from symbiknow.core.application import current_application

    server = current_application()
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


def _create_export(root, folder):
    from symbiknow.core.application import current_application

    server = current_application()

    rows = _snapshot(folder)
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
                with storage.verified_file(server.DATA_DIR, row["document_id"], row["version"]) as (
                    source,
                    _,
                ):
                    with (
                        source.open("rb") as src,
                        archive.open(candidate, "w", force_zip64=True) as dest,
                    ):
                        shutil.copyfileobj(src, dest, length=1024 * 1024)
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
        organization_edits.atomic(root / f"{token}.json", state)
        return state
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise


def download_folder(folder, transfer_id=None, offset=0, length=None):
    from symbiknow.core.application import current_application

    server = current_application()

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
    with _EXPORT_LOCK:
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
            state = _create_export(root, folder)
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
