"""Opt-in hosted freshness evaluation on synthetic passages, never the library."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("replacement", "Marigold backup retention is 4 days.",
     "Effective 2026-10-20, this notice replaces the Marigold backup retention rule of 4 days with 7 days.",
     ["possibly_replaced", "a"]),
    ("conflict", "Marigold backup retention is 4 days.", "Marigold backup retention is 7 days.",
     ["conflicting", None]),
    ("different_entities", "Marigold backup retention is 4 days.", "Solstice backup retention is 7 days.",
     [None, None]),
    ("equivalent_units", "Marigold backup retention is 4 days.", "Marigold backup retention is 96 hours.",
     [None, None]),
    ("future_change", "Marigold backup retention is 4 days.",
     "Starting on 2027-01-01, Marigold backup retention will change from 4 to 7 days. Until then it remains 4 days.",
     [None, None]),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    sys.path.insert(0, str(ROOT / "backend"))
    from symbiknow.freshness import judgments
    rows = []
    for name, left, right, expected in CASES:
        passages = [{"id": side, "document_id": side, "text": text, "provenance": {}}
                    for side, text in (("a", left), ("b", right))]
        contexts = [{"document_id": p["document_id"], "filename": name + "-" + p["id"] + ".md", "passages": [p]}
                    for p in passages]
        started = time.perf_counter()
        try:
            decision = judgments.compare(*passages, contexts, "2026-10-23")
            actual = list(judgments.label(decision))
            rows.append({"case": name, "passed": actual == expected, "expected": expected,
                         "actual": actual, "decision": decision, "seconds": time.perf_counter() - started})
        except Exception as error:
            rows.append({"case": name, "passed": False, "error_type": type(error).__name__})
    report = {"date": datetime.now(timezone.utc).isoformat(), "model": judgments.model_identity(),
              "scope": "Five author-labeled synthetic cases frozen before invocation; not independent gold or full-library freshness coverage.",
              "passed": sum(row["passed"] for row in rows), "total": len(rows), "rows": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "total": report["total"]}))
    if args.check and report["passed"] != report["total"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
