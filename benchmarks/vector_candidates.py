"""Native maintained ANN candidates, recall and plans; no inference or originals."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import resource
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
import numpy as np  # noqa: E402
import pyarrow as pa  # noqa: E402
from symbiknow.search import index  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
results = []
for count in (1000, 100000):
    with tempfile.TemporaryDirectory(prefix="symbiknow-vector-audit-") as temporary:
        root = Path(temporary)
        table = index._table(root, "chunks", index.chunk_schema(128))
        rng = np.random.default_rng(7)
        for start in range(0, count, 1000):
            size = min(1000, count - start)
            data = {
                "chunk_id": [f"doc-{i}:v1:0" for i in range(start, start + size)],
                "document_id": [f"doc-{i}" for i in range(start, start + size)],
                "version": ["v1"] * size,
                "text": ["Synthetic vector audit evidence."] * size,
                "basis": ["text"] * size,
                "provenance_json": ["{}"] * size,
                "vector": rng.random((size, 128), dtype=np.float32).tolist(),
                "embedding_model": ["audit"] * size,
                "active": [True] * size,
                "scope_keys": [["fixture"]] * size,
            }
            table.add(pa.Table.from_pydict(data, schema=index.chunk_schema(128)))
        index.maintain_online(root)
        table = index._table(root, "chunks")
        query = (table.search([0.1] * 128).distance_type("cosine")
                 .where("active = true AND embedding_model = 'audit'", prefilter=True)
                 .nprobes(32).refine_factor(10)
                 .select(index.EVIDENCE_COLUMNS + ["_distance"]).limit(80))
        plan = query.explain_plan(verbose=True)
        exact = table.search([0.1] * 128).distance_type("cosine").bypass_vector_index().select(["chunk_id"]).limit(80).to_list()
        expected = {row["chunk_id"] for row in exact}
        actual = {row["chunk_id"] for row in query.to_list()}
        recall = len(expected & actual) / len(expected)
        assert recall >= .9, recall
        assert count < 1024 or "ANN" in plan, plan
        times = []
        for _ in range(30):
            begin = time.perf_counter()
            assert len(query.to_list()) == 80
            times.append((time.perf_counter() - begin) * 1000)
        ordered = sorted(times)
        result = dict(recall_at_80=recall, chunks=count, dimension=128, plan=plan, samples_ms=times,
                      index_bytes=sum(p.stat().st_size for p in (root / "index").rglob("*") if p.is_file()),
                      **{f"p{p}_ms": ordered[math.ceil(p / 100 * len(ordered)) - 1] for p in (50, 95, 99)})
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k not in {"samples_ms", "plan"}}), flush=True)
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
(args.output / "vector-results.json").write_text(json.dumps(dict(
    scope=__doc__, results=results, process_peak_rss_bytes_including_both_fixtures=peak if sys.platform == "darwin" else peak * 1024,
    source_sha256=hashlib.sha256((REPO / "backend/symbiknow/search/index.py").read_bytes()).hexdigest()), indent=2))

assert all(row["p95_ms"] < 150 for row in results), "Vector candidate budget exceeded"
