"""Loopback UI and HTTP MCP, one SDK application lifespan/storage owner."""

from __future__ import annotations

import json
import uuid
from io import BytesIO
import tempfile
import zipfile
import shutil
import threading
import time
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote, urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from app import server, storage
from app.organization import clean_text, representative_evidence
from app.relationships import unique_relationships
from app.search import (
    INDEX_LOCK,
    _literal,
    _table,
    browse_documents,
    document_evidence,
    get_document_status,
    revisions,
)

BUILD = Path(__file__).resolve().parents[1] / "frontend" / "dist"


def public(row):
    if row is None:
        raise FileNotFoundError("Document not found")
    return {
        k: v
        for k, v in row.items()
        if k not in ("source", "links_json", "organization_json", "request_id", "index_error")
    }


def connections(doc_id, version, deduplicate=True):
    """Bounded outgoing/incoming relations; details fetched on selection."""
    with server.write_lock, storage.read_snapshot(server.DATA_DIR), INDEX_LOCK:
        metadata_cache = {}

        def metadata(identity):
            if identity not in metadata_cache:
                try:
                    metadata_cache[identity] = storage.read_metadata(server.DATA_DIR, identity)
                except FileNotFoundError:
                    metadata_cache[identity] = {}
            return metadata_cache[identity]

        if metadata(doc_id).get("version") != version:
            return []
        table = _table(server.DATA_DIR, "documents")
        if table is None:
            return []
        pattern = "%" + json.dumps(doc_id) + "%"
        rows = (
            table.search()
            .where(f"document_id = {_literal(doc_id)} OR links_json LIKE {_literal(pattern)}")
            .limit(100)
            .to_list()
        )
        result = []
        for row in rows:
            if metadata(row["document_id"]).get("version") != row["version"]:
                continue
            for link in json.loads(row["links_json"]):
                target = link.get("document_id")
                if row["document_id"] != doc_id and target != doc_id:
                    continue
                if link.get("source_version") != row["version"] or metadata(target).get(
                    "version"
                ) != link.get("version"):
                    continue
                result.append(
                    {
                        **link,
                        "source_document_id": row["document_id"],
                        "source_filename": row["filename"],
                        "target_filename": metadata(target)["filename"],
                    }
                )
        return (unique_relationships(result) if deduplicate else result)[:100]


def library(params):
    with server.write_lock, INDEX_LOCK:
        return _library(params)


def _library(params):
    offset, limit = int(params.get("offset", 0)), int(params.get("limit", 60))
    if offset < 0 or not 1 <= limit <= 100:
        raise ValueError("Use a nonnegative offset and limit 1–100")
    result = browse_documents(
        server.DATA_DIR,
        offset,
        limit,
        params.get("folder"),
        params.get("group"),
        params.get("recent") == "true",
        params.get("sort", "filename"),
        params.get("descending") == "true",
    )
    result["documents"] = [public(r) for r in result["documents"]]
    result.update(
        _aggregates(
            str(server.DATA_DIR),
            json.dumps(revisions(server.DATA_DIR), sort_keys=True),
            _manual_revision(),
            params.get("folder"),
            params.get("group"),
        )
    )
    result.update(
        processing=server.processing.is_set(),
        max_file_bytes=server.MAX_FILE,
        max_chunk_bytes=server.MAX_CHUNK,
    )
    result.update(progress())
    return result


def _manual_revision():
    from .organization_edits import summary

    return summary(server.DATA_DIR).get("revision", "")


