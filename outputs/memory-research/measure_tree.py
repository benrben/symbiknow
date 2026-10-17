"""Sample a command and its descendants on macOS. GPU allocator reports remain separate.
Usage: python measure_tree.py result.json -- command args...
Reports per-process physical footprint/RSS and simultaneous OS footprint charges,
not RSS+GPU, and not the sum of independent process peaks. 200 ms sampling can miss spikes.
"""
import ctypes
import json
from pathlib import Path
import subprocess
import sys
import time

lib = ctypes.CDLL('/usr/lib/libproc.dylib')
output = Path(sys.argv[1])
command = sys.argv[3:]
child = subprocess.Popen(command)
records = []
while child.poll() is None:
    lines = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,comm='], text=True).splitlines()
    processes = {}
    for line in lines:
        fields = line.split(None, 3)
        if len(fields) < 4: continue
        pid, ppid, rss, name = fields
        processes[int(pid)] = (int(ppid), int(rss) * 1024, name)
    selected = {child.pid}
    for _ in range(8):
        selected.update(pid for pid, (parent, _, _) in processes.items() if parent in selected)
    sample = []
    for pid in selected:
        if pid not in processes: continue
        buffer = ctypes.create_string_buffer(1024)
        physical = ctypes.c_uint64.from_buffer(buffer, 72).value if lib.proc_pid_rusage(pid, 0, buffer) == 0 else None
        sample.append({'pid':pid,'root':pid==child.pid,'name':processes[pid][2], 'rss_bytes':processes[pid][1], 'physical_bytes':physical})
    records.append({'seconds':time.monotonic(),'processes':sample,'simultaneous_footprint_bytes':sum(p['physical_bytes'] or 0 for p in sample)})
    time.sleep(.2)
by_pid = {}
for sample in records:
    for process in sample['processes']:
        value = by_pid.setdefault(str(process['pid']), {**process, 'peak_physical_bytes':0,'peak_rss_bytes':0})
        value['peak_physical_bytes'] = max(value['peak_physical_bytes'], process['physical_bytes'] or 0)
        value['peak_rss_bytes'] = max(value['peak_rss_bytes'], process['rss_bytes'])
report = {'exit_code':child.wait(), 'sample_interval_s':.2, 'gpu_accounting':'Allocator values are in the app report. Do not add them to process footprint.', 'processes':by_pid, 'peak_simultaneous_footprint_bytes':max((s['simultaneous_footprint_bytes'] for s in records),default=0),'samples':records}
output.write_text(json.dumps(report,indent=2))
sys.exit(child.returncode)
