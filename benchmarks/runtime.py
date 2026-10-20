"""Isolated real-runtime timings; never uses or modifies the live library."""

from pathlib import Path
import os
import sys
import time
import json
import statistics
import tempfile
import base64
import uuid
import functools
import argparse
import hashlib
import platform
import resource
from datetime import datetime, timezone
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

REPO = Path(__file__).resolve().parents[1]
from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO / ".env")
rocfl = Path(os.environ.get("ROCFL_BIN", str(REPO / ".tools/native/bin/rocfl")))
os.environ["ROCFL_BIN"] = str((REPO / rocfl).resolve() if not rocfl.is_absolute() else rocfl)
os.environ["HF_HOME"] = str(REPO / "data/models")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["SYMBIKNOW_V23_SHADOW"] = "0"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--samples", type=int, default=30)
parser.add_argument("--source-root", type=Path, default=REPO,
                    help="Import app from this checkout; weights and .env still come from the runner workspace")
parser.add_argument("--reference-pair", type=Path,
                    help="Native-vision probe: raw supplemental results.json whose input hashes must match")
parser.add_argument("--historical-source", type=Path,
                    help="Native-vision probe: archived app source for historical preprocessing")
parser.add_argument(
    "--provider", action="store_true", help="Spend hosted-provider calls on synthetic evidence"
)
parser.add_argument("--profile", action="store_true", help="Profile separately after timed samples")
ARGS = parser.parse_args()
SOURCE = ARGS.source_root.resolve()
if not (SOURCE / "backend/symbiknow").is_dir():
    parser.error("--source-root must contain backend/symbiknow/")
sys.path.insert(0, str(SOURCE / "backend"))
OUT = ARGS.output.resolve()
OUT.mkdir(parents=True, exist_ok=True)
TRACE = ContextVar("benchmark_trace", default=None)
MODEL = None
report = {
    "date": datetime.now(timezone.utc).isoformat(),
    "scope": "Isolated synthetic library, real configured model, real OCFL/LanceDB and hosted Jev. No live-library changes.",
    "runs": [],
    "failures": [],
    "source_root": str(SOURCE),
    "memory_scope": "RSS is the OS process-lifetime high water (parent and exited children), not an incremental per-operation allocation. Model allocator statistics are sampled after each measured group outside its timing window.",
    "runner_sha256": {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                      for path in [Path(__file__).resolve(), REPO / "benchmarks/supplemental.py"]},
    "source_sha256": {
        str(path.relative_to(SOURCE)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((SOURCE / "backend/symbiknow").rglob("*.py"))
    },
    "reference_machine": {
        "platform": platform.platform(),
        "processor": platform.processor(),
        "memory_bytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
    },
}


def fixture_uuid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "symbiknow:performance-fixture:" + name))


def save_fixture(storage, root, content, filename, **kwargs):
    """Stable original identity and upload receipt across archived/current backends."""
    kwargs.setdefault("document_id", fixture_uuid("document:" + filename))
    kwargs.setdefault("request_id", fixture_uuid("upload:" + filename))
    return storage.save_file(root, content, filename, **kwargs)


def clear_vectors(model):
    """Evict derived vectors while retaining weights; old backends have no cache."""
    clear = getattr(model, "_clear_vectors", None)
    if clear is not None:
        clear()


def vector_stats(model):
    return model.stats().get("vector_caches", {"supported": False})


def flush():
    (OUT / "results.json").write_text(json.dumps(report, indent=2) + "\n")


def instrument(obj, attr, label):
    original = getattr(obj, attr)

    @functools.wraps(original)
    def wrapped(*args, **kwargs):
        start = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            trace = TRACE.get()
            if trace is not None:
                item = trace.setdefault(label, {"seconds": 0, "calls": 0})
                item["seconds"] += time.perf_counter() - start
                item["calls"] += 1

    setattr(obj, attr, wrapped)


