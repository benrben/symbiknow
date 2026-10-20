"""Larger-input ingestion, versioning, deletion and in-process HTTP route timings."""

import runtime as b
from pathlib import Path
import os
import tempfile

b.OUT = b.OUT / "supplemental"
b.OUT.mkdir(exist_ok=True)
b.report = {
    "scope": "Separate isolated real-model library; larger synthetic inputs and ASGI HTTP routes. No TCP/browser timing.",
    "runs": [],
    "failures": [],
    "source_sha256": b.report["source_sha256"],
    "source_root": b.report["source_root"],
    "runner_sha256": b.report["runner_sha256"],
    "memory_scope": b.report["memory_scope"],
    "reference_machine": b.report["reference_machine"],
}


def fingerprint(result):
    return [
        [
            m["filename"],
            m["version"],
            [[e.get("text"), e.get("basis"), e.get("provenance")] for e in m.get("evidence", [])],
        ]
        for m in result["matches"]
    ]


def pdf_bytes(pages=10):
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    kids = []
    for p in range(pages):
        page_number = len(objects) + 1
        content_number = page_number + 1
        kids.append(f"{page_number} 0 R")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_number} 0 R >>".encode()
        )
        lines = [f"Harbor storage policy page {p + 1}."] + [
            f"Rule {i + 1}: Harbor keeps original file versions and checks backup integrity."
            for i in range(30)
        ]
        stream = (
            "BT /F1 10 Tf 40 750 Td 20 TL " + " ".join(f"({line}) Tj T*" for line in lines) + " ET"
        ).encode()
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {pages} >>".encode()
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(result)


