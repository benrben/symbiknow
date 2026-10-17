"""Real model use/idle cycles, cold/warm timing, GPU vs process accounting."""
import ctypes
import gc
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ['SYMBIKNOW_MODEL_IDLE_SECONDS'] = '2'
from app.embeddings import get_embedder
from PIL import Image
import mlx.core as mx
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
libc.malloc_zone_pressure_relief.argtypes = [ctypes.c_void_p,ctypes.c_size_t]
libc.malloc_zone_pressure_relief.restype = ctypes.c_size_t
records=[]
def snapshot(stage, **extra):
    mx.synchronize()
    data=ctypes.create_string_buffer(1024);lib.proc_pid_rusage(os.getpid(),0,data)
    value={'stage':stage,'physical_bytes':ctypes.c_uint64.from_buffer(data,72).value,
        'gpu_active_bytes':mx.get_active_memory(),'gpu_cache_bytes':mx.get_cache_memory(),**extra}
    records.append(value);print(json.dumps(value),flush=True)
manager=get_embedder();snapshot('imports')
for cycle in range(3):
    start=time.perf_counter();manager.embed_query('חתול נח על הספה בבית');cold=time.perf_counter()-start
    warm=[]
    for _ in range(8):
        start=time.perf_counter();manager.embed_query('cat resting on the sofa');warm.append(time.perf_counter()-start)
    snapshot(f'cycle{cycle}_text_loaded',cold_s=cold,warm_s=warm)
    with Image.new('RGB',(800,1000),'blue') as image:manager.embed_images([image])
    manager.job_boundary();snapshot(f'cycle{cycle}_heavy_boundary')
    time.sleep(3);snapshot(f'cycle{cycle}_idle')
    gc.collect();libc.malloc_zone_pressure_relief(None,0);snapshot(f'cycle{cycle}_malloc_relief')
(Path(__file__).parent/'idle-cycles.json').write_text(json.dumps(records,indent=2))
