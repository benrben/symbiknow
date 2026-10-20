"""Actual OCFL/LanceDB capacity with seeded vectors, never model quality claims.

Every source is committed by pinned rocfl and every chunk is physically stored.
Temporary libraries are removed after measurement; the live library is never read.
"""

import argparse
from contextlib import nullcontext
import hashlib
from importlib.metadata import version as package_version
import json
import os
from pathlib import Path
import platform
import resource
import statistics
import subprocess
import sys
import tempfile
import time

import numpy as np
import pyarrow as pa

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
from symbiknow.search import index as search  # noqa: E402
from symbiknow.library import storage  # noqa: E402
from symbiknow.organization import store as organization_store  # noqa: E402
from lancedb.index import FTS  # noqa: E402


def content(number, chunks):
    return "\n\n".join(
        f"Capacity project {number % 10}. Original document {number} paragraph {chunk}. "
        "Harbor preserves independent original versions, searchable evidence and provenance."
        for chunk in range(chunks)
    )


def metadata(number, chunks):
    text = content(number, chunks)
    return {
        "document_id": f"capacity-{number:07}",
        "version": "v1",
        "filename": f"capacity-{number:07}.txt",
        "mime_type": "text/plain",
        "source": "synthetic-capacity",
        "request_id": f"capacity-{number:07}",
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "size": len(text.encode()),
        "created_at": "2026-10-20T00:00:00+00:00",
    }


def vectors(numbers, dimension):
    values = np.zeros((len(numbers), dimension), dtype=np.float32)
    for row, number in enumerate(numbers):
        values[row, int(number) % 10] = 1
        values[row, 10] = 0.1
    return values


class SeededVectors:
    model_id = "capacity-seeded-vectors-not-real-model"

    def __init__(self, dimension):
        self.dimension = dimension

    def embed_query(self, query):
        return vectors([0], self.dimension)[0].tolist()


def summarize(rows):
    success = sorted(row["seconds"] for row in rows if "error" not in row)
    return {
        "successes": len(success),
        "errors": len(rows) - len(success),
        "p50_seconds": statistics.median(success) if success else None,
        "p95_seconds": success[int(0.95 * (len(success) - 1))] if success else None,
        "max_seconds": max(success) if success else None,
        "samples": rows,
    }


def measure(fn, samples):
    rows = []
    for _ in range(samples):
        start = time.perf_counter()
        try:
            result = fn()
            if isinstance(result, list) and not result:
                raise AssertionError("Expected nonempty capacity results")
            rows.append(
                {
                    "seconds": time.perf_counter() - start,
                    "count": len(result) if isinstance(result, list) else None,
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "seconds": time.perf_counter() - start,
                    "error": type(exc).__name__,
                    "message": str(exc)[:300],
                }
            )
    return summarize(rows)


