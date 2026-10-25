"""Loopback UI and HTTP MCP, one SDK application lifespan/storage owner."""

from __future__ import annotations

from symbiknow.core.paths import REPO_ROOT

import json
from pathlib import Path
from urllib.parse import quote, urlsplit

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
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


def _cached_preview(path, doc_id, version, *, page=False):
    from symbiknow.previews.service import cached
    result = cached(server.application(), path, doc_id, version, page=page)
    return Response(result[0], media_type="image/jpeg", headers=result[1]) if result else None


def _thumbnail(doc_id, version):
    from symbiknow.previews.service import render_thumbnail
    content, headers = render_thumbnail(server.application(), doc_id, version)
    return Response(content, media_type="image/jpeg", headers=headers)


def thumbnail(doc_id, version):
    from symbiknow.previews.service import JOBS
    return JOBS.run((str(server.DATA_DIR), "thumbnail", doc_id, version), _thumbnail, doc_id, version)


def _pdf_page(doc_id, version, page_number):
    from symbiknow.previews.service import render_page
    content, headers = render_page(server.application(), doc_id, version, page_number)
    return Response(content, media_type="image/jpeg", headers=headers)


def pdf_page(doc_id, version, page_number):
    from symbiknow.previews.service import JOBS
    return JOBS.run((str(server.DATA_DIR), "page", doc_id, version, page_number), _pdf_page, doc_id, version, page_number)


def card(doc_id, version):
    return server.application().library.card(doc_id, version).to_wire()