def measure(label, fn, n=1, warmups=0):
    for _ in range(warmups):
        fn()
    samples, result = [], None
    print("START " + label, flush=True)
    for _ in range(n):
        trace = {}
        token = TRACE.set(trace)
        start = time.perf_counter()
        try:
            result = fn()
            elapsed = time.perf_counter() - start
            item = {"seconds": elapsed, "trace": trace}
            if isinstance(result, dict):
                if "metrics" in result:
                    item["metrics"] = result["metrics"]
                for k in (
                    "status",
                    "index_error",
                    "chunk_count",
                    "searchable_text",
                    "searchable_visual",
                ):
                    if k in result:
                        item[k] = result[k]
                if "evaluation" in result:
                    item["evaluation"] = result["evaluation"]
                if "answer" in result:
                    item["answer_status"] = result["answer"].get("status")
                if "matches" in result:
                    item["match_count"] = len(result["matches"])
                    item["ordered_results"] = [
                        [
                            m["filename"],
                            m["version"],
                            [e["evidence_id"] for e in m.get("evidence", [])],
                        ]
                        for m in result["matches"]
                    ]
                if result.get("status") in ("failed", "error", "not_evaluated"):
                    report["failures"].append({"label": label, "status": result.get("status")})
            samples.append(item)
        except Exception as exc:
            elapsed = time.perf_counter() - start
            samples.append({"seconds": elapsed, "error_type": type(exc).__name__, "trace": trace})
            report["failures"].append({"label": label, "error_type": type(exc).__name__})
            print("FAILED " + label + ": " + type(exc).__name__, flush=True)
        finally:
            TRACE.reset(token)
    failures = [s for s in samples if "error_type" in s or s.get("status") in {"failed", "error"}]
    durations = sorted(s["seconds"] for s in samples if s not in failures)
    entry = {
        "label": label,
        "n": len(samples),
        "successes": len(durations),
        "errors": len(failures),
        "median_seconds": statistics.median(durations) if durations else None,
        "p95_seconds": durations[int(0.95 * (len(durations) - 1))] if durations else None,
        "min_seconds": min(durations) if durations else None,
        "max_seconds": max(durations) if durations else None,
        "parent_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "child_peak_rss_bytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
        "samples": samples,
    }
    if MODEL is not None:
        entry["model_after_measurement"] = MODEL.stats()
    report["runs"].append(entry)
    flush()
    print(
        f"DONE {label}: {entry['median_seconds']}s ({len(durations)} successes, {len(failures)} errors)",
        flush=True,
    )
    return result


