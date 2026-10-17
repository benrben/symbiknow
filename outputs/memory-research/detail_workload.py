"""Actual 20-version summary/full payload and metadata calls; uncontended lock timing."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from app import storage,server,search,ui
class TimedLock:
 def __init__(self):self.inner=threading.RLock();self.wait=0.;self.hold=0.;self.local=threading.local()
 def __enter__(self):
    start=time.perf_counter();self.inner.acquire();self.wait+=time.perf_counter()-start;self.local.start=time.perf_counter();return self
 def __exit__(self,*args):self.hold+=time.perf_counter()-self.local.start;self.inner.release()
report={}
with tempfile.TemporaryDirectory(prefix='symbiknow-detail-bench-') as tmp:
 root=Path(tmp);server.DATA_DIR=root
 meta=storage.save_file(root,b'original','guide.txt')
 for i in range(19):meta=storage.save_file(root,str(i).encode(),'guide.txt',document_id=meta['document_id'])
 search.register_document(root,meta)
 original=storage.read_metadata
 calls=[]
 def read(*a,**kw):calls.append(1);return original(*a,**kw)
 storage.read_metadata=read
 for section in ['full','summary']:
    calls.clear();lock=TimedLock();server.write_lock=lock;start=time.perf_counter()
    result=ui.detail(meta['document_id'],section=section)
    report[section]={'seconds':time.perf_counter()-start,'json_bytes':len(json.dumps(result).encode()),'metadata_reads':len(calls),'version_records':len(result['versions']),'uncontended_storage_lock_wait_s':lock.wait,'storage_lock_hold_s':lock.hold}
report['limitations']='One local 20-version sample; full mode reproduces previous eager detail work. Lock wait is uncontended, not a concurrent-upload latency claim.'
(Path(__file__).parent/'detail-workload.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
