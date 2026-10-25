"""Full HTTP-route contention probe using temporary real OCFL originals.

No live library, socket, model, provider, or application-lifespan startup is used.
Gates pause a lower-level operation, not the whole service, so real lock scopes
and HTTP threadpool dispatch remain active. Results distinguish a delayed read
from extraction/rendering that should leave unrelated reads responsive.
"""

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import hashlib
from io import BytesIO
import json
import logging
from pathlib import Path
import sys
import tempfile
import threading
import time
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

import httpx2  # noqa: E402
from lancedb.table import LanceTable  # noqa: E402
import pyarrow as pa  # noqa: E402
from PIL import Image  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import Route  # noqa: E402

from symbiknow.api import http as ui  # noqa: E402
from symbiknow.api import mcp as server  # noqa: E402
from symbiknow.core.application import ApplicationContext  # noqa: E402
from symbiknow.ingestion import service as ingestion  # noqa: E402
from symbiknow.library import storage  # noqa: E402
from symbiknow.organization import readmodel  # noqa: E402
from symbiknow.search import index  # noqa: E402


def fixture(root):
    context = ApplicationContext(root)
    first = storage.save_file(root, b"Slow operation source.", "slow.txt")
    other = storage.save_file(root, b"Unrelated original remains readable.", "other.txt")
    content = BytesIO()
    Image.new("RGB", (12, 12), "blue").save(content, format="PNG")
    image = storage.save_file(root, content.getvalue(), "preview.png")
    for metadata in (first, other, image):
        index.mark_pending(root, metadata)
    readmodel.initialize(root)
    # A queued status poll is representative of the common no-result job poll.
    queued = context.jobs.start("search", {"query": "fixture", "mode": "keyword"})
    return context, first, other, image, queued


def evidence_rows(metadata):
    return [
        {
            "chunk_id": metadata["document_id"] + ":v1:t0",
            "text": "Slow operation source.",
            "basis": "text",
            "provenance_json": "{}",
            "vector": [1.0, 0.0],
        }
    ]


