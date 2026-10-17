"""79-file isolated publication benchmark; real OCFL/LanceDB, fixture model/decisions.

Measures Keyword retrieval during full organization reset/rebuild. No live-library
access, provider requests, or target-scale capacity claim.
"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from app import jev, rebuild, search, server, storage, ui  # noqa: E402
from test_search import FixtureEmbedder  # noqa: E402


def summary(samples):
    samples = sorted(samples)
    return {
        "count": len(samples),
        "p50_ms": statistics.median(samples),
        "p95_ms": samples[int(0.95 * (len(samples) - 1))],
        "max_ms": max(samples),
    }


def main():
    with tempfile.TemporaryDirectory(prefix="symbiknow-review8-benchmark-") as temp:
        root = Path(temp)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        os.environ["TYPESAFE_API_KEY"] = "fixture-no-provider"
        jev.preflight = lambda: None
        search.get_embedder = FixtureEmbedder
        storage.init_storage(root)
        for i in range(79):
            text = (
                f"# Harbor / Storage / Policy {i}\nCanvasrevieweight keeps every original version."
            )
            metadata = storage.save_file(root, text.encode(), f"policy-{i}.txt")
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

        def query():
            start = time.perf_counter()
            result = server.search("Canvasrevieweight", mode="keyword", limit=40)
            assert len(result["matches"]) == 40
            return (time.perf_counter() - start) * 1000

        idle = [query() for _ in range(5)]
        started = threading.Event()

        def worker():
            started.set()
            begin = time.perf_counter()
            rebuild.request(grouping=True, links=False)
            clear_ms = (time.perf_counter() - begin) * 1000
            while rebuild.process_one():
                pass
            return clear_ms

        samples, listing = [], []
        with ThreadPoolExecutor(max_workers=1) as pool:
            work = pool.submit(worker)
            assert started.wait(2)
            while not work.done():
                samples.append(query())
                begin = time.perf_counter()
                assert ui.library({"limit": "1"})["library_total"] == 79
                listing.append((time.perf_counter() - begin) * 1000)
            clear_ms = work.result()
        assert rebuild.status()["status"] == "completed"
        report = {
            "files": 79,
            "model": "deterministic fixture vectors; organization mocked",
            "real_components": [
                "OCFL originals",
                "LanceDB retrieval/publication",
                "full reset/rebuild worker",
            ],
            "idle_keyword": summary(idle),
            "active_keyword": summary(samples),
            "active_library": summary(listing),
            "reset_clear_ms": clear_ms,
            "rebuild_completed": len(rebuild.status()["completed_ids"]),
            "limits": "Direct backend requests, not browser/network/provider latency; no real-model or live 79-file timing claim.",
        }
        destination = (
            Path(__file__).resolve().parents[1]
            / "outputs/review-8-implementation/rebuild-benchmark.json"
        )
        destination.write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
