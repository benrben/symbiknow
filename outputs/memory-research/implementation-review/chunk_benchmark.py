"""Isolated publication speed, disk growth and native memory; no models/live data."""
import ctypes
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from app import ingest, search  # noqa: E402

mode, count = sys.argv[1], int(sys.argv[2])
publish = search.put_chunks
if mode == "before":
    namespace = vars(search).copy()
    exec(Path(__file__).with_name("put_chunks_before.py").read_text(), namespace)
    publish = namespace["put_chunks"]

lib = ctypes.CDLL("/usr/lib/libproc.dylib")
def physical():
    import os
    data = ctypes.create_string_buffer(1024)
    if lib.proc_pid_rusage(os.getpid(), 0, data):
        raise RuntimeError("Native physical footprint sampling failed")
    return ctypes.c_uint64.from_buffer(data, 72).value

samples, stop = [], threading.Event()
def sample():
    while not stop.is_set():
        samples.append(physical())
        stop.wait(.02)

with tempfile.TemporaryDirectory(prefix="symbiknow-chunk-review-") as directory:
    root = Path(directory)
    spool = ingest.ChunkSpool()
    for i in range(count):
        spool.append({"chunk_id": f"sample:v1:t{i}", "text": f"cat passage {i}",
                      "basis": "text", "provenance_json": "{}",
                      "vector": np.ones(768, dtype=np.float32)})
    reader = spool.reader()
    baseline = physical()
    monitor = threading.Thread(target=sample)
    monitor.start()
    started = time.perf_counter()
    try:
        publish(root, {"document_id": "sample", "version": "v1"}, reader, "fixture")
        seconds = time.perf_counter() - started
    finally:
        stop.set(); monitor.join(); spool.close()
    table = search._table(root, "chunks")
    assert table.count_rows("active = true") == count
    report = {"mode": mode, "chunks": count, "seconds": seconds,
              "physical_before_bytes": baseline, "sampled_peak_physical_bytes": max(samples),
              "table_versions": len(table.list_versions()),
              "index_bytes": sum(p.stat().st_size for p in root.rglob("*") if p.is_file()),
              "limitations": "Synthetic 768D vectors; publication only; 20ms process physical samples; no model/OCR/browser."}
    Path(__file__).with_name(f"chunks-{mode}-{count}.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report, indent=2))
