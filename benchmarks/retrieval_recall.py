"""Answer-window recall: does the answer reach the documents and windows Jev judges?

Indexes an isolated copy of a fixture corpus with the configured real embedding
model, then runs each frozen question through production hybrid retrieval.
Gold is an exact quote; every corpus document containing it is a gold
document. Reports the gold document's rank (recall at 8, 16 and 24) and whether
the quote survives into the retrieved evidence and into the exact windows
``proof.documents`` sends to Jev. No provider calls; never reads the live library.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "benchmarks/fixtures/retrieval-recall.json"
DEPTHS = (8, 16, 24)


def normalize(text):
    return re.sub(r"\s+", " ", text).strip().casefold()


def evaluate(service, proof, case, gold_ids, answer_mode=False):
    from symbiknow.ai import jev

    quote = normalize(case["gold_quote"])
    deep = service.retrieve(case["query"], mode="hybrid", limit=max(DEPTHS)).to_wire()["matches"]
    ranked = [m["document_id"] for m in deep]
    rank = next((i + 1 for i, identity in enumerate(ranked) if identity in gold_ids), None)
    # The answer-mode retrieval window is the server-owned MAX_MATCHES limit.
    window = service.retrieve(case["query"], mode="hybrid", limit=8).to_wire()["matches"]
    retrieved = any(quote in normalize(e.get("text", "")) for m in window for e in m.get("evidence", []))
    try:  # Exactly what judge() sends: fitted windows within the proof budgets.
        judged = proof.documents(proof.fit_search_windows(window, case["query"]), case["query"])
        visible = any(quote in normalize(e["text"]) for d in judged for e in d["evidence"])
        budget = None
    except proof.ContextBudgetError as error:
        visible, budget = False, str(error)
    # Which proof bound fails: per-document passages/characters or the whole request.
    shapes = []
    for match in window:
        windows = jev._evidence(match, case["query"])
        shapes.append((len(windows), sum(len(w["text"]) for w in windows)))
    row = {"id": case["id"], "gold_documents": sorted(gold_ids), "gold_rank": rank,
           **{f"in_top_{k}": rank is not None and rank <= k for k in DEPTHS},
           "quote_in_retrieved_evidence": retrieved, "quote_in_judged_windows": visible,
           "context_budget": budget, "documents": len(window),
           "windows_per_document": [n for n, _ in shapes], "judged_characters": sum(c for _, c in shapes)}
    if answer_mode:
        result = service.retrieve(case["query"], mode="answer", limit=8).to_wire()
        evaluation, answer = result["evaluation"], result["answer"]
        row.update(answer_status=answer["status"], answer_reason=answer.get("reason") or evaluation.get("reason"),
                   answer_documents=[m["document_id"] for m in result["matches"]],
                   answer_found=answer["status"] in {"answered", "partial", "corrected_premise"}
                   and bool(set(m["document_id"] for m in result["matches"]) & gold_ids),
                   # Stricter: a cited supporting window itself contains the gold quote.
                   gold_cited=any(quote in normalize(w["text"])
                                  for m in result["matches"] for w in m["jev"].get("evaluated_evidence", [])
                                  if w["chunk_id"] in m["jev"].get("supporting_chunk_ids", [])),
                   # Short excerpts let a reviewer check answers that cite other passages.
                   cited_excerpts=[w["text"][:400] for m in result["matches"]
                                   for w in m["jev"].get("evaluated_evidence", [])
                                   if w["chunk_id"] in m["jev"].get("supporting_chunk_ids", [])])
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--answer-mode", action="store_true",
                        help="Also run production answer mode end to end (hosted Jev calls)")
    args = parser.parse_args()
    if args.answer_mode:
        from dotenv import load_dotenv
        load_dotenv(REPO / ".env")
    fixture = json.loads(args.fixture.read_text())
    sys.path.insert(0, str(REPO / "backend"))
    from symbiknow.api import mcp as server
    from symbiknow.ai import proof
    from symbiknow.embeddings.runtime import get_embedder, validate_index
    from symbiknow.ingestion import service as ingest
    from symbiknow.library import storage

    files = sorted(p for folder in fixture["provenance"]["corpus"] for p in (REPO / folder).iterdir() if p.is_file())
    cases = fixture["cases"]
    report = {"started_utc": datetime.now(timezone.utc).isoformat(), "fixture": str(args.fixture),
              "provenance": fixture["provenance"], "documents": len(files), "cases": []}
    with tempfile.TemporaryDirectory(prefix="symbiknow-recall-") as temporary:
        root = Path(temporary)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        storage.init_storage(root)
        validate_index(root)  # As at startup: record this runtime before any vector exists.
        embedder = get_embedder()
        started = time.perf_counter()
        names = {}
        for path in files:
            content = path.read_bytes()
            metadata = storage.save_file(root, content, path.name, request_id=str(uuid.uuid4()))
            result = ingest.index_document(root, metadata, content, embedder)
            if result["status"] != "indexed":
                raise RuntimeError(f"{path.name} was not indexed: {result['status']}")
            names[metadata["document_id"]] = (path, normalize(content.decode("utf-8", "replace")))
        report["index_seconds"] = time.perf_counter() - started
        service = server.application().search
        for case in cases:
            gold = {identity for identity, (_, text) in names.items() if normalize(case["gold_quote"]) in text}
            if not gold:
                raise ValueError(f"{case['id']}: gold quote is absent from the corpus")
            row = evaluate(service, proof, case, gold, args.answer_mode)
            row["gold_documents"] = sorted(names[i][0].name for i in gold)
            report["cases"].append(row)
            print(json.dumps(row), flush=True)
    rows = report["cases"]
    report["summary"] = {
        "cases": len(rows),
        **{f"recall_at_{k}": sum(r[f"in_top_{k}"] for r in rows) / len(rows) for k in DEPTHS},
        "quote_in_retrieved_evidence": sum(r["quote_in_retrieved_evidence"] for r in rows) / len(rows),
        "quote_in_judged_windows": sum(r["quote_in_judged_windows"] for r in rows) / len(rows),
        "context_budget_failures": sum(bool(r["context_budget"]) for r in rows),
        "context_budget_reasons": sorted({r["context_budget"] for r in rows if r["context_budget"]}),
        "beyond_8_within_24": [r["id"] for r in rows if r["in_top_24"] and not r["in_top_8"]],
        "lost_after_document_hit": [r["id"] for r in rows if r["in_top_8"] and not r["quote_in_judged_windows"]],
    }
    if args.answer_mode:
        report["summary"]["answer_mode_found"] = sum(r["answer_found"] for r in rows) / len(rows)
        report["summary"]["answer_mode_gold_cited"] = sum(r["gold_cited"] for r in rows) / len(rows)
        report["summary"]["answer_mode_statuses"] = {
            status: sum(r["answer_status"] == status for r in rows) for status in {r["answer_status"] for r in rows}}
    report["completed_utc"] = datetime.now(timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
