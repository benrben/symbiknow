"""Benchmark-only parent/Docling GPU observation, enabled by explicit PYTHONPATH.

Does not import torch or synchronize devices. No document names/content are saved.
Never add these allocator values to the OS physical-footprint samples.
"""
import json
import os
from pathlib import Path
import sys
import threading
import time

destination = os.getenv("SYMBIKNOW_MEMORY_SAMPLE_DIR")
arguments = getattr(sys, "orig_argv", [])
conversion = "app.conversion_worker" in arguments
owner = len(arguments) > 1 and Path(arguments[1]).name == "torch_int8_real_pdf.py"

if destination and (conversion or owner):
    directory = Path(destination)
    directory.mkdir(parents=True, exist_ok=True)

    def observe():
        with (directory / f"pid-{os.getpid()}.jsonl").open("w", buffering=1) as output:
            while True:
                sample = {"pid": os.getpid(), "role": "conversion" if conversion else "owner",
                          "time": time.monotonic()}
                torch = sys.modules.get("torch")
                try:
                    if torch is not None and torch.backends.mps.is_available():
                        sample["mps_active_bytes"] = torch.mps.current_allocated_memory()
                        sample["mps_driver_bytes"] = torch.mps.driver_allocated_memory()
                    if torch is not None and torch.cuda.is_initialized():
                        sample["cuda_active_bytes"] = torch.cuda.memory_allocated()
                        sample["cuda_reserved_bytes"] = torch.cuda.memory_reserved()
                except (AttributeError, RuntimeError):
                    pass  # torch can still be importing; observe it on the next tick.
                output.write(json.dumps(sample) + "\n")
                time.sleep(.2)

    threading.Thread(target=observe, name="benchmark-native-allocators", daemon=True).start()