async def probe(root, *, hold_seconds=0.75, scenarios=None):
    context, first, other, image, queued = fixture(root)
    app = Starlette(routes=[Route("/api/{action}", ui.api, methods=["GET", "POST"])])
    app.add_middleware(ui.LocalProtection)
    endpoints = {
        "progress": ("progress", {}),
        "library": ("library", {"limit": 60}),
        "summary": ("document", {"id": other["document_id"], "section": "summary"}),
        "card": ("card", {"id": other["document_id"], "version": "v1"}),
        "original": ("original", {"id": other["document_id"], "version": "v1"}),
        "job": ("job", {"id": queued["job_id"]}),
        "decisions": ("jev-decisions", {}),
    }
    results = {}

    with (
        ExitStack() as cleanup,
        patch.object(server, "DATA_DIR", root),
        patch.object(server, "application", return_value=context),
        ThreadPoolExecutor(max_workers=1) as workers,
    ):
        cleanup.callback(storage.close_readers)
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1"
        ) as browser:

            async def request(name):
                action, params = endpoints[name]
                started = time.perf_counter()
                response = await browser.get("/api/" + action, params=params)
                response.raise_for_status()
                if name == "original":
                    assert response.content == b"Unrelated original remains readable."
                elif name == "library":
                    assert response.json()["total"] >= 3
                    assert other["document_id"] in {
                        row["document_id"] for row in response.json()["documents"]
                    }
                elif name == "summary":
                    assert response.json()["document"]["document_id"] == other["document_id"]
                    assert response.json()["current_version"] == "v1"
                return {
                    "milliseconds": (time.perf_counter() - started) * 1000,
                    "status": response.status_code,
                }

            results["baseline"] = dict(
                zip(endpoints, await asyncio.gather(*(request(name) for name in endpoints)))
            )
            for scenario in scenarios or (
                "history",
                "evidence-scan",
                "csv-card",
                "extraction",
                "preview",
                "index-publication",
                "commit",
            ):
                entered, release = threading.Event(), threading.Event()

                def gate():
                    entered.set()
                    if not release.wait(20):
                        raise TimeoutError("Contention probe did not release its fixture gate")

                with ExitStack() as patches:
                    if scenario == "history":
                        original = context.originals.history_page

                        def history(*args, **kwargs):
                            gate()
                            return original(*args, **kwargs)

                        patches.enter_context(
                            patch.object(context.originals, "history_page", history)
                        )

                        def operation():
                            return context.library.detail(first["document_id"])
                    elif scenario == "extraction":

                        def extract(*args, **kwargs):
                            gate()
                            return [], [], []

                        patches.enter_context(patch.object(ingestion, "extract_units", extract))

                        def operation():
                            return ingestion.index_document(
                                root, first, b"Slow operation source.", embedder=object()
                            )
                    elif scenario == "evidence-scan":
                        index.put_chunks(root, first, evidence_rows(first), "fixture")
                        original_count = LanceTable.count_rows

                        def count(table, filter=None):
                            if (
                                filter
                                and first["document_id"] in filter
                                and "active = true" in filter
                            ):
                                gate()
                            return original_count(table, filter)

                        patches.enter_context(patch.object(LanceTable, "count_rows", count))

                        def operation():
                            return context.library.detail(first["document_id"])
                    elif scenario == "csv-card":
                        csv = storage.save_file(root, b"name,value\nfixture,42\n", "card.csv")
                        index.mark_pending(root, csv)
                        original_read = storage._RangeReader.read

                        def read(reader, offset, length):
                            if reader.metadata["document_id"] == csv["document_id"]:
                                gate()
                            return original_read(reader, offset, length)

                        patches.enter_context(patch.object(storage._RangeReader, "read", read))

                        def operation():
                            return context.library.card(csv["document_id"], "v1")
                    elif scenario == "preview":
                        original_thumbnail = Image.Image.thumbnail

                        def thumbnail(self, *args, **kwargs):
                            gate()
                            return original_thumbnail(self, *args, **kwargs)

                        patches.enter_context(patch.object(Image.Image, "thumbnail", thumbnail))
                        context.jobs.start(
                            "preview", {"document_id": image["document_id"], "version": "v1"}
                        )

                        def operation():
                            return context.jobs.process_one(("preview",))
                    elif scenario == "index-publication":
                        schema = pa.schema(
                            [
                                ("chunk_id", pa.string()),
                                ("text", pa.string()),
                                ("basis", pa.string()),
                                ("provenance_json", pa.string()),
                                ("vector", pa.list_(pa.float32(), 2)),
                            ]
                        )

                        def batches():
                            gate()
                            yield pa.RecordBatch.from_pylist(evidence_rows(first), schema=schema)

                        def operation():
                            return index.put_chunks(
                                root,
                                first,
                                pa.RecordBatchReader.from_batches(schema, batches()),
                                "fixture",
                            )
                    elif scenario == "commit":
                        original_run = storage._run

                        def native(root, *args, **kwargs):
                            if args[0] == "commit":
                                gate()
                            return original_run(root, *args, **kwargs)

                        patches.enter_context(patch.object(storage, "_run", native))

                        def operation():
                            return storage.save_file(root, b"New unrelated document.", "new.txt")
                    else:
                        raise ValueError("Unknown contention scenario: " + scenario)
                    background = workers.submit(operation)
                    tasks = {}
                    try:
                        assert await asyncio.to_thread(entered.wait, 10), scenario
                        tasks = {name: asyncio.create_task(request(name)) for name in endpoints}
                        await asyncio.wait(tasks.values(), timeout=hold_seconds)
                        completed = {name: task.done() for name, task in tasks.items()}
                    finally:
                        release.set()
                        await asyncio.to_thread(background.result, 20)
                    results[scenario] = {}
                    for name, task in tasks.items():
                        results[scenario][name] = {
                            **await task,
                            "completed_while_work_blocked": completed[name],
                        }
    return results


def main():
    logging.getLogger("httpx2").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hold-seconds", type=float, default=0.75)
    args = parser.parse_args()
    if not 0.1 <= args.hold_seconds <= 10:
        parser.error("--hold-seconds must be between .1 and 10")
    with tempfile.TemporaryDirectory(prefix="symbiknow-http-contention-") as temporary:
        results = asyncio.run(probe(Path(temporary), hold_seconds=args.hold_seconds))
    report = {
        "scope": __doc__,
        "hold_seconds": args.hold_seconds,
        "operations": results,
        "source_sha256": {
            str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (REPO / "backend/symbiknow").rglob("*.py")
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for scenario, endpoints in results.items():
        print(
            scenario, {name: round(value["milliseconds"], 1) for name, value in endpoints.items()}
        )


if __name__ == "__main__":
    main()