@lru_cache(maxsize=16)
def _aggregates(data_dir, revision, manual_revision, selected_folder, selected_group):
    from app.organization_edits import assignment_ids

    manual_ids = assignment_ids(data_dir)
    result = {}
    unfiled_review_count = 0
    with INDEX_LOCK:
        table = _table(server.DATA_DIR, "documents")
        counts, groups, scoped, states = {}, set(), {}, {}
        if table is not None:
            # Metadata aggregation, never an OCFL scan or graph payload.
            for batch in (
                table.search()
                .select(["document_id", "folder", "groups", "status", "organization_status"])
                .limit(max(1, table.count_rows()))
                .to_batches()
            ):
                for row in batch.to_pylist():
                    if not row["folder"] and row["document_id"] not in manual_ids:
                        unfiled_review_count += 1
                    states[row["status"]] = states.get(row["status"], 0) + 1
                    if "failed" in row["organization_status"]:
                        states["organization_failed"] = states.get("organization_failed", 0) + 1
                    if (
                        row["organization_status"] in {"pending", "reset_pending"}
                        and row["status"] == "indexed"
                    ):
                        states["organization_pending"] = states.get("organization_pending", 0) + 1
                    counts[row["folder"]] = counts.get(row["folder"], 0) + 1
                    groups.update(row["groups"])
                    in_folder = (
                        selected_folder is None
                        or row["folder"] == selected_folder
                        or (
                            bool(selected_folder)
                            and row["folder"].startswith(selected_folder + " / ")
                        )
                    )
                    if in_folder and (selected_group is None or selected_group in row["groups"]):
                        scoped[row["folder"]] = scoped.get(row["folder"], 0) + 1
        result.update(
            folders=counts,
            scoped_folders=scoped,
            groups=sorted(groups),
            processing=server.processing.is_set(),
            processing_states=states,
            library_total=sum(counts.values()),
            unfiled_review_count=unfiled_review_count,
            max_file_bytes=server.MAX_FILE,
            max_chunk_bytes=server.MAX_CHUNK,
        )
    return result


def progress():
    result = {"processing": server.processing.is_set()}
    from app.rebuild import progress as rebuild_progress

    with INDEX_LOCK:
        derived = revisions(server.DATA_DIR)
    result["index_revision"] = derived["index"]
    manual_revision = server.DATA_DIR / "temp" / "organization-revision.txt"
    job = rebuild_progress() or {}
    result["organization_reset"] = {
        "revision": job.get("layout_revision", ""),
        "scope": job.get("layout_scope"),
    }
    result["organization_revision"] = (
        derived["organization"]
        + job.get("layout_revision", "")
        + (manual_revision.read_text() if manual_revision.exists() else "")
    )
    from app.organization_edits import summary, atomic

    ledger = summary(server.DATA_DIR)
    result["organization_revision"] += ledger.get("revision", "")
    result["manual_revision"] = ledger.get("revision", "")
    result["organization_change"] = ledger.get("change")
    identity_path = server.DATA_DIR / "temp" / "library-identity.json"
    with server.write_lock:
        if not identity_path.exists():
            atomic(identity_path, {"schema": 1, "id": str(uuid.uuid4())})
        result["library_id"] = json.loads(identity_path.read_text())["id"]
    result["revision"] = [derived["index"], result["organization_revision"]]
    result["rebuild_progress"] = job or None
    return result


def delete_item(action, args):
    from app.rebuild import status
    from app.search import folder_condition, remove_document

    with server.write_lock, INDEX_LOCK:
        state = status()
        if state and state["status"] in ("queued", "running"):
            raise ValueError("Wait for the organization rebuild to finish before deleting")
        if action == "delete-document":
            identity = args["document_id"]
            storage.delete_document(server.DATA_DIR, identity, args["expected_version"])
            remove_document(server.DATA_DIR, identity)
            server.status_cache.pop(identity, None)
            server.retry_ids.discard(identity)
            server.organization_attempts.difference_update(
                entry for entry in list(server.organization_attempts) if entry[0] == identity
            )
            for path in (server.DATA_DIR / "temp" / "thumbnails").glob(f"{identity}-*.jpg"):
                path.unlink(missing_ok=True)
                path.with_suffix(".json").unlink(missing_ok=True)
            result = {"deleted": identity}
            from app.organization_edits import clear

            clear(server.DATA_DIR, [identity])
        else:
            folder = args["folder"]
            if not isinstance(folder, str) or not folder:
                raise ValueError("Choose a named folder to delete")
            table = _table(server.DATA_DIR, "documents")
            rows = (
                table.search()
                .where(folder_condition(folder))
                .limit(max(1, table.count_rows()))
                .to_list()
                if table
                else []
            )
            if not rows:
                raise FileNotFoundError("Folder not found")
            from app.organization_edits import edit

            edit("remove-folder", {"folder": folder})
            result = {"deleted_folder": folder, "moved_to_unfiled": len(rows)}
        revision = server.DATA_DIR / "temp" / "organization-revision.txt"
        revision.parent.mkdir(parents=True, exist_ok=True)
        temporary = revision.with_suffix(".tmp")
        temporary.write_text(str(uuid.uuid4()))
        temporary.replace(revision)
        return result