with tempfile.TemporaryDirectory(prefix="symbiknow-supplemental-") as temporary:
    root = Path(temporary)
    os.environ["SYMBIKNOW_DATA_DIR"] = str(root)
    from symbiknow.api import mcp as server
    from symbiknow.library import storage
    from symbiknow.ingestion import service as ingest
    from symbiknow.embeddings import runtime as embeddings
    from symbiknow.api import http as ui
    import torch

    assert torch.backends.mps.is_available(), "GPU unavailable; do not substitute CPU timings"
    b.report["runtime"] = embeddings.descriptor()

    server.DATA_DIR = root
    server.STORAGE_ONLY = False
    storage.init_storage(root)
    for obj, attr, label in [
        (storage, "_run", "ocfl_subprocess"),
        (ingest, "extract_units", "extract_and_chunk"),
        (ingest, "put_chunks", "index_write"),
        (embeddings.EmbeddingGemma2, "__init__", "model_load"),
        (embeddings.ModelManager, "embed_documents", "text_embedding"),
        (embeddings.ModelManager, "embed_images", "image_embedding"),
    ]:
        b.instrument(obj, attr, label)
    model = embeddings.get_embedder()
    b.MODEL = model
    b.report["query_vector_cache_supported"] = hasattr(model, "_clear_vectors")
    model.embed_query("Harbor")
    long_text = "\n\n".join(
        f"Policy {i}. Harbor stores original file versions and verifies integrity. Backups are checked daily. Retrieval combines keyword and vector searches."
        for i in range(400)
    ).encode()
    pdf = pdf_bytes()
    b.report["inputs"] = {
        "long_text_bytes": len(long_text),
        "native_pdf_bytes": len(pdf),
        "native_pdf_pages": 10,
        "long_text_sha256": b.hashlib.sha256(long_text).hexdigest(),
        "native_pdf_sha256": b.hashlib.sha256(pdf).hexdigest(),
    }
    for filename, content in [("large.txt", long_text), ("native-10-pages.pdf", pdf)]:
        meta = b.save_fixture(storage, root, content, filename)
        b.measure("ingest_" + filename, lambda: ingest.index_document(root, meta, content))
    from starlette.testclient import TestClient

    # No context manager: avoid starting the production indexing/rebuild lifespan.
    client = TestClient(
        ui.create_app(),
        base_url="http://localhost",
        headers={"Origin": "http://localhost", "X-Symbiknow-UI": "1"},
    )

    def http_search():
        response = client.post(
            "/api/search",
            json={
                "query": "Harbor original file version",
                "mode": "hybrid",
                "limit": 8,
                "detail": "full",
            },
        )
        response.raise_for_status()
        return response.json()

    b.measure("http_asgi_search_warm_2_docs", http_search, n=5, warmups=1)
    b.measure(
        "direct_search_warm_2_docs",
        lambda: server.search(
            "Harbor original file version", mode="hybrid", limit=8, detail="full"
        ),
        n=5,
    )

    def http_library():
        response = client.get("/api/library")
        response.raise_for_status()
        return response.json()

    b.measure("http_asgi_library_2_docs", http_library, n=5)
    # Counterbalance search-mode order on the same real-vector corpus.
    for i in range(29):
        content = f"Harbor original file version policy {i}. Backups preserve every original version.".encode()
        m = b.save_fixture(storage, root, content, f"small-{i}.txt")
        state = ingest.index_document(root, m, content)
        assert state["status"] == "indexed"
    import random
    import statistics
    import time

    for cache_policy in ("uncached_query", "repeated_query"):
        modes = ["keyword", "semantic", "hybrid"]
        samples = {mode: [] for mode in modes}
        for mode in modes:
            server.search("Harbor original file version", mode=mode, limit=8, detail="full")
        before = b.vector_stats(model)
        rng = random.Random(20261020)
        for _ in range(b.ARGS.samples):
            rng.shuffle(modes)
            for mode in modes:
                if cache_policy == "uncached_query":
                    b.clear_vectors(model)
                start = time.perf_counter()
                result = server.search(
                    "Harbor original file version", mode=mode, limit=8, detail="full"
                )
                assert len(result["matches"]) == 8
                samples[mode].append(
                    {
                        "seconds": time.perf_counter() - start,
                        "metrics": result["metrics"],
                        "ordered_results": fingerprint(result),
                    }
                )
        after = b.vector_stats(model)
        for mode, rows in samples.items():
            durations = [s["seconds"] for s in rows]
            b.report["runs"].append(
                {
                    "label": f"interleaved_search_{mode}_31_docs_8_results_{cache_policy}",
                    "query_vector_policy": cache_policy,
                    "vector_cache_before_series": before,
                    "vector_cache_after_series": after,
                    "n": len(rows),
                    "median_seconds": statistics.median(durations),
                    "min_seconds": min(durations),
                    "max_seconds": max(durations),
                    "p95_seconds": sorted(durations)[int(0.95 * (len(durations) - 1))],
                    "errors": 0,
                    "samples": rows,
                }
            )
        b.flush()
    import threading
    from concurrent.futures import ThreadPoolExecutor

    for concurrency in (1, 4, 8, 16):
        rows = []

        def simultaneous(barrier):
            barrier.wait()
            start = time.perf_counter()
            try:
                result = server.search(
                    "Harbor original file version", mode="hybrid", limit=8, detail="full"
                )
                return {
                    "seconds": time.perf_counter() - start,
                    "metrics": result["metrics"],
                    "ordered_results": fingerprint(result),
                }
            except Exception as exc:
                return {"seconds": time.perf_counter() - start, "error_type": type(exc).__name__}

        start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            for _ in range(max(1, (b.ARGS.samples + concurrency - 1) // concurrency)):
                barrier = threading.Barrier(concurrency)
                futures = [pool.submit(simultaneous, barrier) for _ in range(concurrency)]
                rows.extend(future.result() for future in futures)
        elapsed = time.perf_counter() - start
        successful = sorted(row["seconds"] for row in rows if "error_type" not in row)
        b.report["runs"].append(
            {
                "label": f"search_concurrency_{concurrency}",
                "query_vector_policy": "repeated_query; misses may coalesce when supported",
                "vector_cache_after_series": b.vector_stats(model),
                "n": len(rows),
                "errors": len(rows) - len(successful),
                "median_seconds": statistics.median(successful) if successful else None,
                "p95_seconds": successful[int(0.95 * (len(successful) - 1))]
                if successful
                else None,
                "max_seconds": max(successful) if successful else None,
                "throughput_per_second": len(successful) / elapsed,
                "samples": rows,
            }
        )
        b.flush()
    meta = b.save_fixture(storage, root, b"original version", "versioned.txt")
    b.measure(
        "save_new_version",
        lambda: storage.save_file(
            root,
            b"updated version",
            "versioned.txt",
            document_id=meta["document_id"],
            request_id=b.fixture_uuid("upload:versioned.txt:v2"),
            expected_version="v1",
        ),
    )
    b.measure(
        "download_with_history_2_versions",
        lambda: server.download([{"document_id": meta["document_id"], "include_versions": True}]),
        n=5,
    )
    b.measure(
        "delete_isolated_document", lambda: storage.delete_document(root, meta["document_id"], "v2")
    )
    b.report["vector_cache_final"] = b.vector_stats(model)
    model.unload(force=True)
    b.report["idle_model"] = model.stats()
    client.close()
    b.report["completed"] = True
    b.flush()
