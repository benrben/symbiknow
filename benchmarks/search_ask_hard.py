"""Frozen synthetic end-to-end MCP benchmark; limit=3 for every route.

Run --validate-only first and review the fixture and printed hashes. A hosted run
requires those exact hashes, uses an isolated temporary library and preserves all
80 planned outcomes, including skipped attempts. Gold is author-labeled synthetic
evidence, not an independent estimate of real-world accuracy.
"""

import argparse
import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "benchmarks/fixtures/search-ask-hard.json"
ROUTES = {"hybrid": ("search", {"mode": "hybrid", "evaluate": False}),
          "semantic": ("search", {"mode": "semantic", "evaluate": False}),
          "answer": ("search", {"mode": "answer"}), "ask": ("ask", {})}
POSITIVE = {"answered", "partial", "corrected_premise"}
NEGATIVE = {"no_answer_in_evaluated_candidates", "needs_context"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_hash():
    paths = sorted((REPO / "backend/symbiknow").rglob("*.py")) + [Path(__file__), REPO / "uv.lock"]
    return digest(b"".join(str(p.relative_to(REPO)).encode() + b"\0" + p.read_bytes() for p in paths))


def validate_fixture(fixture):
    docs, cases = fixture["documents"], fixture["cases"]
    assert docs and cases, "Empty corpus or case list"
    assert fixture["provenance"]["independent_gold"] is False, "Synthetic gold must be labeled"
    assert len({d["id"] for d in docs}) == len(docs), "Duplicate document IDs"
    assert len({c["id"] for c in cases}) == len(cases), "Duplicate case IDs"
    by_id = {d["id"]: d for d in docs}
    for doc in docs:
        assert isinstance(doc["text"], str) and doc["text"], "Empty original"
        assert Path(doc["filename"]).name == doc["filename"] and doc["filename"].endswith(".txt")
        assert isinstance(doc.get("folder", ""), str)
        assert all(isinstance(g, str) and g for g in doc.get("groups", []))
    for case in cases:
        assert isinstance(case["query"], str) and case["query"]
        assert all(isinstance(case[k], str) and case[k] for k in ("folder", "group") if k in case)
        gold = case["expected"]
        assert gold["status"] in POSITIVE | NEGATIVE
        for kind in ("required_support", "required_dependencies", "forbidden_support", "source_exact"):
            for row in gold.get(kind, []):
                doc = by_id[row["document_id"]]
                text = doc["text"] + (doc.get("previous_text", "") if kind == "forbidden_support" else "")
                assert row["quote"] and row["quote"] in text, f"{case['id']}: absent {kind} quote"
        if gold["status"] in POSITIVE:
            assert gold.get("required_support"), f"{case['id']}: positive requires citation gold"
        for pair in gold.get("values", []):
            assert len(pair) == 2 and all(isinstance(v, str) and v for v in pair)
    return {"documents": len(docs), "cases": len(cases), "checked_outcomes": len(cases) * 2}


def covered(gold, windows):
    return all(any(g["document_id"] == d and g["quote"] in text for d, text in windows) for g in gold)


def audit(result, catalog, provider_calls):
    """Bind every returned citation/window to exact indexed current-version bytes."""
    identities = {d["document_id"]: logical for logical, d in catalog.items()}
    chunks = {e["evidence_id"]: (logical, e["text"]) for logical, d in catalog.items() for e in d["evidence"]}
    errors, cited, dependencies, retrieved, sent, numbers = [], [], [], [], [], []

    def document(identity, version):
        logical = identities.get(identity)
        if logical is None or catalog[logical]["version"] != version:
            raise ValueError("unknown_document_or_stale_version")
        return logical

    def window(row, identity, version, *, source=False):
        logical = document(identity, version)
        owner, original = chunks[row["chunk_id"]]
        if owner != logical:
            raise ValueError("citation_document_mismatch")
        start, end = (row.get("start"), row.get("end")) if source else (row.get("text_start"), row.get("text_end"))
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(original):
            raise ValueError("invalid_span")
        text = original[start:end]
        supplied = row.get("quote") if source else row.get("text")
        if supplied is not None and supplied != text:
            raise ValueError("altered_window")
        if "sha256" in row and row["sha256"] != digest(text.encode()):
            raise ValueError("dependency_hash_mismatch")
        return logical, text

    def record_error(error):
        errors.append(str(error) if isinstance(error, ValueError) else type(error).__name__)

    for match in result.get("matches", []):
        try:
            identity, version = match["document_id"], match["version"]
            logical = document(identity, version)
            if match.get("sha256") and match["sha256"] != catalog[logical]["sha256"]:
                raise ValueError("original_hash_mismatch")
            for evidence in match.get("evidence", []):
                owner, original = chunks[evidence["evidence_id"]]
                if owner != logical or evidence["text"] != original:
                    raise ValueError("retrieved_evidence_mismatch")
                retrieved.append((logical, original))
            judgment = match.get("jev", {})
            windows = {w["chunk_id"]: window(w, identity, version) for w in judgment.get("evaluated_evidence", [])}
            for field in ("supporting_chunk_ids", "conflicting_chunk_ids", "possible_conflicting_chunk_ids", "disagreement_chunk_ids"):
                for ref in judgment.get(field, []):
                    if ref not in windows:
                        raise ValueError("citation_outside_evaluated_windows")
                    if field in {"supporting_chunk_ids", "conflicting_chunk_ids"}:
                        cited.append((field, *windows[ref]))
            for dep in judgment.get("verification_dependencies", []):
                dependencies.append(window(dep, dep["document_id"], dep["version"]))
        except (ValueError, KeyError, TypeError) as error:
            record_error(error)
    for value in result.get("answer", {}).get("values", []):
        try:
            source = value["source"]
            logical, quote = window(source, source["document_id"], source["version"], source=True)
            calculation = value.get("calculation") or {}
            numbers.append(dict(document_id=logical, quote=quote,
                                number=calculation.get("source_value", value["value"]),
                                unit=calculation.get("source_unit", value["unit"])))
        except (ValueError, KeyError, TypeError) as error:
            record_error(error)
    for call in provider_calls:
        state = call["state"]
        try:
            single = [state["document"]] if "document" in state else []
            for doc in state.get("documents", state.get("original_documents", single)):
                identity = doc.get("document_id", doc.get("id"))
                logical = document(identity, doc["version"])
                for evidence in doc.get("evidence", []):
                    sent.append(window(evidence, identity, doc["version"]))
                for paragraph in doc.get("paragraphs", []):
                    if not isinstance(paragraph, str) or not any(paragraph in e["text"] for e in catalog[logical]["evidence"]):
                        raise ValueError("provider_paragraph_mismatch")
                    sent.append((logical, paragraph))
        except (ValueError, KeyError, TypeError) as error:
            record_error(error)
    return dict(errors=errors, cited=cited, dependencies=dependencies, retrieved=retrieved, sent=sent, numbers=numbers)


def score(case, route, result, catalog, provider_calls):
    gold = case["expected"]
    bound = audit(result, catalog, provider_calls)
    required = gold.get("required_support", []) + gold.get("required_dependencies", [])
    gold_docs = {g["document_id"] for g in required}
    retrieved_docs = {d for d, _ in bound["retrieved"]}
    checked = route in {"answer", "ask"}
    row = dict(binding_errors=bound["errors"],
               retrieval_gold_document_recall_at_3=(len(gold_docs & retrieved_docs) / len(gold_docs) if gold_docs else None),
               retrieval_all_gold_quotes=covered(required, bound["retrieved"]) if required else None)
    if not checked:
        return row
    answer, evaluation = result.get("answer", {}), result.get("evaluation", {})
    metrics = result.get("metrics", {})
    field = "conflicting_chunk_ids" if gold["status"] == "corrected_premise" else "supporting_chunk_ids"
    support = [(d, text) for kind, d, text in bound["cited"] if kind == field]
    accepted = [(d, text) for _, d, text in bound["cited"]]
    forbidden = any(covered([g], accepted) for g in gold.get("forbidden_support", []))
    positive = gold["status"] in POSITIVE
    status_ok = answer.get("status") == gold["status"]
    evaluated = evaluation.get("status") == "evaluated" and answer.get("evaluated_count", 0) > 0
    dependencies_ok = covered(gold.get("required_dependencies", []), bound["dependencies"] if positive else bound["sent"])
    values_ok = sorted([str(v["value"]), v["unit"]] for v in answer.get("values", [])) == sorted(gold.get("values", []))
    source_ok = all(any(all(number.get(k) == g[k] for k in ("document_id", "quote", "number", "unit"))
                        for number in bound["numbers"]) for g in gold.get("source_exact", []))
    # Query-embedding reuse across routes is not a reused judgment.
    independent = metrics.get("provider_calls", 0) > 0 and not any(
        v for k, v in metrics.items() if "cache_hit" in k and not k.startswith("embedding_"))
    safe_negative = positive or (not result.get("matches") and not answer.get("values"))
    row.update(actual_status=answer.get("status"), expected_status=gold["status"], exact_status=status_ok,
               evaluated_nonempty=evaluated, provider_independent=independent,
               all_required_support=covered(gold.get("required_support", []), support),
               all_required_dependencies=dependencies_ok, actual_provider_gold_context=covered(required, bound["sent"]),
               forbidden_citation=forbidden, numeric_values_exact=values_ok, numeric_sources_exact=source_ok,
               safe_negative=safe_negative)
    row["success"] = all((status_ok, evaluated, independent, not bound["errors"], not forbidden,
                          row["all_required_support"], dependencies_ok, values_ok, source_ok, safe_negative))
    return row


def summarize(rows):
    checked = [r for r in rows if r["route"] in {"answer", "ask"}]
    metrics = [r.get("result", {}).get("metrics", {}) for r in rows]
    return dict(planned=len(rows), attempted=sum(r["state"] != "not_started" and r["state"] != "skipped" for r in rows),
                checked_denominator=len(checked), checked_successes=sum(r.get("score", {}).get("success", False) for r in checked),
                states=dict(Counter(r["state"] for r in rows)),
                statuses=dict(Counter(r.get("score", {}).get("actual_status", r["state"]) for r in checked)),
                provider_calls=sum(m.get("provider_calls", 0) for m in metrics),
                input_tokens=sum(m.get("provider_input_tokens", 0) for m in metrics),
                output_tokens=sum(m.get("provider_output_tokens", 0) for m in metrics),
                by_route={route: dict(planned=sum(r["route"] == route for r in rows),
                                      successes=sum(r.get("score", {}).get("success", False) for r in rows if r["route"] == route),
                                      no_answer_planned=sum(r["expected_status"] == "no_answer_in_evaluated_candidates" for r in rows if r["route"] == route),
                                      no_answer_correct=sum(r.get("score", {}).get("success", False) and r["expected_status"] == "no_answer_in_evaluated_candidates" for r in rows if r["route"] == route))
                          for route in ROUTES})


def save(report, output):
    report["summary"] = summarize(report["attempts"])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(output)


async def invoke(client, row):
    response = await client.call_tool(row["tool"], row["arguments"])
    row["submission"] = response.model_dump(mode="json")
    if response.is_error:
        raise RuntimeError("MCP tool error; see submission")
    receipt = response.structured_content
    if "job_id" not in receipt:
        return receipt
    row["job_states"] = []
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        response = await client.call_tool("get_job", {"job_id": receipt["job_id"], "detail": "full"})
        if response.is_error:
            row["poll_error"] = response.model_dump(mode="json")
            raise RuntimeError("MCP polling error")
        job = response.structured_content
        if not row["job_states"] or row["job_states"][-1]["status"] != job["status"]:
            row["job_states"].append(job)
        if job["status"] in {"completed", "failed", "cancelled"}:
            row["job"] = job
            if job["status"] != "completed":
                raise RuntimeError("MCP job did not complete")
            return job["result"]
        await asyncio.sleep(.15)
    raise TimeoutError("MCP job exceeded 180 seconds")


async def run(args, fixture, frozen):
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
    report = dict(started_utc=datetime.now(timezone.utc).isoformat(), frozen=frozen, fixture=fixture,
                  repeats=1, limit=3, cache_policy="durable/proof/numeric disabled; sequential independent routes",
                  attempts=[dict(case=c["id"], route=route, state="not_started", expected_status=c["expected"]["status"],
                                 tool=tool, arguments=dict(query=c["query"], limit=3, **options,
                                                          **{k: c[k] for k in ("folder", "group") if k in c}), provider_requests=[])
                            for c in fixture["cases"] for route, (tool, options) in ROUTES.items()])
    save(report, args.output)

    def guard():
        if digest(args.fixture.read_bytes()) != frozen["fixture_sha256"] or source_hash() != frozen["source_sha256"]:
            raise RuntimeError("Frozen fixture/source changed during measurement")

    try:
        with tempfile.TemporaryDirectory(prefix="symbiknow-hard-") as temporary:
            root = Path(temporary)
            # Reuse installed model weights only; every original/index/job lives in root.
            os.environ.setdefault("HF_HOME", str(REPO / "data/models"))
            os.environ.update(SYMBIKNOW_DATA_DIR=str(root), SYMBIKNOW_STORAGE_ONLY="0", SYMBIKNOW_WARMUP="0",
                              SYMBIKNOW_JEV_ANSWER_CACHE="0", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
            sys.path.insert(0, str(REPO / "backend"))
            from mcp import Client
            from symbiknow.api import mcp as server
            from symbiknow.ai import jev, numeric, proof
            from symbiknow.embeddings.runtime import get_embedder, validate_index
            from symbiknow.ingestion import service as ingest
            from symbiknow.library import storage
            from symbiknow.search import index

            server.DATA_DIR, server.STORAGE_ONLY = root, False
            storage.init_storage(root)
            validate_index(root)
            embedder = get_embedder()
            report["embedding_model"] = embedder.model_id
            report["catalog"] = catalog = {}
            index_started = time.perf_counter()
            for doc in fixture["documents"]:
                guard()
                identity = str(uuid.uuid4())
                previous = None
                if "previous_text" in doc:
                    previous = storage.save_file(root, doc["previous_text"].encode(), doc["filename"], document_id=identity)
                metadata = storage.save_file(root, doc["text"].encode(), doc["filename"], document_id=identity,
                                             expected_version=previous["version"] if previous else None)
                if ingest.index_document(root, metadata, doc["text"].encode(), embedder)["status"] != "indexed":
                    raise RuntimeError(f"Indexing failed: {doc['id']}")
                index.save_organization(root, identity, metadata["version"], dict(
                    status="evaluated", folder=doc.get("folder", ""), groups=doc.get("groups", []), links=[]))
                catalog[doc["id"]] = dict(document_id=identity, version=metadata["version"], sha256=digest(doc["text"].encode()),
                                          evidence=[e for batch in index.evidence_batches(root, identity, metadata["version"]) for e in batch])
            report["index_seconds"] = time.perf_counter() - index_started
            # The entire isolated corpus has already been explicitly indexed and organized.
            (root / "temp/work-bootstrap.json").write_text('{"schema":1}')
            proof._CACHE = proof.ByteLRU(max_entries=0, max_bytes=0)
            numeric._CACHE = numeric.ByteLRU(max_entries=0, max_bytes=0)
            jev._ANSWER_CACHE = None
            original_call, active = jev._call, [None]

            def observe(state, questions, client=None, **kwargs):
                if active[0] is None or active[0]["route"] not in {"answer", "ask"}:
                    raise RuntimeError("Unexpected provider call outside checked route")
                record = dict(state=state, questions={k: q.model_dump(mode="json") if hasattr(q, "model_dump") else q for k, q in questions.items()})
                active[0]["provider_requests"].append(record)
                started = time.perf_counter()
                try:
                    response = original_call(state, questions, client, **kwargs)
                    record["response"] = response.model_dump(mode="json")
                    return response
                except Exception as error:
                    record["error_type"] = type(error).__name__
                    raise
                finally:
                    record["seconds"] = time.perf_counter() - started

            jev._call = observe
            expected_heads = {d["document_id"]: d["version"] for d in catalog.values()}
            save(report, args.output)
            try:
                async with Client(server.mcp) as client:
                    for row in report["attempts"]:
                        guard()
                        if dict(storage.heads_many(root, expected_heads)) != expected_heads:
                            raise RuntimeError("Original heads changed")
                        active[0], row["state"] = row, "running"
                        save(report, args.output)
                        started = time.perf_counter()
                        try:
                            row["result"] = await invoke(client, row)
                            guard()
                            if dict(storage.heads_many(root, expected_heads)) != expected_heads:
                                raise RuntimeError("Original heads changed")
                            case = next(c for c in fixture["cases"] if c["id"] == row["case"])
                            row["score"] = score(case, row["route"], row["result"], catalog, row["provider_requests"])
                            row["state"] = "completed"
                        except Exception as error:
                            row.update(state="error", error_type=type(error).__name__, error=str(error))
                            raise
                        finally:
                            row["seconds"] = time.perf_counter() - started
                            active[0] = None
                            save(report, args.output)
                        print(json.dumps({k: row[k] for k in ("case", "route", "state", "score")}), flush=True)
                        failure = row["result"].get("evaluation", {}).get("failure", {})
                        if failure and not failure.get("retryable", False):
                            raise RuntimeError("Systemic provider failure: " + failure.get("code", "unknown"))
            finally:
                jev._call = original_call
            guard()
    except Exception as error:
        report["aborted"] = dict(error_type=type(error).__name__, reason=str(error))
        for row in report["attempts"]:
            if row["state"] == "not_started":
                row.update(state="skipped", skip_reason=report["aborted"])
    report["completed_utc"] = datetime.now(timezone.utc).isoformat()
    save(report, args.output)
    print(json.dumps(report["summary"], indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--expected-fixture-sha256")
    parser.add_argument("--expected-source-sha256")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text())
    counts = validate_fixture(fixture)
    frozen = dict(fixture_sha256=digest(args.fixture.read_bytes()), source_sha256=source_hash())
    if args.validate_only:
        print(json.dumps(dict(**counts, **frozen), indent=2))
        return
    if args.expected_fixture_sha256 != frozen["fixture_sha256"] or args.expected_source_sha256 != frozen["source_sha256"]:
        parser.error("Hosted execution requires both exact reviewed hashes from --validate-only")
    if not args.output or args.output.exists():
        parser.error("Supply --output at a new path; existing attempts must be retained")
    report = asyncio.run(run(args, fixture, frozen))
    if args.check and (report.get("aborted") or report["summary"]["checked_successes"] != counts["checked_outcomes"]
                       or any(r.get("score", {}).get("binding_errors") for r in report["attempts"])):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
