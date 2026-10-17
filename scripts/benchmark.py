"""Small real-model smoke benchmark; no claim about 100,000-document capacity.

Run: uv run python scripts/benchmark.py --output benchmark.json
The generated fixtures contain no user corpus data. Jev is measured separately.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import resource
import statistics
import subprocess
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw  # noqa: E402

from app.embeddings import get_embedder  # noqa: E402
from app.ingest import index_document  # noqa: E402
from app.search import document_evidence, find_documents  # noqa: E402
from app.storage import init_storage, save_file  # noqa: E402


def benchmark():
    os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[1] / "data" / "models"))
    start = time.perf_counter()
    model = get_embedder()
    load_seconds = time.perf_counter() - start
    image = Image.new("RGB", (1200, 1600), "white")
    draw = ImageDraw.Draw(image)
    draw.text((100, 300), "CAT RESTS ON SOFA", fill="black", font_size=60)
    draw.text((100, 450), "A domestic feline sleeps indoors.", fill="black", font_size=48)
    png, pdf = BytesIO(), BytesIO()
    image.save(png, format="PNG")
    image.save(pdf, format="PDF")
    fixtures = [
        ("cats.md", b"# Cats\n\nA domestic feline sleeps on the sofa."),
        (
            "dogs.html",
            b"<html><body><h1>Dogs</h1><p>The canine dog follows a scent trail.</p></body></html>",
        ),
        ("facts.txt", b"Water freezes at zero degrees Celsius under standard pressure."),
        ("cat.png", png.getvalue()),
        ("cat.pdf", pdf.getvalue()),
    ]
    with tempfile.TemporaryDirectory(prefix="symbiknow-benchmark-") as temp:
        root = Path(temp)
        init_storage(root)
        indexed = []
        for name, content in fixtures:
            start = time.perf_counter()
            metadata = save_file(root, content, name)
            storage_seconds = time.perf_counter() - start
            start = time.perf_counter()
            state = index_document(root, metadata, content, model)
            indexed.append(
                {
                    "filename": name,
                    "size": len(content),
                    "storage_seconds": storage_seconds,
                    "index_seconds": time.perf_counter() - start,
                    "status": state["status"],
                    "text": state.get("searchable_text", False),
                    "visual": state.get("searchable_visual", False),
                    "chunks": state.get("chunk_count", 0),
                    "error": state.get("index_error", ""),
                    "basis": sorted(
                        {e["basis"] for e in document_evidence(root, metadata["document_id"], "v1")}
                    ),
                }
            )
            print(json.dumps(indexed[-1]), flush=True)
        questions = [
            ("domestic pet sleeping indoors", "cats.md"),
            ("canine following a smell", "dogs.html"),
            ("temperature at which water turns into ice", "facts.txt"),
            ("A domestic feline sleeps indoors", "cat.png"),
        ]
        queries = []
        for query, expected in questions:
            durations = []
            for _ in range(3):
                start = time.perf_counter()
                hits = find_documents(root, query, mode="hybrid", limit=3, embedder=model)
                durations.append(time.perf_counter() - start)
            names = [hit["filename"] for hit in hits]
            queries.append(
                {
                    "query": query,
                    "expected": expected,
                    "top3": names,
                    "hit_at_3": expected in names,
                    "top1_correct": bool(names and names[0] == expected),
                    "median_seconds": statistics.median(durations),
                    "samples_seconds": durations,
                }
            )
            print(json.dumps(queries[-1]), flush=True)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    hardware = {}
    if sys.platform == "darwin":
        try:
            hardware = {
                "cpu": subprocess.check_output(
                    ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
                ).strip(),
                "ram_bytes": int(
                    subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
                ),
            }
        except (OSError, subprocess.CalledProcessError):
            hardware = {"cpu": "unverified", "ram_bytes": None}
    return {
        "host": {"platform": platform.platform(), "machine": platform.machine(), **hardware},
        "packages": {
            p: importlib.metadata.version(p)
            for p in (
                "docling",
                "lancedb",
                "sentence-transformers",
                "transformers",
                "torch",
            )
        },
        "model": model.model_id,
        "dimension": model.dimension,
        "device": str(model.model.device),
        "model_load_seconds": load_seconds,
        "process_peak_rss_mib": peak / (1024**2 if sys.platform == "darwin" else 1024),
        "fixtures": indexed,
        "queries": queries,
        "limitations": "Five synthetic fixtures and four questions; not a capacity or broad quality evaluation.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("benchmark.json"))
    args = parser.parse_args()
    result = benchmark()
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Results written to {args.output}")
