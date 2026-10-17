#!/usr/bin/env python3
"""Isolated synthetic candidate-preparation benchmark; no models or live library.

Measures the formerly dense, quadratic clustering phase, not a full rebuild,
indexing throughput, hosted Jev accuracy or latency. The default corpus is entirely
unscoped to exercise the largest possible bucket. Run each size in a fresh process.
"""

import argparse
import json
from pathlib import Path
import resource
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.organization import FEATURE_BUDGET, TOPIC_BUDGET, prose_paths  # noqa: E402


def suffix(number):
    letters = ""
    while True:
        number, rem = divmod(number, 26)
        letters += chr(97 + rem)
        if not number:
            return letters


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--documents", type=int, default=100000)
    parser.add_argument("--passages", type=int, default=3)
    parser.add_argument(
        "--projects", type=int, default=0, help="0 for unscoped, or up to one project per document"
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.documents < TOPIC_BUDGET + 1 or args.passages < 1:
        parser.error("Use more than 128 documents and at least one passage")
    if not 0 <= args.projects <= args.documents:
        parser.error("Projects must be between zero and document count")
    themes = [
        "refund invoice payment receipt warehouse delivery",
        "employee account access passkey permissions approval",
        "retrieval keyword vector index ranking query",
        "storage restore backup retention version integrity",
        "garden soil water sunlight roots drainage",
        "shipment carrier tracking package arrival dispatch",
        "subscription renewal cancellation charge billing notice",
        "incident escalation mitigation response alert recovery",
    ]
    started = time.perf_counter()
    profiles = {
        str(i): [
            {
                "evidence_id": f"{i}:v1:{p}",
                "basis": "text",
                "text": (
                    f"Entity{suffix(i % args.projects)} handles "
                    if args.projects
                    else "the workflow describes "
                )
                + f"{themes[i % len(themes)]}. "
                f"the procedure checks {themes[i % len(themes)]} before recording completion. "
                f"the reference token is term{suffix(i)}.",
            }
            for p in range(args.passages)
        ]
        for i in range(args.documents)
    }
    input_bytes = sum(len(row["text"].encode()) for rows in profiles.values() for row in rows)
    prepared = time.perf_counter()
    paths = prose_paths(profiles)
    finished = time.perf_counter()
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result = {
        "phase": "prose_paths only; synthetic corpus",
        "projects": args.projects,
        "documents": args.documents,
        "passages_per_document": args.passages,
        "input_text_bytes": input_bytes,
        "assigned_documents": len(paths),
        "feature_budget": FEATURE_BUDGET,
        "centroid_budget": TOPIC_BUDGET,
        "distinct_folder_labels": len(set(paths.values())),
        "input_seconds": round(prepared - started, 3),
        "candidate_seconds": round(finished - prepared, 3),
        "process_peak_rss_mib": round(rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 2),
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "limits": "Excludes LanceDB vectors, extraction, model memory, Jev calls, disk persistence and end-to-end rebuild; no quality labels.",
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
