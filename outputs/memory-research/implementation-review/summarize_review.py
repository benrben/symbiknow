"""Summarize saved review evidence without reading the live library."""
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
FOLLOWUP = HERE.parent / "followup"


def read(path):
    return json.loads(path.read_text())


report = {"date": "2026-10-17", "live_library_modified": False, "servers": {},
          "publication": {}, "tests": {}}
for mode in ("none", "int8"):
    path = FOLLOWUP / f"server-{mode}-implementation-review-bench.json"
    value = read(path)
    assert value["server_exit_code"] == 0
    idle = next(s for s in value["stages"] if s["stage"] == "idle_66s")
    assert idle["runtime"]["model"]["loaded"] is False
    assert idle["runtime"]["model"]["mps"]["active_bytes"] == 0
    report["servers"][mode] = {
        "peak_simultaneous_physical_bytes": value["observed_peak_simultaneous_physical_bytes"],
        "idle_simultaneous_physical_bytes": sum(p["physical_bytes"] for p in idle["native"]),
        "warm_median_seconds": value["warm_search_median_seconds"],
        "reload_after_idle_seconds": value["cold_search_seconds"],
        "workloads": value["workloads"],
        "idle_model_loaded": False, "idle_mps_active_bytes": 0,
        "source": str(path.relative_to(HERE.parent.parent.parent)),
    }
for count in (1024, 4000):
    report["publication"][str(count)] = {
        mode: read(HERE / f"chunks-{mode}-{count}.json") for mode in ("before", "after")
    }
for label, filename in [
    ("backend_initial", "backend-initial.log"), ("backend_final", "backend-final.log"),
    ("focused_resources", "resources-after.log"), ("browser_selected", "browser-isolated.log"),
]:
    log = (HERE / filename).read_text()
    found = re.findall(r"(\d+) passed", log)
    assert found, f"No finished result: {filename}"
    assert not re.search(r"\d+ failed", log), filename
    report["tests"][label] = int(found[-1])
units = (HERE / "frontend-units.log").read_text()
assert "# fail 0" in units
report["tests"]["frontend_units"] = int(re.search(r"# pass (\d+)", units)[1])
assert "All checks passed!" in (HERE / "ruff-final.log").read_text()
assert "built in" in (HERE / "build.log").read_text()
report["tests"].update(ruff=True, production_build=True)
browser = read(HERE / "browser-memory.json")
report["browser"] = {k: browser[k] for k in [
    "bytes", "unchanged_library_reads_in_8s", "upload_ms", "zip_ms",
]}
report["browser"]["sampled_upload_native_peak_bytes"] = max(
    sum(p["physical_bytes"] for p in s["native"])
    for s in browser["stages"] if s["stage"] == "upload"
)
dense = read(HERE / "torch-int8-real-pdf.json")
dense_tree = read(HERE / "dense-pdf-tree.json")
assert dense["passed"] and dense_tree["exit_code"] == 0
report["dense_pdf"] = {
    "passed": dense["passed"], "bilingual_top1": dense["bilingual_top1"],
    "original_sha256_verified": dense["original_sha256_verified"],
    "text_pages": dense["text_pages"], "visual_pages": dense["visual_pages"],
    "peak_simultaneous_physical_bytes": dense_tree["peak_simultaneous_footprint_bytes"],
}
report["limitations"] = [
    "Current float32 versus current INT8, not a whole-app before/after of this review's fixes.",
    "Other tests/applications ran during parts of the benchmarks; timings vary.",
    "Physical/GPU accounting overlaps; never add the values.",
    "Database-only gains are not whole-app gains; sampling can miss peaks.",
    "Generated bilingual smoke tests do not replace broad retrieval quality validation.",
]
(HERE / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
