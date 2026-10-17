"""Physical footprint and RSS for explicit process IDs; no command/environment capture."""
import ctypes
import json
import subprocess
import sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
result=[]
for pid in map(int,sys.argv[1:]):
    data=ctypes.create_string_buffer(1024)
    if lib.proc_pid_rusage(pid,0,data):continue
    try:rss=int(subprocess.check_output(['ps','-p',str(pid),'-o','rss='],text=True).strip())*1024
    except (subprocess.CalledProcessError,ValueError):continue
    result.append({'pid':pid,'physical_bytes':ctypes.c_uint64.from_buffer(data,72).value,'rss_bytes':rss})
print(json.dumps(result))
