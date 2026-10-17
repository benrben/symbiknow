"""Graceful restart and read-only live probes. Never upload, delete or rebuild.
Records aggregate inventory hashes/counts only; no document bodies, names or search results.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import statistics
import sys
import subprocess
import threading
import time
import urllib.request
ROOT=Path(__file__).resolve().parents[2];OUT=Path(__file__).parent
URL='http://127.0.0.1:8765'
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
def request(route,body=None):
 data=json.dumps(body).encode() if body is not None else None
 req=urllib.request.Request(URL+route,data=data,headers={'Content-Type':'application/json','Origin':URL,'X-Symbiknow-UI':'1'})
 with urllib.request.urlopen(req,timeout=120) as response:return json.load(response)
def inventory():
 files=sorted((ROOT/'data/files').rglob('inventory.json'))
 h=hashlib.sha256()
 for p in files:h.update(str(p.relative_to(ROOT/'data/files')).encode()+b'\0'+p.read_bytes())
 return {'inventory_files':len(files),'aggregate_sha256':h.hexdigest()}
def native(pid):
 data=ctypes.create_string_buffer(1024)
 physical=ctypes.c_uint64.from_buffer(data,72).value if lib.proc_pid_rusage(pid,0,data)==0 else None
 try:rss=int(subprocess.check_output(['ps','-p',str(pid),'-o','rss='],text=True).strip())*1024
 except (ValueError,subprocess.CalledProcessError):rss=None
 return {'pid':pid,'physical_bytes':physical,'rss_bytes':rss}
old=int(sys.argv[1]) if len(sys.argv)>1 else 4871
command=subprocess.check_output(['ps','-p',str(old),'-o','command='],text=True).strip()
assert command==str(ROOT/'.venv/bin/python')+' -m app.server --web --port 8765',command
before=request('/api/library?limit=100');assert before['library_total']>0 and not before['processing']
report={'before':{'pid':old,'native':native(old),'library_total':before['library_total'],'processing_states':before['processing_states'],'inventories':inventory()},'samples':[],'searches':[],'limitations':['Live pre-restart server has an unknown prior workload; comparison is not a matched isolated benchmark.','GPU allocator numbers overlap physical footprint and must not be added.','Other applications and validation jobs were running; timings are local observations.']}
assert report['before']['inventories']['inventory_files']>0
report['restarted']='--measure-only' not in sys.argv[4:]
if report['restarted']:
 os.kill(old,signal.SIGINT)
 deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  try:os.kill(old,0)
  except ProcessLookupError:break
  time.sleep(.25)
 else:raise RuntimeError('Old owner did not shut down; no new owner started')
 log=(OUT/'restarted-server.log').open('ab')
 process=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-m','app.server','--web','--port','8765'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 pid=process.pid
 for _ in range(240):
  if process.poll() is not None:raise RuntimeError('New server exited; see restarted-server.log')
  try:
     health=request('/api/library?limit=100')
     if not health['processing']:break
  except (OSError,ValueError):pass
  time.sleep(.5)
 else:raise RuntimeError('Restart did not become idle')
else:pid=old
report['after_pid']=pid
stop=threading.Event();peaks=[]
def sampler():
 while not stop.is_set():
    peaks.append(native(pid));stop.wait(.2)
thread=threading.Thread(target=sampler,daemon=True);thread.start()
def sample(stage):
 entry={'stage':stage,'native':native(pid),'runtime':request('/api/runtime')};report['samples'].append(entry);print(json.dumps(entry),flush=True)
def save():
 (OUT/(sys.argv[3] if len(sys.argv)>3 else 'live-after-restart.json')).write_text(json.dumps(report,indent=2))
sample('startup_idle');save()
questions=['Where are original bytes stored and how are old file versions preserved?','איפה נשמרים קבצים מקוריים וגרסאות קודמות?','How can I resume an interrupted upload?','איך מאמתים את חתימת הקובץ בהורדה בחלקים?']
for cycle in range(int(sys.argv[2]) if len(sys.argv)>2 else 3):
 timings=[]
 for i in range(8):
    start=time.perf_counter();result=request('/api/search',{'query':questions[i%4],'mode':'semantic','limit':10,'evaluate':False})
    elapsed=time.perf_counter()-start
    assert result['status']=='ok' and len(result['matches'])>0,result.get('status')
    timings.append(elapsed)
 report['searches'].append({'cycle':cycle,'cold_s':timings[0],'warm_median_s':statistics.median(timings[1:]),'warm_p95_s':sorted(timings[1:])[-1],'warm_sample_count':7,'all_searches_have_matches':True})
 sample(f'cycle{cycle}_after_searches');save()
 # Actual production 60-second timeout, no forced unload.
 for _ in range(66):time.sleep(1)
 sample(f'cycle{cycle}_idle_66s');save()
stop.set();thread.join()
health=request('/api/library?limit=100')
report['after']={'library_total':health['library_total'],'processing_states':health['processing_states'],'inventories':inventory()}
report['inventories_unchanged']=report['before']['inventories']==report['after']['inventories']
report['observed_server_peak_physical_bytes']=max(s['physical_bytes'] or 0 for s in peaks)
report['observed_server_peak_rss_bytes']=max(s['rss_bytes'] or 0 for s in peaks)
assert report['inventories_unchanged'] and health['library_total']==before['library_total']
save();print(json.dumps({'finished':True,'searches':report['searches'],'inventories_unchanged':True}),flush=True)
