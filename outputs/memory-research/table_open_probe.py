"""Isolated open/query probe; does not authorize a long-lived connection cache."""
import json
from pathlib import Path
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from app import storage,search
with tempfile.TemporaryDirectory(prefix='symbiknow-table-open-') as tmp:
 root=Path(tmp);meta=storage.save_file(root,b'test','test.txt');search.register_document(root,meta)
 table=search._table(root,'documents');report={}
 for mode in ['open_each','reuse_table']:
    start=time.perf_counter()
    for _ in range(100):
        t=search._table(root,'documents') if mode=='open_each' else table
        assert t.search().select(['document_id','version']).limit(1).to_list()[0]['version']=='v1'
    report[mode]={'seconds_100':time.perf_counter()-start}
 report['decision']='Keep existing opens: this small latency probe does not verify cached-handle revision freshness or concurrency, and does not establish a memory saving.'
 (Path(__file__).parent/'table-open-probe.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