def main():
    global MODEL
    import platform
    import importlib.metadata
    import torch

    report["environment"] = {
        "platform": platform.platform(),
        "mps": torch.backends.mps.is_available(),
        "quantization": os.getenv("SYMBIKNOW_TORCH_QUANTIZATION"),
        "packages": {
            p: importlib.metadata.version(p)
            for p in ("torch", "lancedb", "docling", "typesafe-sdk")
        },
    }
    assert torch.backends.mps.is_available(), "GPU unavailable; do not substitute CPU timings"
    with tempfile.TemporaryDirectory(prefix="symbiknow-performance-") as temporary:
        root = Path(temporary)
        os.environ["SYMBIKNOW_DATA_DIR"] = str(root)
        start = time.perf_counter()
        from symbiknow.api import mcp as server
        from symbiknow.library import storage
        from symbiknow.search import index as search
        from symbiknow.ingestion import service as ingest
        from symbiknow.embeddings import runtime as embeddings
        from symbiknow.organization import policy as organization
        from symbiknow.api import http as ui
        from symbiknow.ai import jev

        report["backend_import_seconds"] = time.perf_counter() - start
        server.DATA_DIR = root
        server.STORAGE_ONLY = False
        for obj, attr, label in [
            (storage, "_run", "ocfl_subprocess"),
            (ingest, "extract_units", "extract_and_chunk"),
            (ingest, "put_chunks", "index_write"),
            (ingest, "mark_pending", "mark_pending"),
            (ingest, "set_document_status", "status_write"),
            (embeddings.EmbeddingGemma2, "__init__", "model_load"),
            (embeddings.EmbeddingGemma2, "encode", "model_inference"),
            (embeddings.ModelManager, "embed_documents", "text_embedding"),
            (embeddings.ModelManager, "embed_query", "query_embedding"),
            (embeddings.ModelManager, "embed_images", "image_embedding"),
            (embeddings.ModelManager, "job_boundary", "model_job_cleanup"),
            (embeddings.ModelManager, "conversion_boundary", "model_preconversion_unload"),
            (jev, "_call", "jev_api_call"),
        ]:
            instrument(obj, attr, label)
        model = embeddings.get_embedder()
        MODEL = model
        report["runtime"] = embeddings.descriptor()
        report["query_vector_cache_supported"] = hasattr(model, "_clear_vectors")
        measure("storage_initialize", lambda: storage.init_storage(root))
        measure("embedding_query_cold", lambda: model.embed_query("What is the capital of France?"))
        def uncached_query():
            clear_vectors(model)
            return model.embed_query("What is the capital of France?")

        measure("embedding_query_warm_uncached_vectors", uncached_query, n=ARGS.samples)
        measure("embedding_query_repeated_input", lambda: model.embed_query(
            "What is the capital of France?"), n=ARGS.samples)
        for size in (1, 4, 8, 16):
            def document_batch(size=size):
                clear_vectors(model)
                return model.embed_documents(["Paris is the capital of France."] * size, "France")

            measure(f"embedding_document_batch_{size}_uncached_vectors", document_batch, n=5)
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (1200, 1600), "white")
        draw = ImageDraw.Draw(image)
        draw.text((100, 300), "PARIS IS THE CAPITAL OF FRANCE", fill="black", font_size=45)
        draw.text(
            (100, 450), "Harbor stores every original file version.", fill="black", font_size=40
        )
        png, pdf = BytesIO(), BytesIO()
        image.save(png, format="PNG")
        # Pillow otherwise stamps wall-clock dates into identical PDF pixels.
        image.save(pdf, format="PDF", creationDate=time.gmtime(0), modDate=time.gmtime(0))
        fixtures = [
            (
                "france.txt",
                b"Paris is the capital of France. Harbor stores every original file version.",
            ),
            (
                "policy.md",
                b"# Harbor / Storage\n\nHarbor stores every original file version. Backups preserve the files.",
            ),
            (
                "policy.html",
                b"<html><body><h1>Harbor storage</h1><p>Harbor stores every original file version.</p></body></html>",
            ),
            ("france.png", png.getvalue()),
            ("france.pdf", pdf.getvalue()),
        ]
        report["inputs"] = {filename: dict(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
                            for filename, content in fixtures}
        metadata = []
        for filename, content in fixtures:
            meta = measure("store_" + filename, lambda: save_fixture(storage, root, content, filename))
            metadata.append(meta)
            measure("ingest_" + filename, lambda: ingest.index_document(root, meta, content))
        # A second image/PDF exposes recurring worker startup and vision reload costs.
        for filename, content in fixtures[-2:]:
            meta = save_fixture(storage, root, content, "repeat-" + filename)
            metadata.append(meta)
            measure("ingest_repeat_" + filename, lambda: ingest.index_document(root, meta, content))

        # 24 short documents make full-window validation and concurrency measurable.
        def build_corpus():
            for i in range(24):
                content = f"Harbor storage policy {i}. Harbor stores every original file version. Policy {i} requires daily backups and integrity checks.".encode()
                meta = save_fixture(storage, root, content, f"policy-{i:02}.txt")
                state = ingest.index_document(root, meta, content)
                assert state["status"] == "indexed", state["status"]
                metadata.append(meta)
            return {"documents": 24}

        measure("ingest_24_text_documents_total", build_corpus)
        report["library_documents"] = len(metadata)
        measure("index_maintenance", lambda: search.maintain_index(root))
        query = "Harbor original file version"
        for mode in ("keyword", "semantic", "hybrid"):
            measure(
                "search_" + mode + "_first",
                lambda mode=mode: server.search(query, mode=mode, limit=8, detail="full"),
            )
            measure(
                "search_" + mode + "_warm_8_results",
                lambda mode=mode: server.search(query, mode=mode, limit=8, detail="full"),
                n=ARGS.samples,
            )
        upload_requests = iter(fixture_uuid(f"api-upload:{i}") for i in range(3))
        measure(
            "search_hybrid_full_31_results",
            lambda: server.search(query, mode="hybrid", limit=31, detail="full"),
            n=5,
        )
        page = measure(
            "search_hybrid_compact_first_page",
            lambda: server.search(query, mode="hybrid", limit=31, detail="compact"),
            n=5,
        )
        if page and page.get("page", {}).get("continuation"):
            cursor = page["page"]["continuation"]
            measure(
                "search_compact_continuation",
                lambda: server.search(
                    query, mode="hybrid", limit=31, detail="compact", continuation=cursor
                ),
                n=5,
            )
        # Individual latency samples under synchronized overlapping requests.
        import threading

        concurrent = []

        def simultaneous(barrier):
            barrier.wait()
            start = time.perf_counter()
            result = server.search(query, mode="hybrid", limit=8, detail="full")
            return {"seconds": time.perf_counter() - start, "metrics": result["metrics"]}

        print("START concurrent search", flush=True)
        with ThreadPoolExecutor(max_workers=4) as pool:
            for _ in range(5):
                barrier = threading.Barrier(4)
                futures = [pool.submit(simultaneous, barrier) for _ in range(4)]
                concurrent.extend(f.result() for f in futures)
        durations = [s["seconds"] for s in concurrent]
        report["runs"].append(
            {
                "label": "search_hybrid_4_concurrent_per_request",
                "n": len(durations),
                "median_seconds": statistics.median(durations),
                "min_seconds": min(durations),
                "max_seconds": max(durations),
                "samples": concurrent,
            }
        )
        flush()
        measure("library_list_first", lambda: ui.library({"limit": "60"}))
        measure("library_list_warm", lambda: ui.library({"limit": "60"}), n=ARGS.samples)
        doc = metadata[0]
        identity = doc["document_id"]
        measure("document_detail_full", lambda: ui.detail(identity), n=ARGS.samples)
        measure(
            "document_detail_summary",
            lambda: ui.detail(identity, section="summary"),
            n=ARGS.samples,
        )
        measure(
            "document_evidence",
            lambda: search.document_evidence(root, identity, "v1"),
            n=ARGS.samples,
        )
        measure(
            "original_download",
            lambda: server.download([{"document_id": identity}]),
            n=ARGS.samples,
        )
        measure(
            "storage_head_check", lambda: storage.current_version(root, identity), n=ARGS.samples
        )
        measure("storage_history", lambda: storage.list_versions(root, identity), n=ARGS.samples)
        image_id = metadata[3]["document_id"]
        pdf_id = metadata[4]["document_id"]
        measure("image_thumbnail_first", lambda: ui.thumbnail(image_id, "v1"))
        measure("image_thumbnail_cached", lambda: ui.thumbnail(image_id, "v1"), n=5)
        measure("pdf_page_first", lambda: ui.pdf_page(pdf_id, "v1", 1))
        measure("pdf_page_cached", lambda: ui.pdf_page(pdf_id, "v1", 1), n=5)
        measure(
            "upload_api_single_text",
            lambda: server.upload(
                [
                    {
                        "filename": "upload.txt",
                        "content_base64": base64.b64encode(b"Harbor upload benchmark").decode(),
                        "request_id": next(upload_requests),
                    }
                ]
            ),
            n=3,
        )
        measure(
            "upload_folder_3_files",
            lambda: server.upload_folder(
                "Benchmark / Uploads",
                [
                    {
                        "relative_path": f"subdir/file-{i}.txt",
                        "content_base64": base64.b64encode(b"Harbor folder benchmark").decode(),
                    }
                    for i in range(3)
                ],
                fixture_uuid("api-folder:Benchmark / Uploads"),
            ),
        )
        export = measure(
            "download_folder_zip_first", lambda: server.download_folder("Benchmark / Uploads")
        )
        if export and export.get("transfer_id"):
            measure(
                "download_folder_zip_cached",
                lambda: server.download_folder(
                    "Benchmark / Uploads", transfer_id=export["transfer_id"]
                ),
                n=5,
            )
        profiles = {
            m["document_id"]: search.document_evidence(root, m["document_id"], "v1")
            for m in metadata
        }
        common = measure(
            "organization_common_lines_31_docs", lambda: organization.common_lines(profiles), n=5
        )
        generated = measure(
            "organization_prose_paths_31_docs",
            lambda: organization.prose_paths(profiles, common),
            n=5,
        )
        vocabulary, _ = organization.shared_vocabulary(profiles, common=common, generated=generated)
        measure(
            "organization_embedding_candidates_31_docs",
            lambda: organization.embedding_candidates(
                root, profiles, vocabulary, common, generated
            ),
            n=5,
        )
        measure(
            "organization_neighbors",
            lambda: search.organization_neighbors(root, doc, profiles[identity]),
            n=5,
        )
        # Small fresh hosted workloads, synthetic evidence only.
        if ARGS.provider and os.getenv("TYPESAFE_API_KEY"):
            from symbiknow.ai import proof as jev_proof
            from symbiknow.ai import numeric as jev_numeric

            def uncached_answer():
                jev_proof._CACHE.clear()
                if hasattr(jev_numeric, "_CACHE"):
                    jev_numeric._CACHE.clear()
                return server.search(
                    "What is the capital of France?", mode="answer", limit=3, detail="full"
                )

            measure("answer_search_uncached_provider", uncached_answer, n=3)
            measure(
                "answer_search_cached_provider",
                lambda: server.search(
                    "What is the capital of France?", mode="answer", limit=3, detail="full"
                ),
                n=5,
            )
            measure(
                "jev_organize_one_document",
                lambda: jev.organize_document(
                    doc, profiles[identity], [], folders=vocabulary["folders"]
                ),
                n=3,
            )
        # Profile a representative warm search separately; profiling overhead excluded above.
        if ARGS.profile:
            import cProfile
            import pstats

            profiler = cProfile.Profile()
            profiler.enable()
            for _ in range(3):
                server.search(query, mode="hybrid", limit=8, detail="full")
            profiler.disable()
            profiler.dump_stats(str(OUT / "search.prof"))
            with (OUT / "search-profile.txt").open("w") as stream:
                pstats.Stats(profiler, stream=stream).strip_dirs().sort_stats(
                    "cumulative"
                ).print_stats(40)
        report["vector_cache_final"] = vector_stats(model)
        measure("embedding_forced_unload", lambda: model.unload(force=True))
        measure("embedding_reload_query", lambda: model.embed_query(query))
        model.unload(force=True)
        report["idle_model"] = model.stats()
        report["completed"] = True
        flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        report["fatal_error"] = {"type": type(exc).__name__, "message": str(exc)[:400]}
        flush()
        raise