def detail(doc_id, version=None, section="full"):
    metadata = storage.read_metadata(server.DATA_DIR, doc_id, version)
    row = get_document_status(server.DATA_DIR, doc_id)
    current = storage.current_version(server.DATA_DIR, doc_id)
    return {
        "document": public(metadata),
        "current_version": current,
        "indexing_error": row.get("index_error", "")[:1000]
        if row and metadata["version"] == current
        else "",
        "organization": public(row) if row and metadata["version"] == current else None,
        "organization_review": {
            key: value
            for key, value in json.loads(row["organization_json"]).items()
            if key
            in {
                "project_scope",
                "canonical_project",
                "ownership",
                "organization_reason",
                "folder_confidence",
                "folder_probabilities",
                "prompt_version",
                "folder_candidates",
                "link_evaluations",
                "origin",
                "basis",
                "folder",
                "groups",
                "evidence_ids",
            }
        }
        if section != "summary" and row and metadata["version"] == current
        else None,
        "evidence": document_evidence(server.DATA_DIR, doc_id, metadata["version"])
        if section != "summary" and metadata["version"] == current
        else [],
        "connections": connections(doc_id, metadata["version"])[
            : 5 if section == "summary" else 100
        ],
        "versions": [public(v) for v in storage.list_versions(server.DATA_DIR, doc_id)]
        if section == "full"
        else [public(metadata)],
    }


def link_evidence(doc_id, version, target, target_version, source_chunk, target_chunk):
    with server.write_lock, INDEX_LOCK:
        return _link_evidence(doc_id, version, target, target_version, source_chunk, target_chunk)


def _link_evidence(doc_id, version, target, target_version, source_chunk, target_chunk):
    valid = next(
        (
            link
            for link in connections(doc_id, version, deduplicate=False)
            if link["source_document_id"] == doc_id
            and link["document_id"] == target
            and link["version"] == target_version
            and link.get("source_chunk_id") == source_chunk
            and link.get("target_chunk_id") == target_chunk
        ),
        None,
    )
    if valid is None:
        raise ValueError("This relationship is no longer current")

    def passage(document_id, pinned, chunk_id):
        with INDEX_LOCK:
            table = _table(server.DATA_DIR, "chunks")
            rows = (
                table.search()
                .where(
                    f"document_id = {_literal(document_id)} AND version = {_literal(pinned)} AND chunk_id = {_literal(chunk_id)} AND active = true"
                )
                .select(["chunk_id", "text", "basis", "provenance_json"])
                .limit(1)
                .to_list()
                if table is not None
                else []
            )
            return [
                {
                    "evidence_id": r["chunk_id"],
                    "text": r["text"],
                    "basis": r["basis"],
                    "provenance": json.loads(r["provenance_json"]),
                }
                for r in rows
            ]

    source = passage(doc_id, version, source_chunk)
    target_rows = passage(target, target_version, target_chunk)
    return {"link": valid, "source": source, "target": target_rows}


def thumbnail(doc_id, version):
    from .previews import JOBS

    return JOBS.run(
        (str(server.DATA_DIR), "thumbnail", doc_id, version), _thumbnail, doc_id, version
    )


def _cached_preview(path, doc_id, version, *, page=False):
    """Copy a bounded preview while holding the same lock as eviction/deletion."""
    with server.write_lock:
        info_path = path.with_suffix(".json")
        if not path.exists() or (page and not info_path.exists()):
            return None
        storage.read_metadata(server.DATA_DIR, doc_id, version)
        headers = {
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        }
        if page:
            headers["X-PDF-Page-Count"] = str(json.loads(info_path.read_text())["pages"])
        content = path.read_bytes()
        from .previews import prune

        prune(path.parent, path)
        return Response(content, media_type="image/jpeg", headers=headers)