async def selection_export(request):
    """Stream a pinned ZIP descriptor with standard conditional/range behavior."""
    from secrets import token_hex
    from starlette.responses import StreamingResponse, MalformedRangeHeader, RangeNotSatisfiable
    from symbiknow.transfers.exports import opened

    lease = opened(server.application(), request.query_params.get("token", ""))
    handle, count, stat = await run_in_threadpool(lease.__enter__)
    try:
        # Reuse the installed Starlette range parser/header rules; its FileResponse
        # cannot serve here because it reopens a path after deletion/expiry locks.
        headers = FileResponse("export.zip", stat_result=stat, media_type="application/zip",
                               filename="Symbiknow files.zip", headers={
                                   "X-Symbiknow-File-Count": str(count),
                                   "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})
        ranges = [(0, stat.st_size)]
        status, boundary, part_header = 200, None, None
        raw = request.headers.get("range")
        if raw and (not request.headers.get("if-range") or headers._should_use_range(request.headers["if-range"])):
            parsed = headers._parse_range_header(raw, stat.st_size)
            if parsed:
                ranges, status = parsed, 206
                if len(ranges) == 1:
                    start, end = ranges[0]
                    headers.headers["Content-Range"] = f"bytes {start}-{end - 1}/{stat.st_size}"
                    headers.headers["Content-Length"] = str(end - start)
                else:
                    boundary = token_hex(13)
                    length, part_header = headers.generate_multipart(ranges, boundary, stat.st_size, "application/zip")
                    headers.headers["Content-Type"] = "multipart/byteranges; boundary=" + boundary
                    headers.headers["Content-Length"] = str(length)


        def stream():
            if request.method == "HEAD":
                return
            for start, end in ranges:
                if part_header:
                    yield part_header(start, end)
                handle.seek(start)
                while start < end:
                    content = handle.read(min(256 * 1024, end - start))
                    if not content:
                        raise OSError("Export ended before its recorded size")
                    start += len(content)
                    yield content
                if boundary:
                    yield b"\r\n"
            if boundary:
                yield ("--" + boundary + "--").encode("ascii")

        class ExportResponse(StreamingResponse):
            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    lease.__exit__(None, None, None)

        return ExportResponse(stream(), status_code=status, headers=dict(headers.headers))
    except (MalformedRangeHeader, RangeNotSatisfiable) as error:
        lease.__exit__(None, None, None)
        return Response(status_code=416 if isinstance(error, RangeNotSatisfiable) else 400,
                        headers={"Content-Range": f"bytes */{stat.st_size}"})
    except BaseException:
        lease.__exit__(None, None, None)
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


async def original_ranges(request, doc_id, version, preview=False):
    from starlette.responses import StreamingResponse
    import re
    lease = storage.verified_ranges(server.DATA_DIR, doc_id, version)
    try:
        reader, metadata = await run_in_threadpool(lease.__enter__)
    except storage.RangeNotReady as pending:
        return JSONResponse(server.application().jobs.start("original-prepare", {"document_id": doc_id, "version": pending.metadata["version"]}), status_code=202)
    try:
        size = metadata["size"]
        start, end, status = 0, size, 200
        etag = '"' + metadata["sha256"] + '"'
        raw = request.headers.get("range", "")
        if raw and request.headers.get("if-range", etag) == etag:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", raw)
            if not match or not any(match.groups()):
                raise ValueError("Invalid range")
            left, right = match.groups()
            start = int(left) if left else max(0, size - int(right))
            end = min(size, int(right) + 1) if left and right else size
            if start >= end or start >= size:
                raise ValueError("Range is outside the original")
            status = 206
        mime = metadata["mime_type"].split(";")[0]
        safe = mime in {"application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "text/plain", "text/markdown", "text/x-markdown"}
        disposition = "inline" if preview and safe else "attachment"
        headers = {
            "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(Path(metadata['filename']).name)}",
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Length": str(end - start), "Accept-Ranges": "bytes", "ETag": etag,
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end - 1}/{size}"
        # Authenticate the first bytes before committing HTTP success headers.
        first = await run_in_threadpool(reader.read, start, min(262144, end - start)) if end > start else b""
        def stream():
            offset = start
            yield first
            offset += len(first)
            while offset < end:
                chunk = reader.read(offset, min(262144, end - offset))
                yield chunk
                offset += len(chunk)
        class RangeResponse(StreamingResponse):
            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    lease.__exit__(None, None, None)
        return RangeResponse(stream(), status_code=status, headers=headers,
                             media_type=mime if safe else "application/octet-stream")
    except ValueError:
        lease.__exit__(None, None, None)
        return Response(status_code=416, headers={"Content-Range": f"bytes */{metadata['size']}"})
    except BaseException:
        lease.__exit__(None, None, None)
        raise


def search_presentation(result):
    for match in result["matches"]:
        match.pop("source", None)
        passages = [r for r in match.get("evidence", []) if r.get("text")]
        supports = match.get("jev", {}).get("supporting_chunk_ids", [])
        chosen = next((r for r in passages if r.get("evidence_id") in supports), None)
        match["excerpt"] = clean_text(
            (chosen or (passages[0] if passages else {})).get("text", "")
        )
    return result


async def api(request: Request):
    try:
        action = request.path_params["action"]
        p = request.query_params
        if request.method == "GET":
            if action == "catalog":
                return JSONResponse(await run_in_threadpool(
                    server.application().catalog.list_documents, limit=int(p.get("limit", 50)),
                    cursor=p.get("cursor"), folder=p.get("folder"), topic=p.get("topic"),
                    project=p.get("project"), status=p.get("status")))
            if action == "taxonomy":
                return JSONResponse(await run_in_threadpool(
                    server.application().catalog.taxonomy, dimension=p.get("dimension", "all"),
                    limit=int(p.get("limit", 50)), cursor=p.get("cursor")))
            if action == "organization-history":
                return JSONResponse(await run_in_threadpool(
                    server.application().catalog.history, p["id"],
                    limit=int(p.get("limit", 50)), cursor=p.get("cursor")))
            if action == "organization-correction":
                return JSONResponse(await run_in_threadpool(server.application().corrections.inspect, p["id"]))
            if action == "original-ready":
                def ready_original():
                    try:
                        with storage.verified_ranges(server.DATA_DIR, p["id"], p.get("version")) as (_, metadata):
                            return {"ready": True, "version": metadata["version"]}
                    except storage.RangeNotReady as pending:
                        return server.application().jobs.start("original-prepare", {"document_id": p["id"], "version": pending.metadata["version"]})
                return JSONResponse(await run_in_threadpool(ready_original))
            if action == "job":
                result = await run_in_threadpool(server.application().jobs.get, p["id"])
                if result.get("result") and "matches" in result["result"]:
                    search_presentation(result["result"])
                return JSONResponse(result)
            if action == "jev-decisions":
                return JSONResponse(await run_in_threadpool(server.application().decisions.list, int(p.get("limit", 50)), p.get("after", "")))
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
                return await selection_export(request)
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
                return await original_ranges(request, p["id"], p.get("version"), action == "original")
            if action in {"preview-ready", "thumbnail", "pdf-page"}:
                from symbiknow.previews.service import preview_path, request as request_preview
                page = int(p.get("page", "1")) if action == "pdf-page" or p.get("page") else None
                if action != "preview-ready":
                    path = preview_path(server.application(), p["id"], p["version"], page)
                    cached = await run_in_threadpool(_cached_preview, path, p["id"], p["version"], page=page is not None)
                    if cached is not None:
                        return cached
                job = await run_in_threadpool(request_preview, server.application(), p["id"], p["version"], page)
                return JSONResponse(job, status_code=202 if job.get("job_id") else 200)
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
            if action == "organization-correction":
                return JSONResponse(await run_in_threadpool(server.application().corrections.apply, args))
            if action == "project-ownership":
                return JSONResponse(await run_in_threadpool(server.application().corrections.correct_ownership, args))
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
                return JSONResponse(await run_in_threadpool(server.application().jobs.start, "bulk-export", {"documents": args.get("documents", [])}))
            if action == "delete-folder":
                return JSONResponse(await run_in_threadpool(server.application().jobs.start, "organization-edit", {"action": "remove-folder", "args": args}))
            if action == "delete-document":
                return JSONResponse(await run_in_threadpool(delete_item, action, args))
            if action in ("rename-folder", "move-folder", "move-documents"):
                from symbiknow.organization.edits import edit

                if action != "move-documents":
                    return JSONResponse(await run_in_threadpool(server.application().jobs.start, "organization-edit", {"action": action, "args": args}))
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
                def retry_index():
                    with application.write_lock:
                        metadata = storage.read_metadata(application.DATA_DIR, args["document_id"])
                        if metadata["version"] != args["expected_version"]:
                            raise ValueError("File changed; refresh before retrying")
                        clear(application.DATA_DIR, args["document_id"])
                        application.schedule(args["document_id"])

                # Lock waits and native metadata reads must not stop the ASGI
                # loop from serving unrelated requests or streaming originals.
                await run_in_threadpool(retry_index)
                return JSONResponse({"queued": True})
            if action == "upload":
                result = await run_in_threadpool(server.submit_upload, args["files"])
                result["files"] = [
                    {k: v for k, v in r.items() if k not in ("source", "index_error")}
                    for r in result["files"]
                ]
                return JSONResponse(result)
            if action in {"search", "ask"}:
                if action == "ask" or args.get("evaluate") or args.get("mode") == "answer":
                    options = {k: v for k, v in args.items() if k in {"query", "mode", "limit", "folder", "group"}}
                    if action == "ask":
                        if not 1 <= options.get("limit", 3) <= 3:
                            raise ValueError("Ask checks between 1 and 3 files")
                        options.update(mode="semantic", limit=options.get("limit", 3))
                    options["evaluate"] = True
                    return JSONResponse(await run_in_threadpool(server.application().jobs.start, "ask", options))
                result = await run_in_threadpool(server.ask if action == "ask" else server.submit_search, **dict(args, detail="full"))
                if "job_id" in result:
                    return JSONResponse(result)
                search_presentation(result)
                return JSONResponse(result)
            if action == "rebuild":
                return JSONResponse(await run_in_threadpool(server.application().jobs.start, "organization-rebuild", args))
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
    from contextlib import asynccontextmanager
    from symbiknow.api.agents.http import AgentRoutes

    agents = AgentRoutes(server.application)
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original_lifespan(application):
            try:
                yield
            finally:
                await agents.close()

    app.router.lifespan_context = lifespan
    app.router.routes.extend(agents.routes())
    app.router.routes.append(Route("/api/{action}", api, methods=["GET", "POST"]))
    if BUILD.exists():
        app.router.routes.append(Mount("/", app=StaticFiles(directory=BUILD, html=True)))
    app.add_middleware(LocalProtection)
    return app
