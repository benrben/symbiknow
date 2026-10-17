"""Matched isolated regular PyTorch use/idle observations; no allocator intervention.

Run sequentially with SYMBIKNOW_TORCH_QUANTIZATION=none then int8. Timeout 2s is
only for this lifecycle probe; final live verification uses the real 60s timeout.
"""
import ctypes
import json
import os
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.update(SYMBIKNOW_EMBEDDING_RUNTIME="torch", SYMBIKNOW_EMBEDDING_DEVICE="mps",
                  HF_HOME=str(ROOT / "data/models"), HF_HUB_OFFLINE="1")
from app import embeddings
from PIL import Image

precision = embeddings.torch_quantization()
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
manager = embeddings.ModelManager(timeout=2)
report = {"precision": precision, "model_process_only": True, "idle_timeout_seconds": 2,
          "samples": [], "timings": [], "limitations": [
              "No OCR, database, server or browser; do not call these whole-app totals.",
              "GPU accounting overlaps physical footprint; do not add it.",
              "No vmmap, malloc pressure relief or forced unload in this probe.",
          ]}


def sample(stage):
    data = ctypes.create_string_buffer(1024)
    assert lib.proc_pid_rusage(os.getpid(), 0, data) == 0
    value = {"stage": stage, "physical_bytes": ctypes.c_uint64.from_buffer(data, 72).value,
             "model": manager.stats()}
    report["samples"].append(value)
    print(json.dumps(value), flush=True)
    (OUT / f"torch-cycles-{precision}.json").write_text(json.dumps(report, indent=2))


sample("imports")
for cycle in range(3):
    times = []
    for index in range(9):
        start = time.perf_counter()
        manager.embed_query("חתול נח על הספה בבית" if index % 2 else "cat resting on the sofa")
        times.append(time.perf_counter() - start)
    report["timings"].append({"cycle": cycle, "cold_seconds": times[0], "warm_median_seconds": statistics.median(times[1:])})
    sample(f"cycle{cycle}_text_loaded")
    with Image.new("RGB", (800, 1000), "blue") as image:
        manager.embed_images([image])
    manager.job_boundary()
    sample(f"cycle{cycle}_image_boundary")
    for delay in (.25, .75, 4):
        time.sleep(delay)
        sample(f"cycle{cycle}_after_{delay}s_more")
    assert not manager.stats()["loaded"]
    # Also verify timer-driven text-only expiry, rather than forcing the unload.
    manager.embed_query("חתול")
    time.sleep(3)
    sample(f"cycle{cycle}_text_idle")
    assert not manager.stats()["loaded"]
