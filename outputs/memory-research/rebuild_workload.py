"""Whole rebuild control/data pipeline, real isolated OCFL/LanceDB, fixture vectors/provider.
Includes preparation, neighbors, durable checkpoints, publication and restart replay.
Excludes actual hosted provider latency, embedding inference and ingestion conversion.
"""
import json
from pathlib import Path
import sys
import tempfile
import time
sys.path[:0]=[str(Path(__file__).resolve().parents[2]),str(Path(__file__).resolve().parents[2]/'tests')]
from app import server, storage, search, rebuild, jev
from test_search import FixtureEmbedder
from test_ui_api import decision
server.STORAGE_ONLY=False
search.get_embedder=lambda:FixtureEmbedder()
jev.preflight=lambda:None
calls=[]
def organize(meta,*args,**kwargs):
    calls.append(meta['document_id']);return decision('Symbiknow / Runtime')
jev.organize_document=organize
reports=[]
sources=sorted((Path(__file__).resolve().parents[2]/'docs/knowledge-library').glob('*.md'))
for size in [20,100]:
 with tempfile.TemporaryDirectory(prefix='symbiknow-rebuild-bench-') as tmp:
    root=Path(tmp);server.DATA_DIR=root;storage.init_storage(root)
    embedder=FixtureEmbedder()
    for i in range(size):
        content=sources[i%len(sources)].read_bytes();meta=storage.save_file(root,content,f'guide-{i}.md')
        search.mark_pending(root,meta);text=content.decode()
        search.put_chunks(root,meta,[{'chunk_id':f"{meta['document_id']}:v1:t0",'text':text,'basis':'text','provenance_json':'{}','vector':embedder.embed_documents([text])[0]}],embedder.model_id)
        search.set_document_status(root,meta,status='indexed',indexed_version='v1',chunk_count=1)
    before=len(calls);start=time.perf_counter();rebuild.request(grouping=True,links=True)
    iterations=0
    while rebuild.process_one():
        iterations+=1
        if iterations==size//2:
            rebuild._SNAPSHOT=None;rebuild._STAMP=None;rebuild._ACTIVE_JOB=None;rebuild._ACTIVE_STAMP=None
        if iterations>size+2:raise AssertionError('rebuild failed to finish')
    state=rebuild.status();assert state['status']=='completed',state['failures']
    assert len(state['completed_ids'])==size
    reports.append({'documents':size,'seconds':time.perf_counter()-start,'provider_calls':len(calls)-before,'iterations':iterations,'status':state['status'],'mid_run_snapshot_reload':True})
    print(reports[-1],flush=True)
(Path(__file__).parent/'rebuild-workload.json').write_text(json.dumps({'runs':reports,'limitations':__doc__},indent=2))
