"""Paired hosted judgment checks on frozen, author-labeled synthetic evidence.

Uses the existing configured provider. Each sample is a fresh process with no
judgment cache namespace. This measures judgment behavior, not retrieval recall
or independent gold accuracy. Never reads the live document library.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "benchmarks/fixtures/hosted-quality.json"


def source_hash(root):
    digest = hashlib.sha256()
    for name in ("ai/jev.py", "ai/proof.py", "ai/numeric.py", "core/cache.py"):
        digest.update(name.encode())
        digest.update((root / "backend/symbiknow" / name).read_bytes())
    return digest.hexdigest()


def validate_bindings(case, result, answer):
    windows = {e["evidence_id"]: (m, e) for m in case["matches"] for e in m["evidence"]}
    for match in result.get("matches", []):
        judgment = match.get("jev", {})
        for field in ("supporting_chunk_ids", "conflicting_chunk_ids"):
            for identity in judgment.get(field, []):
                if identity not in windows:
                    return False
        for dependency in judgment.get("verification_dependencies", []):
            original = windows.get(dependency["chunk_id"])
            if original is None:
                return False
            metadata, window = original
            if (metadata["document_id"] != dependency["document_id"]
                    or metadata["version"] != dependency["version"]):
                return False
            text = window["text"][dependency["text_start"]:dependency["text_end"]]
            if hashlib.sha256(text.encode()).hexdigest() != dependency["sha256"]:
                return False
    for value in answer.get("values", []):
        ref = value["source"]
        original = windows.get(ref["chunk_id"])
        if original is None:
            return False
        metadata, window = original
        if (metadata["document_id"] != ref["document_id"] or metadata["version"] != ref["version"]
                or window["text"][ref["start"]:ref["end"]] != ref["quote"]):
            return False
    return True


def worker(root):
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
    os.environ["SYMBIKNOW_V23_SHADOW"] = "0"
    sys.path.insert(0, str(root / "backend"))
    from symbiknow.ai import jev
    from symbiknow.search.metrics import CURRENT
    case = json.load(sys.stdin)
    metrics, responses = {}, []
    original_call = jev._call

    def record(*args, **kwargs):
        response = original_call(*args, **kwargs)
        responses.append({"model": response.model,
                          "answers": {key: value.model_dump(mode="json")
                                      for key, value in response.answers.items()}})
        return response

    jev._call = record
    token = CURRENT.set(metrics)
    start = time.perf_counter()
    try:
        result = jev.judge_matches(case["query"], case["matches"], cache_namespace=None)
        accepted, answer = jev.answer_results(result["matches"], result)
        bindings = validate_bindings(case, result, answer)
        expected = case["expected"]
        passed = answer["status"] == expected["status"] and bindings
        if "accepted_ids" in expected:
            passed &= sorted(m["document_id"] for m in accepted) == sorted(expected["accepted_ids"])
        if "values" in expected:
            passed &= [[v["value"], v["unit"]] for v in answer.get("values", [])] == expected["values"]
        report = {"passed": bool(passed), "bindings_valid": bindings,
                  "evaluation_status": result.get("status"), "answer": answer,
                  "accepted_ids": [m["document_id"] for m in accepted],
                  "judgments": [m.get("jev", {}) for m in result["matches"]],
                  "provider_responses": responses,
                  "provider_error": result.get("status") == "unavailable"}
    except Exception as exc:
        report = {"passed": False, "provider_error": False,
                  "execution_error": True, "error_type": type(exc).__name__}
    finally:
        CURRENT.reset(token)
    report.update(seconds=time.perf_counter() - start, metrics=metrics)
    print(json.dumps(report, ensure_ascii=False))


def interval(successes, count):
    # Wilson interval describes these repeated samples, not corpus generalization.
    if not count:
        return None
    z = 1.96
    p = successes / count
    center = (p + z*z/(2*count)) / (1 + z*z/count)
    width = z * math.sqrt(p*(1-p)/count + z*z/(4*count*count)) / (1 + z*z/count)
    return [max(0, center-width), min(1, center+width)]


def summarize(rows):
    successes = sum(row["passed"] for row in rows)
    durations = sorted(row["seconds"] for row in rows
                       if not row["provider_error"] and not row.get("execution_error"))
    return {"samples": len(rows), "passed": successes,
            "provider_errors": sum(row["provider_error"] for row in rows),
            "execution_errors": sum(bool(row.get("execution_error")) for row in rows),
            "statuses": dict(Counter(row.get("answer", {}).get("status", "exception") for row in rows)),
            "observed_pass_rate_wilson95": interval(successes, len(rows)),
            "p50_seconds": statistics.median(durations) if durations else None,
            "p95_seconds": durations[math.ceil(.95*len(durations))-1] if durations else None,
            "provider_calls": sum(row.get("metrics", {}).get("provider_calls", 0) for row in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if args.worker:
        worker(args.worker.resolve())
        return
    fixture = json.loads(FIXTURE.read_text())
    cases = fixture["cases"]
    assert len({case["id"] for case in cases}) == len(cases)
    for case in cases:
        assert case["query"] and case["expected"]["status"]
        assert all(e["evidence_id"].startswith(m["document_id"] + ":" + m["version"] + ":")
                   for m in case["matches"] for e in m["evidence"])
    if args.validate_only:
        print(f"Validated {len(cases)} frozen synthetic cases")
        return
    if args.output is None or args.baseline is None or args.repeats < 1:
        parser.error("--baseline, --output and positive --repeats are required")
    variants = {"baseline": args.baseline.resolve(), "current": REPO}
    report = {"started_utc": datetime.now(timezone.utc).isoformat(),
              "fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
              "source_hashes": {name: source_hash(root) for name, root in variants.items()},
              "provenance": fixture["provenance"], "cache": "fresh process; no namespace",
              "repeats": args.repeats, "rows": []}
    rng = random.Random(20261020)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for repeat in range(args.repeats):
        shuffled = list(cases)
        rng.shuffle(shuffled)
        for case in shuffled:
            order = list(variants)
            rng.shuffle(order)
            for variant in order:
                child = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                        "--worker", str(variants[variant])],
                                       input=json.dumps(case), text=True, capture_output=True, timeout=180)
                if child.returncode:
                    raise RuntimeError(f"Quality worker exited {child.returncode} for {variant}/{case['id']}")
                row = json.loads(child.stdout)
                row.update(variant=variant, case=case["id"], category=case["category"], repeat=repeat)
                report["rows"].append(row)
                args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
                print(f"{variant} {case['id']} repeat={repeat+1}: "
                      f"{row.get('answer', {}).get('status', 'exception')} pass={row['passed']} "
                      f"seconds={row['seconds']:.2f}", flush=True)
    report["summary"] = {variant: summarize([row for row in report["rows"] if row["variant"] == variant])
                         for variant in variants}
    report["per_case"] = {case["id"]: {
        "category": case["category"], "expected": case["expected"],
        **{variant: summarize([row for row in report["rows"]
                               if row["variant"] == variant and row["case"] == case["id"]])
           for variant in variants}} for case in cases}
    report["completed_utc"] = datetime.now(timezone.utc).isoformat()
    report["final_source_hashes"] = {name: source_hash(root) for name, root in variants.items()}
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