def _thumbnail(doc_id, version):
    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("Thumbnail must pin a version")
    path = server.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}.jpg"
    cached = _cached_preview(path, doc_id, version)
    if cached is not None:
        return cached
    from PIL import Image

    metadata = storage.read_metadata(server.DATA_DIR, doc_id, version)
    if metadata["mime_type"] == "application/pdf" and metadata["size"] > 32 * 1024**2:
        raise ValueError("PDF is too large for a thumbnail; open or download the original")
    with storage.verified_file(server.DATA_DIR, doc_id, version) as (source_path, metadata):
        if metadata["mime_type"] == "application/pdf":
            import subprocess
            import sys

            try:
                content = subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("pdf_thumbnail.py")),
                        str(source_path),
                    ],
                    check=True,
                    timeout=20,
                    capture_output=True,
                ).stdout
            except (subprocess.SubprocessError, OSError):
                raise ValueError(
                    "PDF thumbnail unavailable; open or download the original"
                ) from None
            source_input = BytesIO(content)
        else:
            source_input = source_path
        with Image.open(source_input) as source:
            source.thumbnail((264, 340))
            output = BytesIO()
            rgb = source.convert("RGB")
            try:
                rgb.save(output, format="JPEG", quality=85)
            finally:
                rgb.close()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with server.write_lock:
        if storage.current_version(server.DATA_DIR, doc_id) is None:
            raise FileNotFoundError("Document deleted during preview")
        temporary.write_bytes(output.getvalue())
        temporary.replace(path)
        return _cached_preview(path, doc_id, version)


def pdf_page(doc_id, version, page_number):
    from .previews import JOBS

    return JOBS.run(
        (str(server.DATA_DIR), "page", doc_id, version, str(page_number)),
        _pdf_page,
        doc_id,
        version,
        page_number,
    )


def _pdf_page(doc_id, version, page_number):
    """Reader-sized page image; originals and the first-page card cache stay separate."""
    import subprocess
    import sys

    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("PDF preview must pin a version")
    page_number = int(page_number)
    if not 1 <= page_number <= 10000:
        raise ValueError("PDF page is out of range")
    path = server.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}-page-{page_number}.jpg"
    info_path = path.with_suffix(".json")
    cached = _cached_preview(path, doc_id, version, page=True)
    if cached is not None:
        return cached
    metadata = storage.read_metadata(server.DATA_DIR, doc_id, version)
    if metadata["mime_type"] != "application/pdf":
        raise ValueError("Page preview requires a PDF")
    if metadata.get("size", 0) > 32 * 1024 * 1024:
        raise ValueError("PDF is too large for an inline preview; open or download the original")
    with storage.verified_file(server.DATA_DIR, doc_id, version) as (input_path, _):
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("pdf_thumbnail.py")),
                    str(input_path),
                    str(page_number),
                    "1400",
                ],
                check=True,
                timeout=20,
                capture_output=True,
            )
            page_count = int(result.stderr.decode().rsplit("pages:", 1)[1].strip())
        except (subprocess.SubprocessError, OSError, ValueError, IndexError):
            raise ValueError(
                "PDF page unavailable or out of range; open the original"
            ) from None
    with server.write_lock:
        if storage.current_version(server.DATA_DIR, doc_id) is None:
            raise FileNotFoundError("Document deleted during preview")
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_suffix(".tmp")
        staging.write_bytes(result.stdout)
        staging.replace(path)
        info_staging = info_path.with_suffix(".json.tmp")
        info_staging.write_text(json.dumps({"pages": page_count}))
        info_staging.replace(info_path)
        return _cached_preview(path, doc_id, version, page=True)


def card(doc_id, version):
    from app.rebuild import common_context

    common = common_context()
    evidence = (
        representative_evidence(document_evidence(server.DATA_DIR, doc_id, version), common)
        if storage.current_version(server.DATA_DIR, doc_id) == version
        else []
    )
    # Fixed text budget, no original bodies or PDF embeds on browse cards.
    result = {"evidence": [{**row, "text": row["text"][:1600]} for row in evidence[:2]]}
    metadata = storage.read_metadata(server.DATA_DIR, doc_id, version)
    if metadata["filename"].lower().endswith(".csv") and metadata.get("size", 0) <= 2 * 1024 * 1024:
        import csv
        from itertools import islice
        from io import StringIO

        content, _ = storage.read_file(server.DATA_DIR, doc_id, version)
        # Bound both the parser input and the returned cells. Never interpret formulas.
        sample = content[: 64 * 1024].decode("utf-8-sig", errors="replace")
        try:
            result["table"] = [
                [cell[:160] for cell in row[:6]] for row in islice(csv.reader(StringIO(sample)), 9)
            ]
        except csv.Error:
            pass  # Extracted text and original download remain available.
    return result


_EXPORT_LOCK = threading.RLock()
_EXPORTS = {}
_EXPORT_SLOTS = threading.BoundedSemaphore(2)


def bulk_download(args):
    if not _EXPORT_SLOTS.acquire(blocking=False):
        raise ValueError("Two ZIP exports are already being prepared; retry shortly")
    try:
        return _bulk_download(args)
    finally:
        _EXPORT_SLOTS.release()


