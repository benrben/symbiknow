"""Isolated PyTorch native retention probe; no library/index and no MLX imports."""
import ctypes
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.update(SYMBIKNOW_EMBEDDING_RUNTIME="torch", SYMBIKNOW_EMBEDDING_DEVICE="mps",
                  HF_HOME=str(ROOT / "data/models"), HF_HUB_OFFLINE="1")
from app import embeddings
import numpy as np
from PIL import Image

lib = ctypes.CDLL("/usr/lib/libproc.dylib")
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
libc.malloc_zone_pressure_relief.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.malloc_zone_pressure_relief.restype = ctypes.c_size_t
manager = embeddings.get_embedder()
samples = []


def snapshot(stage, **extra):
    data = ctypes.create_string_buffer(1024)
    assert lib.proc_pid_rusage(os.getpid(), 0, data) == 0
    entry = {"stage": stage, "physical_bytes": ctypes.c_uint64.from_buffer(data, 72).value,
             "model": manager.stats(), **extra}
    samples.append(entry)
    print(json.dumps(entry), flush=True)


snapshot("imports")
original = manager.embed_query("חתול נח על הספה בבית")
snapshot("text_loaded")
with Image.new("RGB", (800, 1000), "blue") as image:
    manager.embed_images([image])
manager.job_boundary()
snapshot("vision_unloaded")
with (OUT / "torch-retention-vmmap-before.txt").open("w") as output:
    subprocess.run(["vmmap", "-summary", str(os.getpid())], stdout=output, stderr=subprocess.STDOUT, check=True)
gc.collect()
start = time.perf_counter()
released = libc.malloc_zone_pressure_relief(None, 0)
snapshot("malloc_relief", reported_released_bytes=released, seconds=time.perf_counter() - start)
with (OUT / "torch-retention-vmmap-after.txt").open("w") as output:
    subprocess.run(["vmmap", "-summary", str(os.getpid())], stdout=output, stderr=subprocess.STDOUT, check=True)
assert np.array_equal(original, manager.embed_query("חתול נח על הספה בבית"))
manager.unload(force=True)
snapshot("after_reload_unload")
assert "mlx.core" not in sys.modules
(OUT / "torch-retention.json").write_text(json.dumps(samples, indent=2))
