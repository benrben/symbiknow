"""Repeat the existing isolated app workloads with regular PyTorch on this Mac.

Run from the project root: .venv/bin/python outputs/memory-research/followup/regular_measurements.py
No live storage/index access. GPU counters overlap OS footprint; do not add them.
"""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
env = os.environ.copy()
env.update(SYMBIKNOW_EMBEDDING_RUNTIME="torch", SYMBIKNOW_EMBEDDING_DEVICE="mps",
           HF_HOME=str(ROOT / "data/models"), HF_HUB_OFFLINE="1")
env.pop("PYTHONPATH", None)
python = str(ROOT / ".venv/bin/python")
for pages in (10, 100, 250):
    label = f"followup/torch-pdf{pages}"
    print(f"Starting regular PyTorch workload: {pages} pages", flush=True)
    with (OUT / f"torch-pdf{pages}.log").open("w") as log:
        subprocess.run(
            [python, str(OUT.parent / "measure_tree.py"), str(OUT / f"torch-pdf{pages}-tree.json"),
             "--", python, str(OUT.parent / "app_workload.py"), label, "--models", "--pdf-pages", str(pages)],
            cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True,
        )
    report = json.loads((ROOT / f"outputs/memory-research/{label}-app.json").read_text())
    assert not report["errors"], report["errors"]
    assert report["image_status"] == report["pdf_status"] == "indexed", report
    print(f"Completed {pages} pages: {report['timing_summary']['pdf_import']['median_s']:.2f}s", flush=True)