def run(count, args):
    run_started = time.perf_counter()
    marker = {"kind": "symbiknow-capacity-v1", "documents": count,
              "chunks_per_document": args.chunks_per_document, "dimension": args.dimension}
    if args.reuse_root:
        root_path = args.reuse_root.resolve()
        if json.loads((root_path / "benchmark-owner.json").read_text()) != marker:
            raise ValueError("Only an exactly matching benchmark-owned library may be reused")
        owner = nullcontext(str(root_path))
    elif args.keep_root:
        owner = nullcontext(tempfile.mkdtemp(prefix=f"symbiknow-capacity-{count}-"))
    else:
        owner = tempfile.TemporaryDirectory(prefix=f"symbiknow-capacity-{count}-")
    with owner as temporary:
        root = Path(temporary)
        if not args.reuse_root:
            (root / "benchmark-owner.json").write_text(json.dumps(marker))
        print(
            f"START actual library {count} documents / {count * args.chunks_per_document} chunks",
            flush=True,
        )
        if not args.reuse_root:
            started = time.perf_counter()
            with (root / "seed.log").open("wb") as log:
                process = subprocess.Popen(
                    [str(REPO / ".tools/native/bin/symbiknow-seed-library"), str(root / "files")],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=log,
                )
                for number in range(count):
                    process.stdin.write(
                        (
                            json.dumps(
                                {
                                    "metadata": metadata(number, args.chunks_per_document),
                                    "original": content(number, args.chunks_per_document),
                                }
                            )
                            + "\n"
                        ).encode()
                    )
                process.stdin.close()
                native = process.stdout.read()
                if process.wait() != 0:
                    raise RuntimeError((root / "seed.log").read_text()[-2000:])
            seed_seconds = time.perf_counter() - started
            native_seed = json.loads(native)
            db = search._db(root)

            def documents():
                for offset in range(0, count, 256):
                    rows = [
                        search._document_row(
                            metadata(number, args.chunks_per_document),
                            indexed_version="v1",
                            status="indexed",
                            searchable_text=True,
                            chunk_count=args.chunks_per_document,
                            folder=f"Project / Topic {number % 10}" if number % 2 else "",
                            groups=["all"],
                        )
                        for number in range(offset, min(count, offset + 256))
                    ]
                    yield from pa.Table.from_pylist(rows, schema=search.DOCUMENT_SCHEMA).to_batches()

            started = time.perf_counter()
            db.create_table(
                "documents", data=pa.RecordBatchReader.from_batches(search.DOCUMENT_SCHEMA, documents())
            )
            schema = search.chunk_schema(args.dimension)

            def chunks():
                for offset in range(0, count, 64):
                    numbers = list(range(offset, min(count, offset + 64)))
                    entries = [
                        (number, chunk)
                        for number in numbers
                        for chunk in range(args.chunks_per_document)
                    ]
                    vector_values = vectors([number for number, _ in entries], args.dimension)
                    array = pa.FixedSizeListArray.from_arrays(
                        pa.array(vector_values.reshape(-1)), args.dimension
                    )
                    values = {
                        "chunk_id": [f"capacity-{n:07}:v1:t{c}" for n, c in entries],
                        "document_id": [f"capacity-{n:07}" for n, _ in entries],
                        "version": ["v1"] * len(entries),
                        "text": [
                            content(n, args.chunks_per_document).split("\n\n")[c] for n, c in entries
                        ],
                        "basis": ["text"] * len(entries),
                        "provenance_json": [json.dumps({"headings": ["Capacity"]})] * len(entries),
                        "embedding_model": [SeededVectors.model_id] * len(entries),
                        "active": [True] * len(entries),
                        "folder": [""] * len(entries),
                        "groups": [[]] * len(entries),
                    }
                    batch = pa.table(
                        {
                            name: array
                            if name == "vector"
                            else pa.array(values[name], type=schema.field(name).type)
                            for name in schema.names
                        },
                        schema=schema,
                    )
                    yield from batch.to_batches()

            chunks_table = db.create_table(
                "chunks", data=pa.RecordBatchReader.from_batches(schema, chunks())
            )
            chunks_table.create_index("text", config=FTS())
            index_seed_seconds = time.perf_counter() - started
            started = time.perf_counter()
            indexes = search.maintain_index(root)
            index_build_seconds = time.perf_counter() - started
        else:
            db = search._db(root)
            chunks_table = search._table(root, "chunks")
            search._table(root, "documents")
            assert chunks_table.schema.field("vector").type.list_size == args.dimension
            indexes = [str(index) for index in chunks_table.list_indices()]
            native_seed = {"reused_benchmark_root": str(root)}
            seed_seconds = index_seed_seconds = index_build_seconds = None
            if args.rebuild_indexes:
                started = time.perf_counter()
                indexes = search.maintain_index(root)
                index_build_seconds = time.perf_counter() - started
        organization_store.initialize(root)
        assert chunks_table.count_rows() == count * args.chunks_per_document
        assert db.open_table("documents").count_rows() == count
        fixture = {"documents": count, "chunks": count * args.chunks_per_document,
                   "dimension": args.dimension, "native_seed": native_seed,
                   "original_seed_seconds": seed_seconds, "index_seed_seconds": index_seed_seconds,
                   "index_build_seconds": index_build_seconds, "indexes": indexes}
        if not args.reuse_root:
            (root / "fixture-provenance.json").write_text(json.dumps(fixture, default=str))
        if args.prepare_only:
            return {**fixture, "retained_root": str(root), "status": "prepared-not-yet-measured",
                    "parent_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                    "child_peak_rss_bytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                    "total_seconds": time.perf_counter() - run_started}
        original_ids = storage._run(root, "ls", "-ot").decode().splitlines()
        assert len(original_ids) == count
        assert set(original_ids) == {f"capacity-{number:07}" for number in range(count)}
        del original_ids
        model = SeededVectors(args.dimension)

        def retrieve(mode, folder=None):
            rows = search.find_documents(
                root,
                "Harbor independent original versions",
                mode=mode,
                limit=8,
                folder=folder,
                embedder=model,
            )
            assert 0 < len(rows) <= 8
            for row in rows:
                assert row["version"] == "v1" and row["evidence"]
                if folder is not None:
                    assert row["folder"] == folder or (
                        folder and row["folder"].startswith(folder + " / ")
                    )
                number = int(row["document_id"].split("-")[-1])
                original = content(number, args.chunks_per_document)
                assert all(
                    e["text"] in original
                    and e["evidence_id"].startswith(row["document_id"] + ":v1:")
                    for e in row["evidence"]
                )
            return rows

        results = {}
        for mode in ("keyword", "semantic", "hybrid"):
            results[mode] = measure(
                lambda mode=mode: retrieve(mode),
                args.samples,
            )
        for label, folder in [
            ("broad_scope", "Project"),
            ("unfiled", ""),
            ("narrow_scope", "Project / Topic 1"),
        ]:
            results[label] = measure(
                lambda folder=folder: retrieve("keyword", folder),
                args.samples,
            )
        results["browse_first"] = measure(
            lambda: search.browse_documents(root, limit=60)["documents"], args.samples
        )
        results["browse_last"] = measure(
            lambda: search.browse_documents(root, offset=max(0, count - 60), limit=60)["documents"],
            args.samples,
        )
        identities = [f"capacity-{number:07}" for number in range(min(count, 800))]
        results["heads_800"] = measure(
            lambda: list(storage.heads_many(root, identities).values()), args.samples
        )
        from symbiknow.api import mcp as server

        server.DATA_DIR, server.STORAGE_ONLY = root, False
        search.get_embedder = lambda: model
        results["full_shared_search"] = measure(
            lambda: server.search(
                "Harbor independent original versions", mode="hybrid", limit=8, detail="full"
            )["matches"],
            args.samples,
        )
        from symbiknow.api import http as ui
        def library_page():
            result = ui.library({"limit": "60"})
            assert result["library_total"] == count and result["total"] == count
            assert len(result["documents"]) == min(count, 60)
            return result["documents"]
        results["full_library_cold_aggregates"] = measure(library_page, 1)
        results["full_library_warm_page"] = measure(library_page, args.samples)
        for number in (0, count // 2, count - 1):
            data, meta = storage.read_file(root, f"capacity-{number:07}")
            assert data == content(number, args.chunks_per_document).encode()
            assert meta == metadata(number, args.chunks_per_document)
        started = time.perf_counter()
        validation = storage._run(root, "validate", "-l", "error").decode()
        validation_seconds = time.perf_counter() - started
        size = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
        storage.close_readers()
        return {
            "retained_root": str(root) if args.keep_root or args.reuse_root else None,
            "original_object_count_verified": count,
            "fixture_provenance": json.loads((root / "fixture-provenance.json").read_text()) if (root / "fixture-provenance.json").exists() else None,
            "documents": count,
            "chunks": count * args.chunks_per_document,
            "dimension": args.dimension,
            "model": SeededVectors.model_id,
            "native_seed": native_seed,
            "original_seed_seconds": seed_seconds,
            "index_seed_seconds": index_seed_seconds,
            "index_build_seconds": index_build_seconds,
            "indexes": indexes,
            "queries": results,
            "storage_validation": validation,
            "storage_validation_seconds": validation_seconds,
            "stored_bytes": size,
            "stored_bytes_definition": "Sum of logical file lengths including retained Lance versions; excludes filesystem allocation/inode overhead",
            "parent_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "child_peak_rss_bytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
            "total_seconds": time.perf_counter() - run_started,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--documents", nargs="+", type=int, default=[1000, 10000, 100000])
    parser.add_argument("--chunks-per-document", type=int, default=10)
    parser.add_argument("--dimension", type=int, default=768)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keep-root", action="store_true", help="Retain only newly created isolated benchmark libraries")
    parser.add_argument("--reuse-root", type=Path, help="Remeasure an exactly matching benchmark-owner.json marked library")
    parser.add_argument("--prepare-only", action="store_true", help="Create/retain fixture without latency measurements; remeasure via --reuse-root")
    parser.add_argument("--rebuild-indexes", action="store_true", help="Remeasure current index construction and its peak memory on a retained fixture")
    args = parser.parse_args()
    if args.prepare_only and (not args.keep_root or args.reuse_root):
        parser.error("--prepare-only requires --keep-root and a new library")
    if args.reuse_root and len(args.documents) != 1:
        parser.error("--reuse-root requires one --documents count")
    if (
        any(count < 1 or count > 100000 for count in args.documents)
        or args.samples < 1
        or not 1 <= args.chunks_per_document <= 100
        or args.dimension not in (128, 256, 512, 768)
    ):
        parser.error("Use 1–100000 documents and positive samples")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "scope": "Actual isolated OCFL and LanceDB; deterministic seeded vectors, no real-model quality/capacity claim",
        "machine": {
            "platform": platform.platform(),
            "memory_bytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
            "cpu_count": os.cpu_count(),
        },
        "source_sha256": {
            str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((REPO / "backend/symbiknow").rglob("*.py"))
        },
        "software": {"lancedb": package_version("lancedb"), "pyarrow": pa.__version__,
                     "numpy": np.__version__, "rocfl": storage.ROCFL_VERSION, "reader_protocol": 2},
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "native_source_sha256": {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                                 for path in [*sorted((REPO / "native/ocfl-reader/src").rglob("*.rs")),
                                              REPO / "native/ocfl-reader/Cargo.lock", REPO / "native/ocfl-reader/Cargo.toml"]},
        "runs": [],
    }
    for count in args.documents:
        report["runs"].append(run(count, args))
        report["final_source_sha256"] = {
            str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((REPO / "backend/symbiknow").rglob("*.py"))
        }
        report["source_stable"] = report["source_sha256"] == report["final_source_sha256"]
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(
            f"DONE {count}: "
            + json.dumps({k: v for k, v in report["runs"][-1].items() if k != "queries"}),
            flush=True,
        )


if __name__ == "__main__":
    main()
