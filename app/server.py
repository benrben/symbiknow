"""One local MCP process, filesystem originals first, one bounded index worker."""

from __future__ import annotations

from collections import OrderedDict
import hmac
import time
import base64
import hashlib
import json
import logging
import os
import queue
from pathlib import Path
import threading
import uuid
import asyncio
from typing import Any, Literal
from contextlib import asynccontextmanager

from filelock import FileLock
from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from app import storage

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except ImportError:
    pass

DATA_DIR = Path(os.environ.get("SYMBIKNOW_DATA_DIR", "data")).resolve()
os.environ.setdefault("HF_HOME", str(DATA_DIR / "models"))
STORAGE_ONLY = os.environ.get("SYMBIKNOW_STORAGE_ONLY", "0") == "1"
MAX_CHUNK = int(os.environ.get("SYMBIKNOW_MAX_CHUNK_BYTES", 256 * 1024))
MAX_FILE = int(os.environ.get("SYMBIKNOW_MAX_FILE_BYTES", 256 * 1024 * 1024))
write_lock = threading.RLock()
index_lock = threading.RLock()
wake = threading.Event()
stop = threading.Event()
processing = threading.Event()
log = logging.getLogger("symbiknow")


class TransferRequestError(ValueError, ToolError):
    """An actionable public upload/download request validation failure."""


class SearchRequestError(ValueError, ToolError):
    """An actionable, public search failure (also caught by the local UI)."""


pending: queue.Queue[str] = queue.Queue(maxsize=128)
rescan = threading.Event()
retry_ids: set[str] = set()
status_cache: dict[str, dict] = OrderedDict()
STATUS_CACHE_LIMIT = 4096


