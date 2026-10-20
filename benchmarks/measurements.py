"""Generate the complete sorted operation table from a paired runner directory."""
import argparse
import hashlib
import json
from pathlib import Path


def duration(value):
    return "—" if value is None else f"{value * 1000:,.2f}"


def state(label):
    if "uncached" in label:
        return "warm runtime; vector miss"
    if "repeated_query" in label or "repeated_input" in label:
        return "repeated input; current vector hits"
    if "concurrency" in label or "concurrent" in label:
        return "same-query concurrency; current vectors warm"
    if "cold" in label:
        return "cold model"
    if label == "ingest_policy.html":
        return "new source; worker warm after Markdown"
    if "ingest_repeat" in label:
        return "new source; repeated format; heavy worker recycled"
    if label.startswith("ingest_"):
        return "default ingestion; ordered fresh-process workload"
    if "cached" in label or "warm" in label:
        return "warm/repeated operation"
    if "first" in label:
        return "first operation in this process"
    return "ordered workload; see raw state"


def advice(label, baseline, current):
    if label == "ingest_native-10-pages.pdf":
        return "Material first-pair increase; see follow-up", "Keep the original observation and counterbalanced exact-page diagnosis visible."
    if label.startswith("ingest_") and ("png" in label or "pdf" in label):
        return "Yes: conversion remains seconds", "Retain complete artifacts and heavy-job memory boundaries; investigate repeat variance."
    if current > baseline * 1.05:
        return "Observed overhead", "Keep visible; repeat if material before changing correctness or resource guarantees."
    if current >= .15:
        return "Remaining measurable cost", "Use stage traces to target the dominant work; retain exact output parity."
    return "Measured reuse/target satisfied", "Maintain shared ownership, dependency invalidation and regression checks."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paired", type=Path)
    parser.add_argument("--capacity", type=Path, nargs="*", default=[])
    parser.add_argument("--diagnostic-pair", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows, sources = [], []
    pairs = [("supplemental", args.paired, "supplemental/results.json"), ("runtime", args.paired, "results.json")]
    if args.diagnostic_pair:
        pairs.append(("native_followup", args.diagnostic_pair, "results.json"))
    for kind, directory, suffix in pairs:
        variants = {}
        for variant in ("baseline", "current"):
            path = directory / variant / suffix
            raw = path.read_bytes()
            variants[variant] = json.loads(raw)
            sources.append(f"- `{path}`: SHA256 `{hashlib.sha256(raw).hexdigest()}`")
        old = {row["label"]: row for row in variants["baseline"]["runs"]}
        for current in variants["current"]["runs"]:
            baseline = old.get(current["label"])
            if baseline is not None:
                rows.append((kind, baseline, current))
    rows.sort(key=lambda row: row[2].get("median_seconds", -1), reverse=True)
    lines = ["# Complete matched operation measurements", "",
             "All paired operations are listed, sorted by current p50. Times are milliseconds; arrows mean baseline → current. `n` counts attempts and errors are separate. A one-sample p95/max is that observation, not uncertainty. The primary runtime/supplemental pair ran baseline first in fresh processes, with shuffled modes; the native follow-up ran current first and counterbalanced archived/current preprocessing under each resident model. OS caches were not flushed. The raw reports retain exact inputs, source/runner hashes, individual samples, allocator states and stage traces.", "",
             "Current parent/child RSS is process-lifetime high water in MiB, not a per-operation allocation; later rows can inherit earlier peaks. Cached input, uncached inference, cold weights and seeded/model-free work are distinct states. This table does not claim all operations improved.", "",
             "| Workload | State | n (old/new) | p50 ms | p95 ms | max ms | Errors (old/new) | Current RSS parent/child MiB | Needs optimization | What to do |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for kind, baseline, current in rows:
        label = current["label"]
        need, action = advice(label, baseline["median_seconds"], current["median_seconds"])
        measurement_state = state(label) + ("; reversed diagnostic" if kind == "native_followup" else "")
        values = [f"`{kind}/{label}`", measurement_state, f"{baseline.get('n', '—')}/{current.get('n', '—')}"]
        values.extend(f"{duration(baseline.get(key))} → {duration(current.get(key))}"
                      for key in ("median_seconds", "p95_seconds", "max_seconds"))
        values.append(f"{baseline.get('errors', 0)}/{current.get('errors', 0)}")
        values.append("/".join("—" if current.get(key) is None else f"{current[key] / 1024**2:,.1f}"
                               for key in ("parent_peak_rss_bytes", "child_peak_rss_bytes")))
        values.extend((need, action))
        lines.append("| " + " | ".join(values) + " |")
    lines.extend(["", f"{len(rows)} matched operations. Separate catalog, scope, rebuild, browser and hosted-quality results are retained in [performance-results.json](performance-results.json) and interpreted in [performance-implementation.md](performance-implementation.md).", ""])
    lines.extend(["## Ingestion throughput", "",
                  "Rates are derived from the same measured elapsed samples above, including extraction and embedding. Pages are counted only for image/PDF fixtures; text formats have no page count. The 24-document aggregate did not retain an aggregate chunk count, so that rate is left unspecified rather than inferred. These one-sample format observations retain their order/runtime uncertainty.", "",
                  "| Workload | Documents/s old → new | Pages/s old → new | Chunks/s old → new |",
                  "| --- | --- | --- | --- |"])
    for kind, baseline, current in rows:
        label = current["label"]
        if not label.startswith("ingest_"):
            continue
        docs = 24 if label == "ingest_24_text_documents_total" else 1
        pages = 10 if "native-10-pages.pdf" in label else (1 if ".pdf" in label or ".png" in label else None)
        chunks = [next((sample.get("chunk_count") for sample in row["samples"]
                        if isinstance(sample.get("chunk_count"), int)), None) for row in (baseline, current)]
        def rate(counts):
            return " → ".join("—" if count is None else f"{count / row['median_seconds']:.3f}"
                              for count, row in zip(counts, (baseline, current)))
        lines.append("| " + " | ".join([f"`{kind}/{label}`", rate([docs, docs]), rate([pages, pages]), rate(chunks)]) + " |")
    lines.append("")
    capacity_rows = []
    for path in args.capacity:
        raw = path.read_bytes()
        sources.append(f"- `{path}`: SHA256 `{hashlib.sha256(raw).hexdigest()}`")
        for run in json.loads(raw)["runs"]:
            for label, values in run["queries"].items():
                capacity_rows.append((run["documents"], run["chunks"], label, values))
    if capacity_rows:
        capacity_rows.sort(key=lambda row: row[3]["p50_seconds"], reverse=True)
        lines.extend(["## Actual storage/index capacity operations", "",
                      "These use actual OCFL originals and ten physical 768-dimensional chunks per source, but only ten low-diversity sparse vector prototypes and ten project topics. They test stored data, actual indexes and filters, not representative real-model ANN recall or latency. All tables below were measured sequentially on the final source; 100k fixture preparation had separately overlapped correctness tests. First cold samples remain visible in max; the cold-aggregate operation intentionally has one sample.", "",
                      "| Documents/chunks | Operation | n | p50 ms | p95 ms | max ms | Errors | Needs optimization | What to do |",
                      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"])
        for count, chunks, label, values in capacity_rows:
            slow = values["p50_seconds"] >= .15
            lines.append("| " + " | ".join([
                f"{count:,}/{chunks:,}", f"`{label}`", str(values["successes"] + values["errors"]),
                duration(values["p50_seconds"]), duration(values["p95_seconds"]), duration(values["max_seconds"]),
                str(values["errors"]), "Cold/proportional work remains" if slow else "Measured synthetic target satisfied",
                "Keep cold and warm states separate; profile exact scope/aggregate work." if slow else "Retain exact scope/evidence checks; evaluate representative vectors separately.",
            ]) + " |")
        lines.append("")
    lines.extend(sources + [""])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines))


if __name__ == "__main__":
    main()
