"""Real-model bounded batching and interactive/background scheduling measurement.

Uses synthetic inputs and the sole configured model owner. No original library,
index, OCR or hosted provider is accessed. Different batches receive the exact
same title/text strings and pixels; vectors and resulting ranks are compared.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import resource
import statistics
import sys
import threading
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from dotenv import load_dotenv  # noqa: E402
import numpy as np  # noqa: E402


def summary(rows):
    values = sorted(row["seconds"] for row in rows)
    return dict(n=len(values), p50_seconds=statistics.median(values),
                p95_seconds=values[int(.95 * (len(values) - 1))], max_seconds=max(values))


def sampled_memory(function):
    """Separate memory pass; five-ms allocator sampling is not a timed trial."""
    stop = threading.Event()
    peaks = {}

    def observe():
        torch = sys.modules.get("torch")
        while True:
            if torch is not None and torch.backends.mps.is_available():
                for name, reader in [("mps_active_bytes", torch.mps.current_allocated_memory),
                                     ("mps_driver_bytes", torch.mps.driver_allocated_memory)]:
                    peaks[name] = max(peaks.get(name, 0), reader())
            if stop.wait(.005):
                break

    thread = threading.Thread(target=observe, daemon=True)
    thread.start()
    try:
        return function(), peaks
    finally:
        stop.set()
        thread.join()
        peaks["host_lifetime_peak_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)


def run(trials, vision, checkpoint=None):
    load_dotenv(REPO / ".env")
    os.environ["HF_HOME"] = str(REPO / "data/models")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    from symbiknow.embeddings import runtime as embeddings

    owner = embeddings.get_embedder()
    report = dict(date=datetime.now(timezone.utc).isoformat(),
                  machine=dict(platform=platform.platform(),
                               memory_bytes=os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")),
                  runtime=embeddings.descriptor(),
                  source_sha256={str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in [Path(__file__).resolve(), *sorted((REPO / "backend/symbiknow").rglob("*.py"))]},
                  scope="Real inference only; conversion, OCR, index and provider excluded. Text batch timing clears bounded vectors before each group without unloading weights; cached query vectors are separate. Host RSS is process-lifetime high water.",
                  trials=trials, samples=[], failures=[])
    texts = [f"Project {ordinal} original file policy. " +
             ("Files preserve versions, checksums, and source provenance. " * (ordinal % 4 + 1))
             for ordinal in range(16)]
    title = "Batch policy"
    report["input_sha256"] = hashlib.sha256(json.dumps([title, texts]).encode()).hexdigest()
    warmup = time.perf_counter()
    query = owner.embed_query("Project 10 original file versions")
    report["cold_query_seconds"] = time.perf_counter() - warmup

    def batch(size):
        # Measure actual warm inference separately from retained normalized-vector hits.
        owner._clear_vectors()
        return np.vstack([owner.embed_documents(texts[start:start + size], title)
                          for start in range(0, len(texts), size)])

    try:
        reference = batch(1)
        ranking = np.argsort(-(reference @ query), kind="stable").tolist()
        rng = random.Random(20261020)
        for trial in range(trials):
            sizes = [1, 4, 8, 16]
            rng.shuffle(sizes)
            for size in sizes:
                started = time.perf_counter()
                vectors = batch(size)
                seconds = time.perf_counter() - started
                cosine = np.sum(vectors * reference, axis=1) / (
                    np.linalg.norm(vectors, axis=1) * np.linalg.norm(reference, axis=1))
                sample = dict(kind="text_batch", batch=size, trial=trial, seconds=seconds,
                              documents_per_second=len(texts) / seconds,
                              max_abs_difference=float(np.max(np.abs(vectors - reference))),
                              min_cosine=float(np.min(cosine)),
                              exact_rank_parity=np.argsort(-(vectors @ query), kind="stable").tolist() == ranking,
                              memory=owner.stats(), host_peak_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024))
                report["samples"].append(sample)
                if sample["min_cosine"] < .99999 or not sample["exact_rank_parity"]:
                    report["failures"].append(dict(kind="text_batch_parity", batch=size, trial=trial))
        for ordinal in range(16):
            owner._clear_vectors()
            started = time.perf_counter()
            owner.embed_query("Repeated cached embedding benchmark")
            report["samples"].append(dict(kind="uncached_query_vector", seconds=time.perf_counter() - started))
        report["vector_cache_before_hit_series"] = owner.stats()["vector_caches"]
        for ordinal in range(16):
            started = time.perf_counter()
            owner.embed_query("Repeated cached embedding benchmark")
            report["samples"].append(dict(kind="cached_query_vector", seconds=time.perf_counter() - started))
        report["vector_cache_after_hit_series"] = owner.stats()["vector_caches"]
        report["memory_passes"] = []
        for size in [1, 4, 8, 16]:
            owner.job_boundary()
            _, peak = sampled_memory(lambda: batch(size))
            report["memory_passes"].append(dict(kind="text_batch", batch=size, sampled_peak=peak,
                                               retained=owner.stats()))
        barrier = threading.Barrier(3)

        def interactive(worker):
            rows = []
            barrier.wait()
            for ordinal in range(8):
                started = time.perf_counter()
                owner.embed_query(f"Worker {worker}, request {ordinal}: original versions")
                rows.append(dict(kind="interactive", seconds=time.perf_counter() - started))
            return rows

        def background():
            rows = []
            barrier.wait()
            for start in range(0, len(texts), 4):
                started = time.perf_counter()
                owner.embed_documents(texts[start:start + 4], title)
                rows.append(dict(kind="background", seconds=time.perf_counter() - started))
            return rows

        with ThreadPoolExecutor(3) as pool:
            futures = [pool.submit(interactive, i) for i in range(2)] + [pool.submit(background)]
            for future in futures:
                report["samples"].extend(future.result())
        if vision:
            from PIL import Image, ImageDraw
            images = []
            for ordinal in range(4):
                image = Image.new("RGB", (512, 256), "white")
                ImageDraw.Draw(image).text((20, 20), texts[ordinal][:80], fill="black", font_size=18)
                images.append(image)
            try:
                # Differential fixture against the previously supported one-image
                # processor call. This is outside every inference timing window.
                processor = embeddings.get_processor()
                previous = processor(images=images[:1], return_tensors="np")
                current = embeddings._features(processor, images[:1], images=True)
                equal = set(previous) == set(current) and all(
                    previous[name].dtype == current[name].dtype and
                    np.array_equal(previous[name], current[name]) for name in previous
                )
                report["single_image_preprocessing_parity"] = dict(
                    exact=equal,
                    features={name: dict(shape=list(current[name].shape), dtype=str(current[name].dtype),
                                         sha256=hashlib.sha256(current[name].tobytes()).hexdigest())
                              for name in current},
                )
                del previous, current
                if not equal:
                    report["failures"].append(dict(kind="single_image_preprocessing_parity"))
                started = time.perf_counter()
                owner.embed_images(images[:1])
                report["vision_load_and_first_image_seconds"] = time.perf_counter() - started
                image_reference = np.vstack([owner.embed_images([image]) for image in images])
                for size in [1, 2, 4]:
                    for trial in range(trials):
                        started = time.perf_counter()
                        vectors = np.vstack([owner.embed_images(images[start:start + size])
                                             for start in range(0, len(images), size)])
                        seconds = time.perf_counter() - started
                        cosine = np.sum(vectors * image_reference, axis=1) / (
                            np.linalg.norm(vectors, axis=1) * np.linalg.norm(image_reference, axis=1))
                        report["samples"].append(dict(kind="vision_batch", batch=size, trial=trial,
                                                      seconds=seconds, images_per_second=len(images) / seconds,
                                                      min_cosine=float(np.min(cosine)), memory=owner.stats()))
                        if float(np.min(cosine)) < .99999:
                            report["failures"].append(dict(kind="vision_batch_parity", batch=size, trial=trial))
                for size in [1, 2, 4]:
                    # Diagnostic lease only: preserve the loaded vision model while
                    # clearing allocator caches before its separate memory pass.
                    with owner.lock:
                        owner.runtime.clear()
                    _, peak = sampled_memory(lambda: [owner.embed_images(images[start:start + size])
                                                      for start in range(0, len(images), size)])
                    report["memory_passes"].append(dict(kind="vision_batch", batch=size,
                                                       sampled_peak=peak, retained=owner.stats()))
            finally:
                for image in images:
                    image.close()
            owner.job_boundary()
        report["summaries"] = []
        for kind in ["text_batch", "vision_batch", "uncached_query_vector", "cached_query_vector", "interactive", "background"]:
            for size in sorted({row.get("batch", 0) for row in report["samples"] if row["kind"] == kind}):
                rows = [row for row in report["samples"] if row["kind"] == kind and row.get("batch", 0) == size]
                report["summaries"].append(dict(kind=kind, batch=size, **summary(rows)))
        report["queue"] = owner.stats().get("queue")
        report["completed"] = True
    finally:
        owner.unload(force=True)
        report["idle_memory"] = owner.stats()
        if checkpoint is not None:
            checkpoint.parent.mkdir(parents=True, exist_ok=True)
            checkpoint.write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--vision", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.trials < 1:
        parser.error("--trials must be positive")
    try:
        report = run(args.trials, args.vision, args.output)
    except Exception as exc:
        report = json.loads(args.output.read_text()) if args.output.exists() else {"samples": [], "failures": []}
        report["failures"].append(dict(error_type=type(exc).__name__))
        report["completed"] = False
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
        raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(dict(summaries=report["summaries"], failures=report["failures"]), indent=2))
    raise SystemExit(bool(report["failures"]))
