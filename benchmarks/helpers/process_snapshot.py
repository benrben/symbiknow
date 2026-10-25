"""RSS and optional physical footprint for explicit PIDs; no commands/environment capture."""

import ctypes
import json
from pathlib import Path
import subprocess
import sys

lib = ctypes.CDLL("/usr/lib/libproc.dylib") if sys.platform == "darwin" else None
result = []
for pid in map(int, sys.argv[1:]):
    try:
        if lib is not None:
            data = ctypes.create_string_buffer(1024)
            if lib.proc_pid_rusage(pid, 0, data):
                continue
            rss = int(subprocess.check_output(["ps", "-p", str(pid), "-o", "rss="], text=True).strip()) * 1024
            physical = ctypes.c_uint64.from_buffer(data, 72).value
        else:
            # Linux reports resident pages, not macOS's distinct physical-footprint metric.
            status = (Path("/proc") / str(pid) / "status").read_text()
            rss = int(next(line.split()[1] for line in status.splitlines()
                           if line.startswith("VmRSS:"))) * 1024
            physical = None
    except (OSError, subprocess.CalledProcessError, ValueError, StopIteration):
        continue
    result.append({"pid": pid, "physical_bytes": physical, "rss_bytes": rss})
print(json.dumps(result))
