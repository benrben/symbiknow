#!/usr/bin/env python3
"""Isolated conversion parity/timing; no embedding model, original library or paid provider.

Default Markdown/HTML workload needs no OCR weights. --heavy adds a one-page PNG
and scanned PDF and uses the same OCR configuration as production. Exact artifact
hits are reported separately from new-source warm worker conversions.
"""

import argparse
from datetime import datetime, timezone
import os
import hashlib
import json
from pathlib import Path
import platform
import statistics
import sys
import tempfile
import time
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

load_dotenv(REPO / ".env")
os.environ["HF_HOME"] = str(REPO / "data/models")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

from symbiknow.ingestion.conversion.manager import ConversionManager  # noqa: E402
from symbiknow.ingestion.artifacts import ExtractionArtifacts, extraction_descriptor  # noqa: E402


def run(trials, heavy=False):
    from docling_core.types.doc import DoclingDocument

    samples = []
    with tempfile.TemporaryDirectory(prefix="symbiknow-conversion-benchmark-") as directory:
        root = Path(directory)
        sources = []
        for trial in range(trials):
            text = f"Original Project Atlas evidence {trial}. Versions and page coordinates remain intact."
            for extension, body in [("md", f"# Atlas\n\n{text}\n"),
                                    ("html", f"<h1>Atlas</h1><p>{text}</p>")]:
                source = root / f"source-{trial}.{extension}"
                source.write_text(body)
                sources.append(source)
        if heavy:
            from PIL import Image, ImageDraw
            for trial in range(trials):
                image = Image.new("RGB", (800, 300), "white")
                ImageDraw.Draw(image).text((30, 30), f"PROJECT ATLAS {trial}: Original evidence", fill="black", font_size=28)
                for extension in ["png", "pdf"]:
                    source = root / f"source-{trial}.{extension}"
                    image.save(source)
                    sources.append(source)
                image.close()
        expected = {}
        for mode, jobs in [("cold_worker", 1), ("reused_worker_new_source", 16)]:
            manager = ConversionManager(max_jobs=jobs)
            try:
                for ordinal, source in enumerate(sources):
                    output = root / f"{mode}-{ordinal}"
                    output.mkdir()
                    started = time.perf_counter()
                    result = manager.convert(source, output, source.name,
                                             heavy=source.suffix in {".pdf", ".png"})
                    seconds = time.perf_counter() - started
                    document = DoclingDocument.load_from_json(output / "document.json")
                    canonical = document.model_dump(mode="json")
                    if mode == "cold_worker":
                        expected[source.name] = canonical
                    elif canonical != expected[source.name]:
                        raise AssertionError(f"Extraction parity changed for {source.name}")
                    samples.append(dict(mode=mode, format=source.suffix, ordinal=ordinal,
                                        seconds=seconds, rss_bytes=result["rss_bytes"],
                                        partial=result["partial"], worker_starts=manager.starts,
                                        parity=True))
            finally:
                manager.close()
        artifacts = ExtractionArtifacts(root)
        for source in sources:
            mime = {".md": "text/markdown", ".html": "text/html", ".pdf": "application/pdf", ".png": "image/png"}[source.suffix]
            metadata = dict(filename=source.name, version="v1", mime_type=mime)
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            artifacts.document(metadata, digest, lambda: (DoclingDocument.model_validate(expected[source.name]), []))
            started = time.perf_counter()
            document, _ = artifacts.document(metadata, digest, lambda: (_ for _ in ()).throw(AssertionError("artifact miss")))
            samples.append(dict(mode="exact_artifact_hit", format=source.suffix,
                                seconds=time.perf_counter() - started,
                                parity=document.model_dump(mode="json") == expected[source.name]))
    groups = {}
    for sample in samples:
        groups.setdefault((sample["mode"], sample["format"]), []).append(sample["seconds"])
    return dict(date=datetime.now(timezone.utc).isoformat(),
                source_sha256={str(path.relative_to(Path(__file__).resolve().parents[2])): hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in [Path(__file__).resolve(), *(Path(__file__).resolve().parents[2] / "backend/symbiknow").rglob("*.py")]},
                machine=dict(platform=platform.platform(), python=platform.python_version(),
                             memory_bytes=os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")),
                descriptor=extraction_descriptor(), trials=trials,
                limits=dict(worker_rss_bytes=512 * 1024**2, max_jobs=16, heavy_retained=False, idle_seconds=15),
                scope="Conversion only, no model inference; successful/error samples separate; startup retained in reused samples",
                samples=samples,
                summary=[dict(mode=key[0], format=key[1], count=len(values),
                              p50_seconds=statistics.median(values), max_seconds=max(values))
                         for key, values in groups.items()])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--heavy", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.trials < 1:
        parser.error("--trials must be positive")
    report = run(args.trials, args.heavy)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report["summary"], indent=2))