def _expire_export(token):
    with _EXPORT_LOCK:
        item = _EXPORTS.pop(token, None)
    if item:
        item[0].unlink(missing_ok=True)


def _bulk_download(args):
    items = args.get("documents", [])
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("Select 1–100 loaded files to download")
    # Validate the entire explicit selection before sending a successful ZIP.
    metadata, failures = [], []
    for item in items:
        try:
            metadata.append(
                storage.read_metadata(server.DATA_DIR, item["document_id"], item["version"])
            )
        except (FileNotFoundError, ValueError, KeyError):
            failures.append(
                {
                    "document_id": item.get("document_id"),
                    "version": item.get("version"),
                    "error": "Selected version is unavailable",
                }
            )
    if failures:
        return JSONResponse(
            {
                "error": "Download stopped: some selected versions are unavailable.",
                "failures": failures,
            },
            status_code=400,
        )
    if sum(row.get("size", 0) for row in metadata) > 1024**3:
        raise ValueError("Bulk download is limited to 1 GiB; download smaller selections")
    export_root = server.DATA_DIR / "temp" / "exports"
    export_root.mkdir(parents=True, exist_ok=True)
    for old in export_root.glob("*.zip"):
        if time.time() - old.stat().st_mtime > 600:
            old.unlink(missing_ok=True)
    handle = tempfile.NamedTemporaryFile(suffix=".zip", dir=export_root, delete=False)
    destination = Path(handle.name)
    handle.close()
    try:
        names = set()
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
            for row in metadata:
                name = row["filename"].replace("\\", "/").split("/")[-1]
                name = "".join(c for c in name if ord(c) >= 32) or "document"
                if name in {".", ".."}:
                    name = "document"
                base, suffix = Path(name).stem, Path(name).suffix
                count = 1
                while name.casefold() in names:
                    count += 1
                    name = f"{base} ({count}){suffix}"
                names.add(name.casefold())
                with storage.verified_file(server.DATA_DIR, row["document_id"], row["version"]) as (
                    source_path,
                    _,
                ):
                    with (
                        source_path.open("rb") as source_file,
                        archive.open(name, "w", force_zip64=True) as target,
                    ):
                        shutil.copyfileobj(source_file, target, length=1024 * 1024)
        if args.get("prepare"):
            token = str(uuid.uuid4())
            with _EXPORT_LOCK:
                for key, (old_path, expires, timer) in list(_EXPORTS.items()):
                    if expires < time.time():
                        timer.cancel()
                        old_path.unlink(missing_ok=True)
                        _EXPORTS.pop(key)
                while len(_EXPORTS) >= 4:
                    key = next(iter(_EXPORTS))
                    old_path, _, timer = _EXPORTS.pop(key)
                    timer.cancel()
                    old_path.unlink(missing_ok=True)
                timer = threading.Timer(300, _expire_export, args=(token,))
                timer.daemon = True
                _EXPORTS[token] = (destination, time.time() + 300, timer)
                timer.start()
            return JSONResponse({"url": "/api/export?token=" + token, "expires_in": 300})
        return FileResponse(
            destination,
            media_type="application/zip",
            filename="Symbiknow files.zip",
            headers={
                "X-Symbiknow-File-Count": str(len(metadata)),
                "X-Content-Type-Options": "nosniff",
            },
            background=BackgroundTask(destination.unlink, missing_ok=True),
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise


class LeasedFileResponse(FileResponse):
    """FileResponse range support, with release even on a disconnected client."""

    def __init__(self, *args, lease, **kwargs):
        super().__init__(*args, **kwargs)
        self.lease = lease

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.lease.__exit__(None, None, None)


def original(doc_id, version, preview=False):
    lease = storage.verified_file(server.DATA_DIR, doc_id, version)
    path, metadata = lease.__enter__()
    mime = metadata["mime_type"].split(";")[0]
    # Active content (including SVG/HTML) is always attachment; frontend renders
    # HTML only inside an opaque sandbox with a restrictive CSP.
    safe_inline = mime in (
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
    )
    disposition = "inline" if preview and safe_inline else "attachment"
    return LeasedFileResponse(
        path,
        lease=lease,
        media_type=mime if safe_inline else "application/octet-stream",
        headers={
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(Path(metadata['filename']).name)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Length": str(metadata["size"]),
        },
    )


async def api(request: Request):
    try:
        action = request.path_params["action"]
        p = request.query_params
        if request.method == "GET":
            if action == "runtime":
                import os
                from app.embeddings import get_embedder, runtime_name

                return JSONResponse(
                    {
                        "pid": os.getpid(),
                        "runtime": runtime_name(),
                        "model": await run_in_threadpool(get_embedder().stats),
                        "accounting": "GPU allocator values overlap process physical footprint; do not add them.",
                    }
                )
            if action == "export":
                with _EXPORT_LOCK:
                    item = _EXPORTS.pop(p.get("token", ""), None)
                if item is None:
                    raise FileNotFoundError()
                destination, expires, timer = item
                timer.cancel()
                if expires < time.time():
                    destination.unlink(missing_ok=True)
                    raise FileNotFoundError()
                return FileResponse(
                    destination,
                    media_type="application/zip",
                    filename="Symbiknow files.zip",
                    background=BackgroundTask(destination.unlink, missing_ok=True),
                )
            if action == "progress":
                return JSONResponse(await run_in_threadpool(progress))
            if action == "library":
                return JSONResponse(await run_in_threadpool(library, p))
            if action == "history":
                result = await run_in_threadpool(
                    storage.version_page,
                    server.DATA_DIR,
                    p["id"],
                    int(p.get("offset", 0)),
                    int(p.get("limit", 30)),
                    p.get("head"),
                )
                result["versions"] = [public(v) for v in result["versions"]]
                return JSONResponse(result)
            if action == "document":
                return JSONResponse(
                    await run_in_threadpool(
                        detail, p["id"], p.get("version"), p.get("section", "full")
                    )
                )
            if action == "card":
                return JSONResponse(await run_in_threadpool(card, p["id"], p["version"]))
            if action in ("download", "original"):
                return await run_in_threadpool(
                    original, p["id"], p.get("version"), action == "original"
                )
            if action == "thumbnail":
                from .previews import JOBS

                return await JOBS.wait(
                    (str(server.DATA_DIR), "thumbnail", p["id"], p["version"]),
                    _thumbnail,
                    p["id"],
                    p["version"],
                )
            if action == "pdf-page":
                from .previews import JOBS

                return await JOBS.wait(
                    (str(server.DATA_DIR), "page", p["id"], p["version"], p.get("page", "1")),
                    _pdf_page,
                    p["id"],
                    p["version"],
                    p.get("page", "1"),
                )
            if action == "link":
                return JSONResponse(
                    await run_in_threadpool(
                        link_evidence,
                        p["id"],
                        p["version"],
                        p["target"],
                        p["target_version"],
                        p["source_chunk"],
                        p["target_chunk"],
                    )
                )
            if action == "neighborhood":
                links = await run_in_threadpool(connections, p["id"], p["version"])
                ids = list(
                    dict.fromkeys(
                        [
                            p["id"],
                            *[link["source_document_id"] for link in links],
                            *[link["document_id"] for link in links],
                        ]
                    )
                )[:100]
                rows = await run_in_threadpool(
                    lambda: [public(get_document_status(server.DATA_DIR, i)) for i in ids]
                )
                return JSONResponse({"documents": rows, "links": links[:100]})
            if action == "rebuild":
                from app.rebuild import progress as rebuild_progress

                state = await run_in_threadpool(rebuild_progress)
                return JSONResponse(state)
        else:
            # Enforce a small, streamed body cap before JSON parsing.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 2 * 1024 * 1024:
                    return JSONResponse(
                        {"error": "Request too large; use chunked upload"}, status_code=413
                    )
            args = json.loads(body)
            if action == "bulk-download":
                return await run_in_threadpool(bulk_download, args)
            if action in ("delete-document", "delete-folder"):
                return JSONResponse(await run_in_threadpool(delete_item, action, args))
            if action in ("rename-folder", "move-folder", "move-documents"):
                from app.organization_edits import edit

                return JSONResponse(await run_in_threadpool(edit, action, args))
            if action == "statuses":
                from .search import document_statuses

                ids = args.get("document_ids", [])
                if not isinstance(ids, list) or len(ids) > 128:
                    raise ValueError("Use at most 128 IDs")
                rows = await run_in_threadpool(
                    document_statuses,
                    server.DATA_DIR,
                    ids,
                    ["document_id", "version", "status", "searchable_text", "searchable_visual"],
                )
                return JSONResponse({"documents": {k: public(v) for k, v in rows.items()}})
            if action == "retry-index":
                from .retry import clear

                with server.write_lock:
                    metadata = storage.read_metadata(server.DATA_DIR, args["document_id"])
                    if metadata["version"] != args["expected_version"]:
                        raise ValueError("File changed; refresh before retrying")
                    clear(server.DATA_DIR, args["document_id"])
                    server._schedule(args["document_id"])
                return JSONResponse({"queued": True})
            if action == "upload":
                result = await run_in_threadpool(server.upload, args["files"])
                result["files"] = [
                    {k: v for k, v in r.items() if k not in ("source", "index_error")}
                    for r in result["files"]
                ]
                return JSONResponse(result)
            if action == "search":
                result = await run_in_threadpool(server.search, **dict(args, detail="full"))
                for match in result["matches"]:
                    match.pop("source", None)
                    passages = [r for r in match.get("evidence", []) if r.get("text")]
                    supports = match.get("jev", {}).get("supporting_chunk_ids", [])
                    chosen = next((r for r in passages if r.get("evidence_id") in supports), None)
                    match["excerpt"] = clean_text(
                        (chosen or (passages[0] if passages else {})).get("text", "")
                    )
                return JSONResponse(result)
            if action == "rebuild":
                from app.rebuild import request as rebuild

                return JSONResponse(rebuild_public(await run_in_threadpool(rebuild, **args)))
        return JSONResponse({"error": "Unknown action"}, status_code=404)
    except (FileNotFoundError, KeyError):
        return JSONResponse({"error": "Document or requested data not found"}, status_code=404)
    except (ValueError, TypeError) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception:
        server.log.exception("UI request failed")
        return JSONResponse(
            {"error": "Request failed. Your stored files remain available; retry this action."},
            status_code=503,
        )


def rebuild_public(state):
    if state is None:
        return None
    details = []
    unresolved = {
        identity: result["reason"]
        for identity, result in state.get("outcomes", {}).items()
        if result["outcome"] == "unfiled"
    }
    for outcome, entries in (
        ("failed", state["failures"]),
        ("skipped", state.get("skips", {})),
        ("unfiled", unresolved),
    ):
        for identity, reason in entries.items():
            row = get_document_status(server.DATA_DIR, identity)
            details.append(
                {
                    "document_id": identity,
                    "filename": row["filename"] if row else identity,
                    "outcome": outcome,
                    "reason": reason,
                }
            )
    return {
        k: v
        for k, v in state.items()
        if k
        not in (
            "document_ids",
            "completed_ids",
            "vocabulary",
            "common_lines",
            "taxonomy_ready",
            "candidate_folders",
            "cleared_ids",
            "outcomes",
            "work_ids",
            "cursor",
        )
    } | {
        "completed": len(state["completed_ids"]),
        "failed": len(state["failures"]),
        "skipped": len(state.get("skips", {})),
        "details": details,
        **(
            {
                "grouped": sum(r["outcome"] == "grouped" for r in state["outcomes"].values()),
                "unfiled": len(unresolved),
                "links_added": sum(r["links_added"] for r in state["outcomes"].values()),
            }
            if "outcomes" in state
            else {}
        ),
    }


class LocalProtection:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            host = headers.get(b"host", b"").decode()
            parsed = urlsplit("http://" + host)
            origin = headers.get(b"origin", b"").decode()
            allowed = parsed.hostname in ("localhost", "127.0.0.1", "::1")
            if origin and origin != "http://" + host:
                allowed = False
            if scope["path"].startswith("/api/") and scope["method"] not in ("GET", "HEAD"):
                allowed = (
                    allowed
                    and origin == "http://" + host
                    and headers.get(b"x-symbiknow-ui") == b"1"
                )
            if not allowed:
                await JSONResponse({"error": "Local same-origin access required"}, status_code=403)(
                    scope, receive, send
                )
                return
        await self.app(scope, receive, send)


def create_app():
    # SDK 2.3 enters server.lifespan once in its HTTP manager, sharing it across
    # all MCP sessions and the browser. Mounting a separate owner is unnecessary.
    app = server.mcp.streamable_http_app()
    app.router.routes.append(Route("/api/{action}", api, methods=["GET", "POST"]))
    if BUILD.exists():
        app.router.routes.append(Mount("/", app=StaticFiles(directory=BUILD, html=True)))
    app.add_middleware(LocalProtection)
    return app
