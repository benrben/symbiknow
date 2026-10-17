"""Paired old/new database, ledger, receipt and progress probes; isolated data."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import tracemalloc
sys.path[:0]=[str(Path(__file__).resolve().parents[2]),str(Path(__file__).resolve().parents[2]/'tests')]
import lancedb
import numpy as np
from app import ingest, search, storage, organization_edits, server, ui, rebuild
from test_search import FixtureEmbedder
report={}
def measure(fn):
    tracemalloc.start();start=time.perf_counter();value=fn();seconds=time.perf_counter()-start
    peak=tracemalloc.get_traced_memory()[1];tracemalloc.stop()
    return value,{'seconds':seconds,'python_peak_bytes':peak}
with tempfile.TemporaryDirectory(prefix='symbiknow-data-bench-') as directory:
    root=Path(directory);server.DATA_DIR=root
    meta=storage.save_file(root,b'cat','test.txt');search.mark_pending(root,meta)
    spool=ingest.ChunkSpool()
    for i in range(4000):spool.append({'chunk_id':f"{meta['document_id']}:v1:t{i}",'text':f'cat passage {i}','basis':'text','provenance_json':'{}','vector':np.ones(768,dtype=np.float32)})
    search.put_chunks(root,meta,spool.reader(),'test-only-fixture');spool.close()
    search.set_document_status(root,meta,status='indexed',indexed_version='v1',chunk_count=4000)
    table=search._table(root,'chunks');where='active = true';count=4000;limit=128
    offsets=sorted({int(i*(count-1)/(limit-1)) for i in range(limit)})
    def old_evidence():
        return [table.search().where(where).order_by([lancedb.query.ColumnOrdering(column_name='chunk_id',ascending=True)]).offset(i).limit(1).to_list()[0] for i in offsets]
    old,timing=measure(old_evidence);report['old_evidence']=timing
    new,timing=measure(lambda:search.document_evidence(root,meta['document_id'],'v1',limit=limit));report['new_evidence']=timing
    assert [r['chunk_id'] for r in old]==[r['evidence_id'] for r in new]
    ledger={'schema':1,'revision':'r1','assignments':{f'd{i}':{'folder':'Project / Topic'} for i in range(10000)}}
    organization_edits.atomic(organization_edits.path(root),ledger)
    organization_edits.summary(root)  # warm both paired operations
    _,report['old_ledger_read']=measure(lambda:[organization_edits.read(root) for _ in range(8)])
    _,report['new_ledger_read']=measure(lambda:[organization_edits.summary(root) for _ in range(8)])
    for i in range(19):storage.save_file(root,b'cat','test.txt',document_id=meta['document_id'],request_id=f'r{i}')
    _,report['old_receipt']=measure(lambda:next(v for v in reversed(storage.list_versions(root,meta['document_id'])) if v['request_id']=='r18'))
    _,report['new_receipt']=measure(lambda:storage.save_file(root,b'cat','test.txt',document_id=meta['document_id'],request_id='r18'))
    for _ in range(3):ui.library({})
    _,report['library_page_20']=measure(lambda:[ui.library({}) for _ in range(20)])
    _,report['progress_20']=measure(lambda:[ui.progress() for _ in range(20)])
    state={'request_id':'bench','status':'running','phase':'rebuilding','taxonomy_ready':True,'document_ids':[f'd{i}' for i in range(10000)],'work_ids':[f'd{i}' for i in range(10000)],'completed_ids':[],'failures':{},'skips':{},'outcomes':{},'cursor':0,'total':10000}
    rebuild._persist(state)
    def journal():
        for i in range(200):
            state['completed_ids'].append(f'd{i}');state['cursor']=i+1;rebuild._persist(state)
    _,report['rebuild_journal_200']=measure(journal)
    report['rebuild_journal_bytes']=rebuild._path().with_suffix('.jsonl').stat().st_size
    report['base_job_bytes']=rebuild._path().stat().st_size
    # Restart/replay assertion against durable records.
    rebuild._SNAPSHOT=None;rebuild._STAMP=None
    assert rebuild.status()['completed_ids']==state['completed_ids']
report['limitations']='Synthetic scale probes; Python allocation excludes native Arrow/Lance allocations. Timings are local samples, not production quality evidence.'
(Path(__file__).parent/'data-workload.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