def _status(metadata: dict) -> dict:
    head = storage.current_version(DATA_DIR, metadata["document_id"])
    result = dict(
        metadata,
        stored=True,
        current_version=head,
        searchable=False,
        indexing_status="superseded"
        if head != metadata["version"]
        else ("disabled" if STORAGE_ONLY else "pending"),
    )
    indexed = status_cache.get(metadata["document_id"])
    if (
        head == metadata["version"]
        and not STORAGE_ONLY
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


def _register_metadata(metadata):
    from app.search import get_document_status, invalidate_related_organization, register_document

    with write_lock:
        current = storage.read_metadata(DATA_DIR, metadata["document_id"])
        previous = get_document_status(DATA_DIR, current["document_id"])
        if previous and previous.get("version") != current["version"]:
            for related_id in invalidate_related_organization(DATA_DIR, current["document_id"]):
                organization_attempts.difference_update(
                    e for e in list(organization_attempts) if e[0] == related_id
                )
                _schedule(related_id)
        return register_document(DATA_DIR, current, STORAGE_ONLY)


def _schedule(document_id: str) -> None:
    try:
        pending.put_nowait(document_id)
    except queue.Full:
        # The authoritative filesystem head will be found by a deferred recovery scan.
        rescan.set()
    wake.set()


organization_attempts: set[tuple[str, str]] = set()


def _cache_status(metadata, indexed):
    status_cache[metadata["document_id"]] = {
        key: indexed.get(key)
        for key in (
            "version",
            "status",
            "indexed_version",
            "searchable_text",
            "searchable_visual",
            "index_error",
        )
    }
    while len(status_cache) > STATUS_CACHE_LIMIT:
        status_cache.pop(next(iter(status_cache)))
    # Only latest attempted versions need retention; bound long-running bookkeeping.
    organization_attempts.difference_update(
        e
        for e in list(organization_attempts)
        if e[0] == metadata["document_id"] and e[1] != metadata["version"]
    )
    while len(organization_attempts) > STATUS_CACHE_LIMIT:
        organization_attempts.pop()
    if indexed.get("status") in ("pending", "failed", "superseded"):
        retry_ids.add(metadata["document_id"])
    else:
        retry_ids.discard(metadata["document_id"])


def reconcile_once(document_ids=None) -> int:
    """Recover derived indexes from stored heads, without creating OCFL versions.

    Full scans occur at startup or queue overflow. Otherwise only queued/failed IDs
    are checked. Processing and model input remain single threaded and bounded.
    """
    if STORAGE_ONLY:
        return 0
    from app.search import get_document_status, invalidate_related_organization
    from app.ingest import index_document

    def existing_heads():
        for doc_id in document_ids:
            try:
                yield storage.read_metadata(DATA_DIR, doc_id)
            except FileNotFoundError:
                retry_ids.discard(doc_id)
                status_cache.pop(doc_id, None)
                organization_attempts.difference_update(
                    e for e in list(organization_attempts) if e[0] == doc_id
                )
                continue  # A queued item may have been deleted while the worker was busy.

    heads = storage.list_documents(DATA_DIR) if document_ids is None else existing_heads()
    if document_ids is None:
        from app.search import recover_organization_filters
        from app.organization_edits import recover

        with write_lock, index_lock:
            recover(DATA_DIR)
            recover_organization_filters(DATA_DIR)
        for metadata in heads:
            _register_metadata(metadata)
    count = 0
    for metadata in heads:
        if stop.is_set():
            break
        try:
            with index_lock:
                indexed = get_document_status(DATA_DIR, metadata["document_id"])
            if indexed and indexed.get("version") != metadata["version"]:
                for related_id in invalidate_related_organization(
                    DATA_DIR, metadata["document_id"]
                ):
                    organization_attempts.difference_update(
                        entry for entry in list(organization_attempts) if entry[0] == related_id
                    )
                    _schedule(related_id)
            if (
                not indexed
                or indexed.get("version") != metadata["version"]
                or indexed.get("status") in ("pending", "failed")
            ):
                from app.retry import due

                if (
                    indexed
                    and indexed.get("version") == metadata["version"]
                    and indexed.get("status") == "failed"
                    and not due(DATA_DIR, metadata)
                ):
                    _cache_status(metadata, indexed)
                    continue
                with storage.verified_file(
                    DATA_DIR, metadata["document_id"], metadata["version"]
                ) as (path, pinned):
                    indexed = index_document(DATA_DIR, pinned, path)
                count += 1
            _cache_status(metadata, indexed)
            identity = (metadata["document_id"], metadata["version"])
            from app.rebuild import owns as rebuild_owns

            if rebuild_owns(identity[0]):
                continue  # A selective request owns these fields, including failed items.
            if (
                indexed.get("status") != "indexed"
                or indexed.get("organization_status")
                in {"evaluated", "not_evaluated", "reset_failed", "reset_skipped"}
                or identity in organization_attempts
            ):
                continue
            organization_attempts.add(identity)
            from app.jev import organize_document
            from app.search import (
                document_evidence,
                organization_neighbors,
                organization_catalog,
                save_organization,
            )

            # These helpers synchronize their own index reads. Embedding work
            # must not hold the server lock needed by interactive retrieval.
            evidence = document_evidence(DATA_DIR, *identity, limit=128)
            neighbors = (
                organization_neighbors(DATA_DIR, metadata, evidence)
                if evidence and os.environ.get("TYPESAFE_API_KEY")
                else []
            )
            catalog = organization_catalog(DATA_DIR)
            neighbors = [
                item for item in neighbors if item["document_id"] != metadata["document_id"]
            ]
            decision = organize_document(
                metadata,
                evidence,
                neighbors,
                catalog.get("folders", []),
                catalog.get("groups", []),
                catalog.get("projects", []),
            )
            if decision.get("status") == "evaluated":
                with write_lock, index_lock:
                    latest = get_document_status(DATA_DIR, metadata["document_id"])
                    if rebuild_owns(identity[0]):
                        continue  # Reset generation owns publication after its clear boundary.
                    if (
                        not latest
                        or latest["version"] != metadata["version"]
                        or latest["organization_status"] == "evaluated"
                    ):
                        continue  # A newer upload or manual organization won the publication race.
                    save_organization(DATA_DIR, *identity, decision)
            else:
                with write_lock, index_lock:
                    latest = get_document_status(DATA_DIR, identity[0])
                    if (
                        latest
                        and latest["version"] == identity[1]
                        and not rebuild_owns(identity[0])
                    ):
                        save_organization(
                            DATA_DIR,
                            *identity,
                            {
                                **json.loads(latest["organization_json"]),
                                "status": "not_evaluated"
                                if decision.get("status") == "not_evaluated"
                                else "failed",
                                "folder": latest["folder"],
                                "groups": latest["groups"],
                                "links": json.loads(latest["links_json"]),
                                "reason": decision.get("organization_reason")
                                or decision.get("error", "Organization unavailable"),
                                "organization_reason": decision.get("organization_reason")
                                or decision.get("error", "Organization unavailable"),
                            },
                        )
        except Exception:
            # A failed snapshot/provider/publication attempt is not a completed
            # organization decision. Let the queued retry actually run it again.
            organization_attempts.discard((metadata["document_id"], metadata["version"]))
            if storage.current_version(DATA_DIR, metadata["document_id"]) is None:
                retry_ids.discard(metadata["document_id"])
                continue
            retry_ids.add(metadata["document_id"])
            log.exception(
                "Reconciliation failed for %s; original remains stored", metadata["document_id"]
            )
    return count


def _worker() -> None:
    processing.set()
    try:
        reconcile_once()
    except Exception:
        rescan.set()
        log.exception("Startup reconciliation failed; originals are stored")
    finally:
        processing.clear()
    while not stop.is_set():
        from app.rebuild import process_one

        if process_one():
            wake.set()
        wake.wait(30)
        wake.clear()
        if stop.is_set():
            break
        ids = set(retry_ids)
        while True:
            try:
                ids.add(pending.get_nowait())
            except queue.Empty:
                break
        full_scan = rescan.is_set()
        rescan.clear()
        try:
            if full_scan or ids:
                processing.set()
                reconcile_once(None if full_scan else ids)
        except Exception:
            rescan.set()
            log.exception("Index reconciliation failed; will retry")
        finally:
            processing.clear()


@asynccontextmanager
async def lifespan(_server):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    process_lock = FileLock(DATA_DIR / "server.lock", timeout=0)
    process_lock.acquire()
    worker = None
    try:
        storage.init_storage(DATA_DIR)
        storage.recover_deletions(DATA_DIR)
        from app.search import recover_deleted_index

        recover_deleted_index(DATA_DIR)
        stop.clear()
        if STORAGE_ONLY:

            def register_all():
                for metadata in storage.list_documents(DATA_DIR):
                    _register_metadata(metadata)

            await asyncio.to_thread(register_all)
        if not STORAGE_ONLY:
            worker = threading.Thread(target=_worker, name="symbiknow-ingest", daemon=True)
            worker.start()
        yield {}
    finally:
        stop.set()
        wake.set()
        if worker:
            worker.join()  # Keep the process lock until all writes/model calls finish.
        from app.previews import JOBS

        JOBS.drain()
        from app.embeddings import unload_idle

        unload_idle(force=True)
        process_lock.release()


mcp = MCPServer("Symbiknow", lifespan=lifespan)


def _batch(files: list[dict]) -> None:
    if not 1 <= len(files) <= 32:
        raise TransferRequestError("Provide between 1 and 32 files per call")


def _decode(value: str) -> bytes:
    if len(value) > ((MAX_CHUNK + 2) // 3) * 4:
        raise ValueError("Chunk too large; use offset/total_size/sha256/final chunk transfer")
    data = base64.b64decode(value, validate=True)
    if len(data) > MAX_CHUNK:
        raise ValueError("Chunk too large")
    return data


def _save(item: dict) -> dict:
    content = _decode(item["content_base64"])
    request_id = str(uuid.UUID(item.get("request_id") or str(uuid.uuid4())))
    metadata = {
        key: item.get(key)
        for key in ("filename", "mime_type", "source", "document_id", "expected_version")
    }
    if not isinstance(metadata["filename"], str) or not metadata["filename"]:
        raise ValueError("filename is required")
    if "offset" not in item:
        saved = storage.save_file(DATA_DIR, content, request_id=request_id, **metadata)
        _register_metadata(saved)
        _schedule(saved["document_id"])
        return _status(saved)
    offset = item["offset"]
    total = item.get("total_size")
    digest = item.get("sha256", "")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= MAX_FILE:
        raise ValueError("total_size is required and must fit the file limit")
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("A lowercase whole-file SHA-256 is required for chunks")
    if offset + len(content) > total or (not content and total != 0):
        raise ValueError("Chunk exceeds total_size or makes no progress")
    identity = dict(metadata, request_id=request_id, total_size=total, sha256=digest)
    incoming = DATA_DIR / "temp"
    incoming.mkdir(parents=True, exist_ok=True)
    manifest = incoming / f"{request_id}.json"
    part = incoming / f"{request_id}.part"
    if manifest.exists():
        state = json.loads(manifest.read_text())
        if state["identity"] != identity:
            raise ValueError("request_id reused with different upload metadata")
        if state.get("result"):
            return _status(state["result"])
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
    saved = storage.save_file(DATA_DIR, part, request_id=request_id, **metadata)
    _register_metadata(saved)
    state["result"] = saved
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(manifest)
    part.unlink()
    _schedule(saved["document_id"])
    return _status(saved)


@mcp.tool(structured_output=True)
def upload(files: list[dict[str, Any]]) -> dict[str, Any]:
    """Upload actual base64 bytes, single/bulk; updates create independent OCFL versions.

    Each item has filename, content_base64, optional MIME/source/document_id/expected_version,
    and a UUID request_id for safe retries. For large files send sequential chunks with
    offset, total_size, whole-file sha256 and final=true on the final chunk. Up to 32 items.
    Each item returns its own success/error; stored files may still await indexing.
    """
    _batch(files)
    results = []
    for item in files:
        try:
            with write_lock:
                results.append(_save(item))
        except Exception as exc:
            results.append(
                {
                    "stored": False,
                    "searchable": False,
                    "request_id": item.get("request_id"),
                    "error": str(exc),
                }
            )
    return {"files": results}


@mcp.tool(structured_output=True)
def download(files: list[dict[str, Any]]) -> dict[str, Any]:
    """Download actual base64 bytes, single/bulk, with optional version, offset and length.

    Each item needs document_id. Pin the returned version for subsequent ranges. Response
    preserves filename, MIME, source and SHA-256, reports EOF, and limits each range to the configured chunk cap (256KiB by default).
    """
    _batch(files)
    results = []
    for item in files:
        try:
            offset, length = item.get("offset", 0), item.get("length", MAX_CHUNK)
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                raise ValueError("offset must be a nonnegative integer")
            if (
                not isinstance(length, int)
                or isinstance(length, bool)
                or not 1 <= length <= MAX_CHUNK
            ):
                raise ValueError("length must be between 1 and the chunk limit")
            with storage.verified_file(DATA_DIR, item["document_id"], item.get("version")) as (
                path,
                metadata,
            ):
                if offset > metadata["size"]:
                    raise ValueError("offset exceeds file size")
                with path.open("rb") as source_file:
                    source_file.seek(offset)
                    chunk = source_file.read(length)
            result = dict(
                _status(metadata),
                content_base64=base64.b64encode(chunk).decode("ascii"),
                offset=offset,
                returned_bytes=len(chunk),
                eof=offset + len(chunk) == metadata["size"],
            )
            if item.get("include_versions") or item.get("history"):
                result["versions"] = storage.list_versions(DATA_DIR, item["document_id"])
            results.append(result)
        except Exception as exc:
            results.append({"document_id": item.get("document_id"), "error": str(exc)})
    return {"files": results}


def search_full(
    query: str,
    mode: str = "hybrid",
    limit: int = 10,
    folder: str | None = None,
    group: str | None = None,
    evaluate: bool = False,
) -> dict[str, Any]:
    """Retrieve current-version evidence and relevance explanations; optionally judge with Jev.

    mode is semantic, keyword, hybrid, or answer (hybrid plus Jev evaluation).
    Answer mode and evaluate=True return only accepted complete/partial answers or premise corrections;
    empty matches with answer.status explain no supported answer, uncertainty, or provider failure. Logical folder/group filters are metadata. Images
    distinguish visual matches from OCR/caption evidence used for text judgments.
    """
    if mode == "answer":
        mode, evaluate = "hybrid", True
    if not query.strip() or mode not in ("semantic", "keyword", "hybrid") or not 1 <= limit <= 100:
        raise SearchRequestError("Use a nonempty query, valid mode and limit between 1 and 100")
    if STORAGE_ONLY:
        return {
            "matches": [],
            "status": "indexing_disabled",
            "evaluation": {"status": "unavailable", "error": "Storage-only mode"},
        }
    from app.search import find_documents, IndexChangedError

    # find_documents releases INDEX_LOCK while embedding, then validates its
    # current-version rows. An outer lock would serialize unrelated searches.
    from app.search_metrics import stage

    with stage("retrieval"):
        # One retry for concurrent ingestion/organization, before spending any
        # provider budget. Never spin or return a mixed-version snapshot.
        for attempt in range(2):
            try:
                matches = find_documents(
                    DATA_DIR, query, mode, limit, folder, group, defer_links=True
                )
                break
            except IndexChangedError:
                if attempt:
                    raise SearchRequestError(
                        "The library is changing during retrieval. Retry this search after indexing or Jev organization finishes."
                    ) from None
                from app.search_metrics import add

                add("retrieval_retries", 1)
    evaluation = {"status": "not_requested"}
    if evaluate:
        from app.jev import judge_matches

        try:
            with stage("jev"):
                evaluation = judge_matches(query, matches, cache_namespace=str(DATA_DIR.resolve()))
            matches = evaluation.get("matches", matches)
        except Exception as exc:
            evaluation = {
                "status": "unavailable",
                "error": f"Jev unavailable ({type(exc).__name__})",
            }
    evaluation = {key: value for key, value in evaluation.items() if key != "matches"}
    matches, revision = _refresh_matches(matches, folder, group)
    comparison = evaluation.get("cross_document_assessment", {})
    compared = set(comparison.get("compared_chunk_ids", []))
    if compared:
        # A cross-document decision depends on every compared current window,
        # including a counterpart removed by final head/scope validation.
        current = {
            window["chunk_id"]
            for match in matches
            if match.get("jev", {}).get("status") == "evaluated"
            for window in match["jev"].get("evaluated_evidence", [])
        }
        if not compared <= current:
            comparison.update(status="unavailable", reason="evidence_changed")
            for match in matches:
                judgment = match.get("jev", {})
                if any(
                    window["chunk_id"] in compared
                    for window in judgment.get("evaluated_evidence", [])
                ):
                    match["jev"] = {
                        "status": "not_evaluated",
                        "reason": "disagreement_evidence_changed",
                    }
    answer = {"status": "not_requested"}
    if evaluate:
        from app.jev import answer_results

        matches, answer = answer_results(matches, evaluation)
    return {
        "matches": matches,
        "status": "ok",
        "evaluation": evaluation,
        "answer": answer,
        "indexing": {
            "processing": processing.is_set(),
            "queued_uploads": pending.qsize(),
            "retry_documents": len(retry_ids),
        },
    }


def _refresh_matches(matches, folder, group, expected_revision=None):
    # Refresh display metadata after provider latency, and validate every
    # accepted evidence reference against the still-current stored passage.
    from app.search import document_statuses, resolve_evidence_many, revisions

    from time import perf_counter
    from app.search_metrics import add, stage, timed_lock
    from app.search import INDEX_LOCK

    waiting = perf_counter()
    with (
        timed_lock(write_lock, "final_write_lock"),
        timed_lock(index_lock, "final_server_index_lock"),
        timed_lock(INDEX_LOCK, "final_index_lock"),
        storage.read_snapshot(DATA_DIR),
    ):
        add("final_lock_wait_seconds", perf_counter() - waiting)
        if expected_revision is not None and revisions(DATA_DIR) != expected_revision:
            raise SearchRequestError(
                "Continuation invalidated by index/organization changes; restart search"
            )
        add("final_lock_acquisitions", 1)
        refreshed = []
        states = document_statuses(DATA_DIR, (match["document_id"] for match in matches))
        target_ids = {
            link["document_id"]
            for state in states.values()
            for link in json.loads(state.get("links_json", "[]"))
        } - states.keys()
        if target_ids:
            states.update(document_statuses(DATA_DIR, target_ids))
        heads = {}

        def final_head(identity, role="final"):
            # Role counts include final relationship endpoints separately.
            # Reuse only inside the cross-process storage snapshot; every
            # supported writer is excluded until final publication completes.
            if identity not in heads:
                add(role + "_head_checks", 1)
                with stage(role + "_heads"):
                    heads[identity] = storage.current_version(DATA_DIR, identity)
            return heads[identity]

        requested = []
        for match in matches:
            identity, version = match["document_id"], match["version"]
            j = match.get("jev", {})
            refs = [r.get("evidence_id") for r in match.get("evidence", [])]
            refs.extend(r["chunk_id"] for r in j.get("evaluated_evidence", []))
            for key in (
                "supporting_chunk_ids",
                "conflicting_chunk_ids",
                "possible_conflicting_chunk_ids",
                "disagreement_chunk_ids",
            ):
                refs.extend(j.get(key, []))
            requested.extend((identity, version, ref) for ref in refs)
            for link in json.loads(states.get(identity, {}).get("links_json", "[]")):
                requested.append((identity, version, link.get("source_chunk_id")))
                requested.append(
                    (link["document_id"], link["version"], link.get("target_chunk_id"))
                )
        with stage("final_evidence"):
            passages = resolve_evidence_many(DATA_DIR, requested)

        def resolve(document_id, version, evidence_id):
            return passages.get((document_id, str(version), evidence_id))

        for match in matches:
            row = states.get(match["document_id"])
            if (
                row is None
                or row["status"] != "indexed"
                or row["indexed_version"] != match["version"]
                or row["version"] != match["version"]
                or final_head(match["document_id"]) != match["version"]
            ):
                continue
            if folder is not None and not (
                row["folder"] == folder or (folder and row["folder"].startswith(folder + " / "))
            ):
                continue
            if group is not None and group not in row["groups"]:
                continue
            match.update(
                folder=row["folder"],
                groups=row["groups"],
                organization_status=row["organization_status"],
            )
            match["links"] = [
                dict(link, filename=states[link["document_id"]]["filename"])
                for link in json.loads(row.get("links_json", "[]"))
                if link["document_id"] in states
                and states[link["document_id"]]["version"] == link["version"]
                and states[link["document_id"]]["indexed_version"] == link["version"]
                and states[link["document_id"]]["status"] == "indexed"
                and link.get("source_version") == match["version"]
                and final_head(link["document_id"], "final_relationship") == link["version"]
                and resolve(match["document_id"], match["version"], link.get("source_chunk_id"))
                and resolve(link["document_id"], link["version"], link.get("target_chunk_id"))
            ]
            judgment = match.get("jev", {})
            references = [
                *judgment.get("supporting_chunk_ids", []),
                *judgment.get("conflicting_chunk_ids", []),
                *judgment.get("possible_conflicting_chunk_ids", []),
                *judgment.get("disagreement_chunk_ids", []),
            ]
            resolved = {
                ref: resolve(match["document_id"], match["version"], ref) for ref in references
            }
            changed = any(not value for value in resolved.values())
            for window in judgment.get("evaluated_evidence", []):
                ref = window["chunk_id"]
                current = resolved.get(ref) or resolve(match["document_id"], match["version"], ref)
                if (
                    not current
                    or current["text"][window["text_start"] : window["text_end"]] != window["text"]
                ):
                    changed = True
            # Validate retrieval windows too, including evaluate=False searches.
            for passage in match.get("evidence", []):
                current = resolve(
                    match["document_id"], match["version"], passage.get("evidence_id")
                )
                if not current or current.get("text") != passage.get("text"):
                    changed = True
            if changed:
                match["jev"] = {"status": "not_evaluated", "reason": "evidence_changed"}
                match["evidence"] = [
                    current
                    for passage in match.get("evidence", [])
                    if (
                        current := resolve(
                            match["document_id"],
                            match["version"],
                            passage.get("evidence_id"),
                        )
                    )
                ]
            refreshed.append(match)
        matches = refreshed
        revision = revisions(DATA_DIR)
    return matches, revision


# Short-lived process-local continuation windows. No disk service or extra tool.
# Bounded both by count and retained bytes; restarts/eviction require a new search.

_CONTINUATIONS = OrderedDict()
_CONTINUATION_LOCK = threading.RLock()
_CURSOR_SECRET = os.urandom(32)
CURSOR_TTL = 300
CURSOR_WINDOWS = 16
CURSOR_BYTES = 32 * 1024 * 1024


def _cursor_binding(query, mode, limit, folder, group, evaluate, detail):
    from app import jev

    return hashlib.sha256(
        json.dumps(
            [
                str(DATA_DIR.resolve()),
                query,
                mode,
                limit,
                folder,
                group,
                evaluate,
                detail,
                os.getenv("TYPESAFE_DEFAULT_MODEL", "jev-1.13.0"),
                jev.PROMPT_VERSION,
                jev.POLICY_VERSION,
                jev.SEARCH_CONTEXT,
                jev.ANSWER_CONFIDENCE,
                jev.SUPPORT_ACCEPT,
                jev.APPLICABILITY_ACCEPT,
                jev.APPLICABILITY_REVIEW,
                jev.CONFLICT_ACCEPT,
                jev.CONFLICT_REVIEW,
                jev.PREMISE_ACCEPT,
                jev.PREMISE_REVIEW,
                jev.DISAGREEMENT_ACCEPT,
                jev.DISAGREEMENT_REVIEW,
                jev.DISAGREEMENT_CONTEXT,
                jev.DISAGREEMENT_WINDOWS_PER_DOCUMENT,
            ],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def _cursor_token(identity, offset):
    payload = f"{identity}.{offset}"
    signature = hmac.new(_CURSOR_SECRET, payload.encode(), "sha256").hexdigest()
    return payload + "." + signature


def _read_cursor(token, binding):
    if not isinstance(token, str) or len(token) > 160:
        raise SearchRequestError("Malformed continuation; restart search")
    try:
        identity, offset, signature = token.split(".")
        offset = int(offset)
        if offset <= 0 or not hmac.compare_digest(token, _cursor_token(identity, offset)):
            raise SearchRequestError()
    except (ValueError, TypeError):
        raise SearchRequestError("Malformed continuation; restart search") from None
    with _CONTINUATION_LOCK:
        window = _CONTINUATIONS.get(identity)
        if window is None or time.monotonic() - window["created"] > CURSOR_TTL:
            _CONTINUATIONS.pop(identity, None)
            raise SearchRequestError(
                "Continuation expired, evicted or server restarted; restart search"
            )
        if window["binding"] != binding:
            raise SearchRequestError(
                "Continuation arguments or evaluation policy differ; restart search"
            )
        if offset >= len(window["result"]["matches"]):
            raise SearchRequestError("Continuation offset outside result window; restart search")
        _CONTINUATIONS.move_to_end(identity)
        return identity, offset, window


def _save_cursor(result, binding, revision):
    size = len(json.dumps(result, ensure_ascii=False).encode())
    if size > CURSOR_BYTES:
        raise SearchRequestError(
            "Continuation window too large; repeat with detail=full or smaller limit"
        )
    identity = uuid.uuid4().hex
    with _CONTINUATION_LOCK:
        now = time.monotonic()
        for key in list(_CONTINUATIONS):
            if now - _CONTINUATIONS[key]["created"] > CURSOR_TTL:
                del _CONTINUATIONS[key]
        while _CONTINUATIONS and (
            len(_CONTINUATIONS) >= CURSOR_WINDOWS
            or sum(w["bytes"] for w in _CONTINUATIONS.values()) + size > CURSOR_BYTES
        ):
            _CONTINUATIONS.popitem(last=False)
        _CONTINUATIONS[identity] = {
            "result": result,
            "binding": binding,
            "revision": revision,
            "created": now,
            "bytes": size,
        }
    return identity


@mcp.tool(structured_output=True)
def search(
    query: str,
    mode: str = "hybrid",
    limit: int = 10,
    folder: str | None = None,
    group: str | None = None,
    evaluate: bool = False,
    detail: Literal["compact", "full"] = "compact",
    continuation: str | None = None,
) -> dict[str, Any]:
    """Search current originals. compact returns bounded evidence windows; full adds
    raw Jev diagnostics and passage text. Neither is the complete original; use download.
    mode: hybrid, keyword, semantic or answer (hybrid with Jev). With answer or
    evaluate=True, only accepted answer evidence is returned; answer.status and counts
    distinguish no answer in evaluated candidates, partial, uncertainty and unavailable.
    Ordinary retrieval modes without evaluation return related files. limit is the bounded
    result window (max 100). Repeat identical arguments with page.continuation to
    retrieve more compact entries. Tokens expire after five minutes; changes to
    index/organization or live OCFL heads require restarting. Three tools only.
    """
    from app.search_metrics import CURRENT, stage
    from app.search_projection import COMPACT_BYTES, project_search

    if detail not in {"compact", "full"}:
        raise SearchRequestError("detail must be compact or full")
    if continuation and detail != "compact":
        raise SearchRequestError(
            "Continuation requires detail=compact; restart for full diagnostics"
        )
    from app.search import revisions, INDEX_LOCK
    import copy

    binding = _cursor_binding(query, mode, limit, folder, group, evaluate, detail)
    metrics = {
        "provider_calls": 0,
        "candidate_head_checks": 0,
        "relationship_head_checks": 0,
        "final_head_checks": 0,
        "final_relationship_head_checks": 0,
    }
    token = CURRENT.set(metrics)
    try:
        with stage("total"):
            offset, identity = 0, None
            if continuation:
                identity, offset, window = _read_cursor(continuation, binding)
                result = copy.deepcopy(window["result"])
                matches, revision = _refresh_matches(
                    result["matches"], folder, group, window["revision"]
                )
                # Refresh changes display fields, links and evidence in place.
                # Compare with the retained window, not its mutated working copy;
                # same-head extraction/link changes may precede revision updates.
                if matches != window["result"]["matches"]:
                    raise SearchRequestError(
                        "Continuation invalidated by changed heads/evidence/links; restart search"
                    )
                metrics["continuation_reuse"] = 1
            else:
                with INDEX_LOCK:
                    revision = revisions(DATA_DIR)
                result = search_full(query, mode, limit, folder, group, evaluate)
                with INDEX_LOCK:
                    current_revision = revisions(DATA_DIR)
            with stage("projection"):
                projected = project_search(result, detail, offset=offset)
                if detail == "compact" and projected["page"]["has_more"]:
                    if identity is None:
                        if current_revision != revision:
                            raise SearchRequestError(
                                "Index/organization changed during search; restart search"
                            )
                        identity = _save_cursor(result, binding, revision)
                    projected["page"]["continuation"] = _cursor_token(
                        identity, offset + len(projected["matches"])
                    )
                    projected["page"].pop("instructions", None)
                result = projected
        with stage("serialization"):
            json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        result["metrics"] = metrics
        if (
            detail == "compact"
            and len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode())
            > COMPACT_BYTES
        ):
            raise SearchRequestError(
                "Compact diagnostics exceed budget; use detail=full or a smaller limit"
            )
        return result
    finally:
        CURRENT.reset(token)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--web", action="store_true", help="Serve UI and shared HTTP MCP")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.web:
        import uvicorn
        from app.ui import create_app

        uvicorn.run(create_app(), host="127.0.0.1", port=args.port, timeout_graceful_shutdown=5)
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
