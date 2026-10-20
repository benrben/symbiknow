"""One upload/download command implementation for HTTP, MCP and folder jobs."""

import base64
import json
import os
import uuid
from typing import Any
from symbiknow.library import storage


class TransferService:
    def __init__(self, context):
        self.context = context

    def _status(self, metadata: dict) -> dict:
        head = storage.current_version(self.context.DATA_DIR, metadata["document_id"])
        result = dict(
            metadata,
            stored=True,
            current_version=head,
            searchable=False,
            indexing_status="superseded"
            if head != metadata["version"]
            else ("disabled" if self.context.STORAGE_ONLY else "pending"),
        )
        indexed = self.context.status_cache.get(metadata["document_id"])
        if (
            head == metadata["version"]
            and not self.context.STORAGE_ONLY
            and indexed
            and indexed.get("version") == head
        ):
            result["indexing_status"] = indexed.get("status", "pending")
            result["searchable"] = (
                indexed.get("indexed_version") == head and indexed.get("status") == "indexed"
            )
            result["searchable_text"] = indexed.get("searchable_text", False)
            result["searchable_visual"] = indexed.get("searchable_visual", False)
            if indexed.get("index_error"):
                result["index_error"] = indexed["index_error"]
        return result

    def _register_metadata(self, metadata):
        from symbiknow.search.index import get_document_status, invalidate_related_organization, register_document

        with self.context.write_lock:
            current = self.context.originals.metadata(metadata["document_id"])
            previous = get_document_status(self.context.DATA_DIR, current["document_id"])
            if previous and previous.get("version") != current["version"]:
                for related_id in invalidate_related_organization(
                    self.context.DATA_DIR, current["document_id"]
                ):
                    self.context.organization_attempts.difference_update(
                        e for e in list(self.context.organization_attempts) if e[0] == related_id
                    )
                    self.context.schedule(related_id)
            return register_document(self.context.DATA_DIR, current, self.context.STORAGE_ONLY)

    def _batch(self, files: list[dict]) -> None:
        if not 1 <= len(files) <= 32:
            raise self.context.transfer_error("Provide between 1 and 32 files per call")

    def _decode(self, value: str) -> bytes:
        if not isinstance(value, str):
            raise ValueError("content_base64 is required: base64 of the file bytes")
        if len(value) > ((self.context.MAX_CHUNK + 2) // 3) * 4:
            raise ValueError(
                "Chunk too large: send at most 256 KiB of raw bytes per item, using "
                "offset/total_size/sha256 and final=true on the last chunk"
            )
        try:
            data = base64.b64decode(value, validate=True)
        except ValueError:
            raise ValueError("content_base64 is not valid base64") from None
        if len(data) > self.context.MAX_CHUNK:
            raise ValueError("Chunk too large")
        return data

    def _request_id(self, value) -> str:
        if value is None:
            return str(uuid.uuid4())
        try:
            return str(uuid.UUID(value))
        except (TypeError, ValueError, AttributeError):
            raise ValueError(
                "request_id must be a UUID (for example from uuid4); reuse it when retrying"
            ) from None

    def _duplicates(self, saved: dict) -> list[dict]:
        """Existing documents a new upload may duplicate. Advisory: never blocks storage."""
        from symbiknow.search.index import possible_duplicates

        rows = possible_duplicates(self.context.DATA_DIR, saved)
        return [
            {
                "code": "possible_duplicate",
                "document_id": row["document_id"],
                "version": row["version"],
                "filename": row["filename"],
                "reason": "identical bytes"
                if row["sha256"] == saved["sha256"]
                else "same filename",
                "message": "A new document was created. To update an existing one instead, "
                "upload with its document_id and expected_version.",
            }
            for row in rows
        ]

    def _save(self, item: dict) -> dict:
        content = self._decode(item.get("content_base64"))
        request_id = self._request_id(item.get("request_id"))
        metadata = {
            key: item.get(key)
            for key in ("filename", "mime_type", "source", "document_id", "expected_version")
        }
        if not isinstance(metadata["filename"], str) or not metadata["filename"]:
            raise ValueError("filename is required")
        if item.get("offset") is None:
            saved = storage.save_file(
                self.context.DATA_DIR, content, request_id=request_id, **metadata
            )
            self._register_metadata(saved)
            self.context.schedule(saved["document_id"])
            return self._status(saved)
        offset = item["offset"]
        total = item.get("total_size")
        digest = item.get("sha256") or ""
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError("offset must be a nonnegative integer")
        if (
            not isinstance(total, int)
            or isinstance(total, bool)
            or not 0 <= total <= self.context.MAX_FILE
        ):
            raise ValueError("total_size is required and must fit the file limit")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("A lowercase whole-file SHA-256 is required for chunks")
        if offset + len(content) > total or (not content and total != 0):
            raise ValueError("Chunk exceeds total_size or makes no progress")
        identity = dict(metadata, request_id=request_id, total_size=total, sha256=digest)
        incoming = self.context.DATA_DIR / "temp"
        incoming.mkdir(parents=True, exist_ok=True)
        manifest = incoming / f"{request_id}.json"
        part = incoming / f"{request_id}.part"
        if manifest.exists():
            state = json.loads(manifest.read_text())
            if state["identity"] != identity:
                raise ValueError("request_id reused with different upload metadata")
            if state.get("result"):
                saved = state["result"]
                # A receipt binds the retry to the committed bytes, not just the
                # caller's claimed digest. Pin the receipt's version after updates.
                with self.context.originals.verified_file(
                    saved["document_id"], saved["version"]
                ) as (
                    path,
                    _,
                ):
                    with path.open("rb") as handle:
                        handle.seek(offset)
                        if handle.read(len(content)) != content:
                            raise ValueError("Retry chunk differs from already received bytes")
                return self._status(saved)
        else:
            state = {"identity": identity}
            temporary = manifest.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(state))
            temporary.replace(manifest)
        existing = part.stat().st_size if part.exists() else 0
        if offset > existing:
            raise ValueError(f"Upload requires next offset {existing}")
        with part.open("r+b" if part.exists() else "w+b") as handle:
            if offset < existing:
                handle.seek(offset)
                if handle.read(len(content)) != content:
                    raise ValueError("Retry chunk differs from already received bytes")
            else:
                handle.seek(offset)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        received = part.stat().st_size
        if not item.get("final", False):
            return {
                "request_id": request_id,
                "stored": False,
                "searchable": False,
                "indexing_status": "receiving",
                "received_bytes": received,
            }
        if received != total:
            raise ValueError(f"Final chunk requires {total} bytes; received {received}")
        if storage._digest_path(part) != digest:
            raise ValueError("Whole-file SHA-256 mismatch")
        saved = self.context.originals.commit(part, request_id=request_id, **metadata)
        self._register_metadata(saved)
        state["result"] = saved
        temporary = manifest.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state))
        temporary.replace(manifest)
        part.unlink()
        self.context.schedule(saved["document_id"])
        return self._status(saved)

    def _not_found(self, document_id, version=None) -> str:
        if version:
            return (
                f"Document {document_id!r} has no version {version!r}, or does not exist. "
                "Request it with history=true and no version to list its versions."
            )
        return (
            f"No document with document_id {document_id!r}: it was deleted or never uploaded. "
            "Find current IDs with search."
        )

    def upload(self, files: list[dict]) -> dict[str, Any]:
        """Store 1-32 files. Without document_id each item creates a new document; with
        document_id + expected_version it adds a version. Each item gets its own result."""
        self._batch(files)
        results = []
        for index, item in enumerate(files):
            try:
                with self.context.write_lock:
                    result = self._save(item)
                if result.get("stored") and not item.get("document_id"):
                    if warnings := self._duplicates(result):
                        result["warnings"] = warnings
                results.append(dict(result, index=index))
            except Exception as exc:
                failure = {
                    "index": index,
                    "stored": False,
                    "searchable": False,
                    "request_id": item.get("request_id"),
                    "filename": item.get("filename"),
                    "error": self._not_found(item.get("document_id"))
                    if isinstance(exc, FileNotFoundError)
                    else str(exc),
                }
                if item.get("document_id"):
                    failure["document_id"] = item["document_id"]
                    if isinstance(exc, storage.VersionConflict) and str(exc).startswith("Expected"):
                        try:
                            head = storage.current_version(
                                self.context.DATA_DIR, item["document_id"]
                            )
                        except (ValueError, storage.StorageError):
                            head = None
                        if head:
                            failure["current_version"] = head
                            failure["hint"] = (
                                f"Download {head}, reconcile your change, and retry with "
                                f"expected_version={head!r} and a new request_id."
                            )
                results.append(failure)
        return {"files": results}

    def download(self, files: list[dict]) -> dict[str, Any]:
        """Read 1-32 original files or byte ranges (base64, at most 256 KiB each). Pin the
        returned version for later ranges and verify the whole-file sha256."""
        self._batch(files)
        results = []
        for item in files:
            try:
                offset = 0 if item.get("offset") is None else item["offset"]
                length = self.context.MAX_CHUNK if item.get("length") is None else item["length"]
                if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                    raise ValueError("offset must be a nonnegative integer")
                if (
                    not isinstance(length, int)
                    or isinstance(length, bool)
                    or not 1 <= length <= self.context.MAX_CHUNK
                ):
                    raise ValueError(
                        f"length must be between 1 and {self.context.MAX_CHUNK}; read larger files in ranges"
                    )
                with self.context.originals.verified_file(
                    item["document_id"], item.get("version")
                ) as (
                    path,
                    metadata,
                ):
                    if offset > metadata["size"]:
                        raise ValueError("offset exceeds file size")
                    with path.open("rb") as source_file:
                        source_file.seek(offset)
                        chunk = source_file.read(length)
                result = dict(
                    self._status(metadata),
                    content_base64=base64.b64encode(chunk).decode("ascii"),
                    offset=offset,
                    returned_bytes=len(chunk),
                    eof=offset + len(chunk) == metadata["size"],
                )
                if item.get("include_versions") or item.get("history"):
                    page = self.context.originals.history_page(
                        item["document_id"], offset=0 if item.get("history_offset") is None else item["history_offset"],
                        limit=30 if item.get("history_limit") is None else item["history_limit"], head=item.get("history_head"))
                    result["versions"] = sorted(page.pop("versions"), key=lambda value: int(value["version"][1:]))
                    result["versions_page"] = page
                results.append(result)
            except FileNotFoundError:
                results.append(
                    {
                        "document_id": item.get("document_id"),
                        "error": self._not_found(item.get("document_id"), item.get("version")),
                    }
                )
            except Exception as exc:
                results.append({"document_id": item.get("document_id"), "error": str(exc)})
        return {"files": results}
