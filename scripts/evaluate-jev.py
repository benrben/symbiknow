#!/usr/bin/env python3
"""Evaluate a separately labeled JSON corpus with hosted Jev or saved predictions.

Corpus schema: provenance {annotator, split, independent}, answerability: [{id,
question, documents: [{document_id, version, evidence, expected_label}]}], grouping:
[{id, documents: [{document_id, version, filename, evidence, expected_cluster}]}].
Labels are direct/partial/related/unrelated/uncertain. Cluster IDs are arbitrary;
folder string equality to human names is never the metric. Unfiled is not a cluster.
Use --predictions for reproducible offline scoring, or --live to send only this
explicit corpus to the configured TypeSafe provider. Never reads the app library.
"""

import argparse
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.evaluation import (
    answerability_metrics,
    grouping_metrics,
    grouping_stability,
    premise_metrics,
)  # noqa: E402
from app.jev import judge_matches, organize_document  # noqa: E402
from app.organization import shared_vocabulary  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true")
    mode.add_argument("--predictions", type=Path)
    parser.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    args = parser.parse_args()
    if args.live:
        from dotenv import load_dotenv

        load_dotenv()
    corpus = json.loads(args.corpus.read_text())
    provenance = corpus.get("provenance", {})
    if not provenance.get("annotator") or not provenance.get("split"):
        parser.error(
            "Record the annotator and corpus split; authored regressions are not independent gold"
        )
    predictions = (
        json.loads(args.predictions.read_text())
        if args.predictions
        else {"answerability": {}, "grouping": {}}
    )
    judgments = []
    premise_rows = []
    receipts = predictions.setdefault("judgments", {})
    groups = {}
    for case in corpus.get("answerability", []):
        if args.live:
            # Respect the application's eight-text-candidate bound; no hidden unevaluated tail.
            if len(case["documents"]) > 8:
                parser.error("Use at most eight supplied documents per answerability case")
            result = judge_matches(case["question"], case["documents"])
            receipts[case["id"]] = result
            predictions["answerability"][case["id"]] = {
                d["document_id"]: d.get("jev", {}).get("label", "uncertain")
                for d in result["matches"]
            }
            # Persist even failures before scoring: failures are abstentions, never successful decisions.
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.with_suffix(".raw.json").write_text(
                json.dumps(predictions, ensure_ascii=False, indent=2)
            )
        for doc in case["documents"]:
            receipt = receipts.get(case["id"], {})
            judged = next(
                (
                    m.get("jev", {})
                    for m in receipt.get("matches", [])
                    if m["document_id"] == doc["document_id"]
                ),
                {},
            )
            if "expected_correction" in doc:
                premise_rows.append(
                    {
                        "expected_correction": doc["expected_correction"],
                        "judgment": judged,
                        **(
                            {"expected_support": doc["expected_support"]}
                            if "expected_support" in doc
                            else {}
                        ),
                        **(
                            {"expected_disagreement": doc["expected_disagreement"]}
                            if "expected_disagreement" in doc else {}
                        ),
                    }
                )
            if "expected_label" not in doc:
                continue
            judgments.append(
                {
                    "expected": doc["expected_label"],
                    "predicted": predictions["answerability"][case["id"]][doc["document_id"]],
                }
            )
    for case in corpus.get("grouping", []):
        expected = {d["document_id"]: d["expected_cluster"] for d in case["documents"]}
        runs = predictions["grouping"].setdefault(case["id"], {})
        if args.live:
            profiles = {d["document_id"]: d["evidence"] for d in case["documents"]}
            vocabulary, _ = shared_vocabulary(profiles)
            for seed in args.seeds:
                docs = list(case["documents"])
                random.Random(seed).shuffle(docs)
                assignments = {}
                for doc in docs:
                    result = organize_document(
                        doc, doc["evidence"], [], folders=vocabulary["folders"]
                    )
                    if result["status"] != "evaluated":
                        raise ValueError("Provider unavailable; no quality result was produced")
                    assignments[doc["document_id"]] = result["folder"]
                runs[str(seed)] = assignments
        baseline = next(iter(runs.values()))
        groups[case["id"]] = {
            "runs": {
                seed: grouping_metrics(expected, assignments) for seed, assignments in runs.items()
            },
            "stability": {
                seed: grouping_stability(baseline, assignments)
                for seed, assignments in runs.items()
            },
        }
    report = {
        "provenance": provenance,
        "declared_independent_held_out": provenance.get("independent") is True
        and provenance.get("split") == "held_out",
        "scope": "Supplied prose and taxonomy candidates only; excludes ingestion, retrieval neighbors, OCR and capacity",
        "answerability": answerability_metrics(judgments),
        "premise": premise_metrics(premise_rows),
        "versions": sorted({
            (j.get("model", "unknown"), j.get("prompt_version", "unknown"),
             j.get("policy_version", "unknown"))
            for result in receipts.values() for match in result.get("matches", [])
            if (j := match.get("jev", {})).get("status") == "evaluated"
        }),
        "grouping": groups,
        "predictions": predictions,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Wrote evaluation to {args.output}")


if __name__ == "__main__":
    main()
