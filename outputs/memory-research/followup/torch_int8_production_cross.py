"""Compare W8 queries against real production-chunked float32 vectors, isolated."""
import json
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import torch_int8_trial as trial
from app import embeddings, ingest, search, storage

corpus = json.loads((OUT.parent / "generated-quality-corpus.json").read_text())
report = {"isolated": True, "production_chunking": True, "thresholds": {
    "allowed_top1_regressions": 1, "allowed_top3_regressions": 0,
}, "results": {}, "limitations": [
    "Generated labels, not independently reviewed production certification.",
    "Earlier 90% absolute guide-quality gate is retained as history; baseline already misses it.",
    "This probe separately measures quantization preservation on actual production chunks.",
    "Inline Markdown conversion; not a conversion-child memory measurement.",
]}


def evaluate(root, manager):
    result = {}
    for mode in ("semantic", "hybrid"):
        cases = []
        for index, c in enumerate(corpus["cases"]):
            matches = search.find_documents(root, c["question"], mode=mode, limit=5, embedder=manager)
            sources = [m["filename"] for m in matches]
            rank = sources.index(c["source"]) + 1 if c["source"] in sources else 99
            cases.append({"id": index, "language": c["language"], "rank": rank, "sources": sources})
        result[mode] = {"cases": cases, "summary": {lang: {
            "top1": sum(c["rank"] == 1 for c in cases if c["language"] == lang),
            "top3": sum(c["rank"] <= 3 for c in cases if c["language"] == lang),
        } for lang in ("en", "he")}}
    return result


with tempfile.TemporaryDirectory(prefix="symbiknow-torch8-cross-") as temp:
    root = Path(temp)
    manager = embeddings.ModelManager(timeout=0)
    for source in sorted((ROOT / "docs/knowledge-library").glob("*.md")):
        content = source.read_bytes()
        meta = storage.save_file(root, content, source.name)
        result = ingest.index_document(root, meta, content, manager)
        assert result["status"] == "indexed", result.get("index_error")
    report["chunks"] = search._table(root, "chunks").count_rows()
    report["results"]["float32"] = evaluate(root, manager)
    manager.unload(force=True)
    print("float32", {k:v["summary"] for k,v in report["results"]["float32"].items()}, flush=True)
    for group, fp32 in ((64, False), (16, True), (8, True)):
        trial.GROUP, trial.FP32 = group, fp32
        label = f"int8-group{group}-" + ("float32" if fp32 else "bfloat16")
        start = time.perf_counter()
        manager = embeddings.ModelManager(factory=trial.TrialRuntime, timeout=0)
        result = evaluate(root, manager)
        manager.unload(force=True)
        for mode, value in result.items():
            a = report["results"]["float32"][mode]["cases"]
            b = value["cases"]
            value["lost_top1_ids"] = [x["id"] for x,y in zip(a,b) if x["rank"] == 1 and y["rank"] > 1]
            value["lost_top3_ids"] = [x["id"] for x,y in zip(a,b) if x["rank"] <= 3 and y["rank"] > 3]
        report["results"][label] = result
        print(label, {k:{"summary":v["summary"],"lost_top1":v["lost_top1_ids"],"lost_top3":v["lost_top3_ids"]} for k,v in result.items()}, "seconds", time.perf_counter()-start, flush=True)
        (OUT / "torch-int8-production-cross.json").write_text(json.dumps(report, indent=2))
