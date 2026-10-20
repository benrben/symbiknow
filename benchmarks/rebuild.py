"""79-file isolated publication benchmark; real OCFL/LanceDB, fixture model/decisions.

Measures Keyword retrieval during full organization reset/rebuild. No live-library
access, provider requests, or target-scale capacity claim.
"""

from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import platform
import resource
import os
from pathlib import Path
import statistics
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from symbiknow.ai import jev
from symbiknow.organization import rebuild
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.api import http as ui  # noqa: E402
from tests.search.test_search import FixtureEmbedder  # noqa: E402


def summary(samples):
    samples = sorted(samples)
    return {
        "count": len(samples),
        "min_ms": min(samples),
        "p50_ms": statistics.median(samples),
        "p95_ms": samples[int(0.95 * (len(samples) - 1))],
        "max_ms": max(samples),
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--attempts", type=int, default=100)
    parser.add_argument("--execution-note", default="No concurrent workload declared; record actual conditions before interpreting timings")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="symbiknow-review8-benchmark-") as temp:
        root = Path(temp)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        os.environ["TYPESAFE_API_KEY"] = "fixture-no-provider"
        jev.preflight = lambda: None
        search.get_embedder = FixtureEmbedder
        storage.init_storage(root)
        identities = []
        for i in range(79):
            text = (
                f"# Harbor / Storage / Policy {i}\nCanvasrevieweight keeps every original version."
            )
            metadata = storage.save_file(root, text.encode(), f"policy-{i}.txt")
            identities.append(metadata["document_id"])
            search.put_chunks(
                root,
                metadata,
                [
                    {
                        "chunk_id": f"{metadata['document_id']}:v1:t0",
                        "text": text,
                        "basis": "text",
                        "vector": [1.0, 0.0, 0.1],
                        "provenance_json": "{}",
                    }
                ],
                "test-only-fixture",
            )
            search.set_document_status(
                root, metadata, status="indexed", indexed_version="v1", chunk_count=1
            )
            search.save_organization(
                root,
                metadata["document_id"],
                "v1",
                {"status": "evaluated", "folder": "Old", "groups": [], "links": []},
            )

        def decision(*args, **kwargs):
            time.sleep(0.005)  # A controlled yield, not a provider latency estimate.
            return {"status": "evaluated", "folder": "Harbor / Storage", "groups": [], "links": []}

        jev.organize_document = decision

        from symbiknow.organization.edits import edit
        edit("move-documents", {"folder": "Manual", "documents": [
            {"document_id": identities[0], "expected_version": "v1"}]})
        conflicts, attempts = [], []

        def query():
            before = search.revisions(root)
            start = time.perf_counter()
            try:
                result = server.search("Canvasrevieweight", mode="keyword", limit=40, detail="full")
            except server.SearchRequestError as error:
                if "library is changing" not in str(error):
                    raise
                duration = (time.perf_counter() - start) * 1000
                conflicts.append(duration)
                attempts.append({"seconds": duration / 1000, "error": str(error),
                    "kind": "publication_invalidation" if search.revisions(root) != before else "preparation_error"})
                return None
            assert len(result["matches"]) == 40
            duration = (time.perf_counter() - start) * 1000
            attempts.append({"seconds": duration / 1000, "kind": "success",
                "publication_overlap": search.revisions(root) != before,
                "metrics": result.get("metrics", {})})
            return duration

        idle = [query() for _ in range(5)]
        attempts.clear()
        started = threading.Event()

        def worker():
            started.set()
            begin = time.perf_counter()
            rebuild.request(grouping=True, links=False)
            clear_ms = (time.perf_counter() - begin) * 1000
            while rebuild.process_one():
                pass
            return clear_ms

        samples, listing, rounds = [], [], 0
        rebuild_started = time.perf_counter()
        while len(samples) + len(conflicts) < args.attempts:
            rounds += 1
            started.clear()
            with ThreadPoolExecutor(max_workers=1) as pool:
                work = pool.submit(worker)
                assert started.wait(2)
                while not work.done():
                    value = query()
                    if value is not None:
                        samples.append(value)
                    begin = time.perf_counter()
                    assert ui.library({"limit": "1"})["library_total"] == 79
                    listing.append((time.perf_counter() - begin) * 1000)
                clear_ms = work.result()
            assert rebuild.status()["status"] == "completed"
        rebuild_elapsed = time.perf_counter() - rebuild_started
        assert len(samples) + len(conflicts) >= args.attempts
        final_rows = list(search.metadata_batches(root))
        final_rows = [row for batch in final_rows for row in batch]
        assert len(final_rows) == 79
        assert all(row["folder"] == ("Manual" if row["document_id"] == identities[0] else "Harbor / Storage")
                   for row in final_rows)
        assert not any(row["kind"] == "preparation_error" for row in attempts)
        page_samples, continuation_samples = [], []
        for _ in range(3):
            begin = time.perf_counter()
            page = server.search("Canvasrevieweight", mode="keyword", limit=79)
            page_samples.append((time.perf_counter() - begin) * 1000)
            cursor = page.get("page", {}).get("continuation")
            if cursor:
                begin = time.perf_counter()
                server.search("Canvasrevieweight", mode="keyword", limit=79, continuation=cursor)
                continuation_samples.append((time.perf_counter() - begin) * 1000)
        print("Pagination measured", flush=True)
        report = {
            "execution_conditions": args.execution_note,
            "files": 79,
            "machine": {"platform": platform.platform(), "memory_bytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")},
            "source_sha256": {str(file.relative_to(Path(__file__).resolve().parents[1])): hashlib.sha256(file.read_bytes()).hexdigest()
                              for file in (Path(__file__).resolve().parents[1] / "backend/symbiknow").rglob("*.py")},
            "parent_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "attempts": attempts,
            "internal_retrieval_retries": sum(row.get("metrics", {}).get("retrieval_retries", 0) for row in attempts),
            "preparation_internal_retries": sum(row.get("metrics", {}).get("retrieval_retries", 0) for row in attempts if not row.get("publication_overlap")),
            "preparation_errors": sum(row["kind"] == "preparation_error" for row in attempts),
            "publication_invalidations": sum(row["kind"] == "publication_invalidation" for row in attempts),
            "exact_final_organization": True,
            "manual_override_preserved": True,
            "rebuild_rounds": rounds,
            "requested_overlapping_attempts": args.attempts,
            "rebuild_wall_seconds": rebuild_elapsed,
            "compact_first_page_79": summary(page_samples),
            "compact_continuation_79": summary(continuation_samples)
            if continuation_samples
            else None,
            "model": "deterministic fixture vectors; organization mocked",
            "real_components": [
                "OCFL originals",
                "LanceDB retrieval/publication",
                "full reset/rebuild worker",
            ],
            "idle_keyword": summary(idle),
            "active_keyword": summary(samples) if samples else None,
            "active_keyword_retry_required": summary(conflicts) if conflicts else None,
            "active_keyword_attempts": len(samples) + len(conflicts),
            "active_keyword_retry_count": len(conflicts),
            "active_library": summary(listing),
            "reset_clear_ms": clear_ms,
            "rebuild_completed": len(rebuild.status()["completed_ids"]),
            "limits": "Direct backend requests, not browser/network/provider latency; no real-model or live 79-file timing claim.",
        }
        destination = args.output.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2))
        print(json.dumps({key: value for key, value in report.items() if key not in {"attempts", "source_sha256"}}), flush=True)


if __name__ == "__main__":
    main()
