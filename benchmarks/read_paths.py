"""Durable projection performance regression gate; temporary fixtures, no originals/models/providers.

Run each scale in a separate process. Does not establish full endpoint latency.
Organization publication and real Lance indexes are used; dependencies are empty.
"""
import argparse
import cProfile
import gc
import hashlib
import io
import json
import math
from pathlib import Path
import platform
import pstats
import resource
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
import pyarrow as pa  # noqa: E402
from symbiknow.search import index  # noqa: E402
from symbiknow.organization import store, readmodel  # noqa: E402
from symbiknow.core.application import ApplicationContext  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--documents", type=int, required=True)
parser.add_argument("--samples", type=int, default=30)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
out = args.output
out.mkdir(parents=True, exist_ok=True)
hashes = {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in (REPO / "backend/symbiknow").rglob("*.py")}
report = dict(documents=args.documents, samples=args.samples, platform=platform.platform(),
              scope=__doc__, source_sha256=hashes, operations={})

with tempfile.TemporaryDirectory(prefix="symbiknow-audit-") as temporary:
    root = Path(temporary)
    table = index._table(root, "documents", index.DOCUMENT_SCHEMA)
    for offset in range(0, args.documents, 1000):
        rows = [index._document_row(
            dict(document_id=f"audit-{i:09}", version="v1", filename=f"file-{i:09}.txt"),
            status="indexed", indexed_version="v1", evidence_revision="fixture-v1",
            folder="Project / Topic", groups=["all"], organization_status="organized")
            for i in range(offset, min(offset + 1000, args.documents))]
        table.add(pa.Table.from_pylist(rows, schema=index.DOCUMENT_SCHEMA))
    # Favorable indexed/compacted fixture: these scans persist even after maintenance.
    table.create_scalar_index("document_id", index_type="BTREE")
    table.optimize()
    store.initialize(root)
    org = index._db(root).open_table("organization")
    from lancedb.index import BTree, LabelList
    org.create_index("document_id", config=BTree())
    org.create_index("folder", config=BTree())
    org.create_index("groups", config=LabelList())
    publication = store.manifest(root)
    from symbiknow.organization.edits import atomic
    atomic(root / "temp/organization-published.json", dict(publication, version=org.version))
    del rows
    gc.collect()
    ctx = ApplicationContext(root)
    started = time.perf_counter()
    readmodel.rebuild(root)
    report["projection_bootstrap_seconds"] = time.perf_counter() - started
    cursor, remaining = None, max(0, args.documents - 60)
    while remaining:
        amount = min(1000, remaining)
        page = readmodel.browse(root, limit=amount, cursor=cursor)
        cursor = page["next_cursor"]
        remaining -= amount
    operations = {
        "aggregate_cache_miss": lambda: readmodel.aggregates(root),
        "scope_posting_key": lambda: index.scope_tokens(folder="Project"),
        "browse_broad_scope_60": lambda: index.browse_documents(root, folder="Project", group="all", limit=60),
        "empty_decision_queue": lambda: ctx.decisions.list(),
        "browse_first_60": lambda: index.browse_documents(root, limit=60),
        "browse_last_60": lambda: index.browse_documents(root, cursor=cursor, limit=60),
        "incoming_links_no_match": lambda: index.relationship_rows(root, "missing-target"),
    }
    for name, fn in operations.items():
        samples = []
        for _ in range(args.samples):
            start = time.perf_counter()
            value = fn()
            samples.append((time.perf_counter() - start) * 1000)
            if name == "aggregate_cache_miss":
                assert value["library_total"] == args.documents
            if name == "empty_decision_queue":
                assert not value["decisions"] and not value["has_more"]
            if name.startswith("browse"):
                assert len(value["documents"]) == 60 and value["total"] == args.documents
        ordered = sorted(samples)
        result = {f"p{p}_ms": ordered[math.ceil(p / 100 * len(ordered)) - 1] for p in (50, 95, 99)}
        result["samples_ms"] = samples
        if name == "scope_posting_key":
            result["scope_posting_key_bytes"] = len(json.dumps(value).encode())
        profile = cProfile.Profile()
        profile.runcall(fn)
        stream = io.StringIO()
        pstats.Stats(profile, stream=stream).sort_stats("cumtime").print_stats(20)
        (out / f"profile-{args.documents}-{name}.txt").write_text(stream.getvalue())
        report["operations"][name] = result
        print(name, json.dumps({k: v for k, v in result.items() if k != "samples_ms"}), flush=True)
    def submit():
        job = ctx.jobs.start("search", {"query": "needle", "mode": "keyword", "limit": 10})
        item = ctx.work.claim("jobs")[0]
        ctx.work.finish(item, remove=True)
        return job
    samples = []
    for _ in range(args.samples):
        start = time.perf_counter()
        submit()
        samples.append((time.perf_counter() - start) * 1000)
    report["operations"]["durable_job_round_trip"] = {
        f"p{p}_ms": sorted(samples)[math.ceil(p / 100 * len(samples)) - 1] for p in (50, 95, 99)}
    report["budgets_ms"] = {name: 100 for name in report["operations"]}
    report["budget_failures"] = [name for name, result in report["operations"].items()
                                 if result["p95_ms"] >= report["budgets_ms"][name]]
    report["index_logical_bytes"] = sum(p.stat().st_size for p in (root / "index").rglob("*") if p.is_file())
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report["process_peak_rss_bytes_including_fixture_and_profiles"] = peak if sys.platform == "darwin" else peak * 1024
    report["size_budgets"] = {"index_bytes": 64 * 1024**2 + args.documents * 4096, "peak_rss_bytes": 1024**3}
    if report["index_logical_bytes"] > report["size_budgets"]["index_bytes"]:
        report["budget_failures"].append("index_bytes")
    if report["process_peak_rss_bytes_including_fixture_and_profiles"] > report["size_budgets"]["peak_rss_bytes"]:
        report["budget_failures"].append("peak_rss_bytes")
    report["source_stable"] = all(hashlib.sha256((REPO / p).read_bytes()).hexdigest() == h for p, h in hashes.items())
    (out / f"results-{args.documents}.json").write_text(json.dumps(report, indent=2) + "\n")

if args.check and report["budget_failures"]:
    raise SystemExit("Performance budget exceeded: " + ", ".join(report["budget_failures"]))
