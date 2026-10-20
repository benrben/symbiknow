#!/usr/bin/env python3
"""Run maintained synthetic workloads against archived and current app sources.

Each backend/workload starts in a fresh process. The runner, fixtures, model
cache, runtime environment and sample counts stay identical. No live library or
hosted provider is used. Run only in an otherwise quiet measurement window.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]


def compare(baseline, current):
    old = {row["label"]: row for row in baseline["runs"]}
    new = {row["label"]: row for row in current["runs"]}
    comparisons = []
    mismatches = []
    for label in old.keys() & new.keys():
        left, right = old[label], new[label]
        ratio = None
        if left.get("median_seconds") and right.get("median_seconds"):
            ratio = left["median_seconds"] / right["median_seconds"]
        item = dict(label=label, baseline_median_seconds=left.get("median_seconds"),
                    current_median_seconds=right.get("median_seconds"), speedup=ratio,
                    baseline_p95_seconds=left.get("p95_seconds"),
                    current_p95_seconds=right.get("p95_seconds"),
                    baseline_throughput=left.get("throughput_per_second"),
                    current_throughput=right.get("throughput_per_second"),
                    baseline_parent_lifetime_peak_rss_bytes=left.get("parent_peak_rss_bytes"),
                    current_parent_lifetime_peak_rss_bytes=right.get("parent_peak_rss_bytes"),
                    baseline_child_lifetime_peak_rss_bytes=left.get("child_peak_rss_bytes"),
                    current_child_lifetime_peak_rss_bytes=right.get("child_peak_rss_bytes"),
                    baseline_errors=left.get("errors"), current_errors=right.get("errors"))
        previous = [row["ordered_results"] for row in left.get("samples", [])
                    if "ordered_results" in row]
        actual = [row["ordered_results"] for row in right.get("samples", [])
                  if "ordered_results" in row]
        if previous or actual:
            item["ordered_evidence_equal"] = previous == actual
            if previous != actual:
                mismatches.append(label)
        comparisons.append(item)
    return dict(comparisons=sorted(comparisons, key=lambda row: row["label"]),
                ordered_evidence_mismatches=mismatches,
                inputs_equal=baseline.get("inputs") == current.get("inputs"),
                runners_equal=baseline["runner_sha256"] == current["runner_sha256"],
                idle_model=dict(baseline=baseline.get("idle_model"), current=current.get("idle_model")),
                failures=dict(baseline=baseline.get("failures", []), current=current.get("failures", [])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True,
                        help="Source checkout to compare against the current checkout")
    parser.add_argument("--current", type=Path, default=REPO)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--workload", choices=["supplemental", "runtime", "both"], default="supplemental")
    parser.add_argument("--order", choices=["baseline-first", "current-first"], default="baseline-first",
                        help="Use current-first only for a justified counterbalanced follow-up in a separate output directory")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    baseline = args.baseline
    roots = {"baseline": baseline.resolve(), "current": args.current.resolve()}
    if args.order == "current-first":
        roots = dict(reversed(list(roots.items())))
    for root in roots.values():
        if not (root / "backend/symbiknow").is_dir():
            parser.error(f"Missing application source: {root}")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = dict(date=datetime.now(timezone.utc).isoformat(), sources={key: str(value) for key, value in roots.items()},
                  order=args.order + "; each in a fresh process; OS filesystem caches are not flushed",
                  samples=args.samples, results={})
    workloads = ["supplemental", "runtime"] if args.workload == "both" else [args.workload]
    for workload in workloads:
        results = {}
        for name, root in roots.items():
            command = [sys.executable, str(REPO / "benchmarks" / f"{workload}.py"),
                       "--source-root", str(root), "--output", str(output / name),
                       "--samples", str(args.samples)]
            print("START " + " ".join(command), flush=True)
            environment = dict(os.environ, PYTHONUNBUFFERED="1")
            with (output / f"{workload}-{name}.log").open("w") as log:
                child = subprocess.Popen(command, cwd=root, env=environment,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in child.stdout:
                    log.write(line)
                    log.flush()
                    print(line, end="", flush=True)
                status = child.wait()
            if status:
                raise RuntimeError(f"{workload}/{name} exited {status}; see {log.name}")
            result_path = output / name
            if workload == "supplemental":
                result_path /= "supplemental"
            results[name] = json.loads((result_path / "results.json").read_text())
            if not results[name].get("completed"):
                raise RuntimeError(f"Incomplete {workload}/{name}")
        report["results"][workload] = compare(results["baseline"], results["current"])
        (output / "paired-summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
