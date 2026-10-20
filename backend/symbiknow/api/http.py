"""Loopback UI and HTTP MCP, one SDK application lifespan/storage owner."""

from __future__ import annotations

from symbiknow.core.paths import REPO_ROOT

import json
import uuid
from io import BytesIO
import tempfile
import zipfile
import shutil
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.organization.policy import clean_text
from symbiknow.library.service import public
from symbiknow.search.index import get_document_status

BUILD = REPO_ROOT / "frontend" / "dist"


def connections(doc_id, version, deduplicate=True):
    return server.application().library.connections(doc_id, version, deduplicate)


def library(params):
    return server.application().library.library(params).to_wire()


def progress():
    return server.application().library.progress()


def delete_item(action, args):
    return server.application().library.delete_item(action, args)


def detail(doc_id, version=None, section="full"):
    return server.application().library.detail(doc_id, version, section).to_wire()


def link_evidence(doc_id, version, target, target_version, source_chunk, target_chunk):
    with server.application().snapshots.read():
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
        from symbiknow.search.index import resolve_evidence

        row = resolve_evidence(server.DATA_DIR, document_id, pinned, chunk_id)
        return [row] if row else []

    source = passage(doc_id, version, source_chunk)
    target_rows = passage(target, target_version, target_chunk)
    return {"link": valid, "source": source, "target": target_rows}


def thumbnail(doc_id, version):
    from symbiknow.previews.service import JOBS, RENDERER_REVISION
    from symbiknow.core.cache import dependency_key

    return JOBS.run(
        dependency_key("preview", library=str(server.DATA_DIR.resolve()), kind="thumbnail",
                       document=doc_id, version=version, renderer=RENDERER_REVISION),
        _thumbnail, doc_id, version
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
        from symbiknow.previews.service import prune

        prune(path.parent, path)
        return Response(content, media_type="image/jpeg", headers=headers)


def _thumbnail(doc_id, version):
    from symbiknow.previews.service import RENDERER_REVISION
    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("Thumbnail must pin a version")
    path = server.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}-{RENDERER_REVISION}.jpg"
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
                        str(Path(__file__).resolve().parents[1] / "previews/pdf.py"),
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
    from symbiknow.previews.service import JOBS, RENDERER_REVISION
    from symbiknow.core.cache import dependency_key

    return JOBS.run(
        dependency_key("preview", library=str(server.DATA_DIR.resolve()), kind="pdf-page",
                       document=doc_id, version=version, page=str(page_number), renderer=RENDERER_REVISION),
        _pdf_page,
        doc_id,
        version,
        page_number,
    )


def _pdf_page(doc_id, version, page_number):
    """Reader-sized page image; originals and the first-page card cache stay separate."""
    import subprocess
    import sys
    from symbiknow.previews.service import RENDERER_REVISION

    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("PDF preview must pin a version")
    page_number = int(page_number)
    if not 1 <= page_number <= 10000:
        raise ValueError("PDF page is out of range")
    path = server.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}-page-{page_number}-{RENDERER_REVISION}.jpg"
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
                    str(Path(__file__).resolve().parents[1] / "previews/pdf.py"),
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
            raise ValueError("PDF page unavailable or out of range; open the original") from None
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
    return server.application().library.card(doc_id, version).to_wire()


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
            if action == "jev-decisions":
                return JSONResponse(await run_in_threadpool(server.application().decisions.list))
            if action == "freshness":
                return JSONResponse(await run_in_threadpool(
                    server.application().freshness.get, p.get("scan_id"), p.get("after", ""),
                    int(p.get("limit", 30)), p.get("category"), p.get("document_id")))
            if action == "runtime":
                import os
                from symbiknow.embeddings.runtime import get_embedder, runtime_name

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
                from symbiknow.previews.service import JOBS

                return await JOBS.wait(
                    (str(server.DATA_DIR), "thumbnail", p["id"], p["version"]),
                    _thumbnail,
                    p["id"],
                    p["version"],
                )
            if action == "pdf-page":
                from symbiknow.previews.service import JOBS

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
                from symbiknow.organization.rebuild import progress as rebuild_progress

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
            if action == "jev-decision":
                return JSONResponse(await run_in_threadpool(
                    server.application().decisions.resolve, args["decision_id"],
                    args["action"], args.get("value"), actor="user"))
            if action == "freshness":
                return JSONResponse(await run_in_threadpool(
                    server.application().freshness.start, args.get("document_ids"),
                    args.get("reference_document_ids"), args.get("request_id")))
            if action == "freshness-cancel":
                return JSONResponse(await run_in_threadpool(server.application().freshness.cancel, args["scan_id"]))
            if action == "freshness-review":
                return JSONResponse(await run_in_threadpool(
                    server.application().freshness.review, args["scan_id"], args["finding_id"],
                    args["expected_revision"], args["decision"], args.get("note", "")))
            if action == "bulk-download":
                return await run_in_threadpool(bulk_download, args)
            if action in ("delete-document", "delete-folder"):
                return JSONResponse(await run_in_threadpool(delete_item, action, args))
            if action in ("rename-folder", "move-folder", "move-documents"):
                from symbiknow.organization.edits import edit

                return JSONResponse(await run_in_threadpool(edit, action, args))
            if action == "statuses":
                from symbiknow.search.index import document_statuses

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
                from symbiknow.core.retry import clear

                application = server.application()
                with application.write_lock:
                    metadata = storage.read_metadata(application.DATA_DIR, args["document_id"])
                    if metadata["version"] != args["expected_version"]:
                        raise ValueError("File changed; refresh before retrying")
                    clear(application.DATA_DIR, args["document_id"])
                    application.schedule(args["document_id"])
                return JSONResponse({"queued": True})
            if action == "upload":
                result = await run_in_threadpool(server.upload, args["files"])
                result["files"] = [
                    {k: v for k, v in r.items() if k not in ("source", "index_error")}
                    for r in result["files"]
                ]
                return JSONResponse(result)
            if action in {"search", "ask"}:
                result = await run_in_threadpool(server.ask if action == "ask" else server.search, **dict(args, detail="full"))
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
                from symbiknow.organization.rebuild import request as rebuild

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
