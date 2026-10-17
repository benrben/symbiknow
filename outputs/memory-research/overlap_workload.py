"""Real model image ingestion overlapping bilingual search, isolated originals/index."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
os.environ.setdefault('HF_HOME',str(Path(__file__).resolve().parents[2]/'data/models'))
os.environ['HF_HUB_OFFLINE']='1'
from app import storage,search,embeddings
from app.ingest import index_document
OUT=Path(__file__).parent
report={'isolated':True,'real_models':True,'queries':[]}
with tempfile.TemporaryDirectory(prefix='symbiknow-overlap-') as tmp:
 root=Path(tmp);embeddings.validate_index(root)
 body='A cat rests on the sofa. חתול נח על הספה.'.encode();meta=storage.save_file(root,body,'cat.txt')
 assert index_document(root,meta,body)['status']=='indexed'
 photo=OUT/'real-photos/chelsea.png';image_meta=storage.save_file(root,photo,'cat.png',mime_type='image/png')
 with ThreadPoolExecutor(1) as pool:
    future=pool.submit(index_document,root,image_meta,photo)
    for i in range(12):
        start=time.perf_counter();results=search.find_documents(root,['cat on sofa','חתול נח על הספה'][i%2],limit=10)
        assert any(r['document_id']==meta['document_id'] for r in results)
        report['queries'].append({'seconds':time.perf_counter()-start,'ingestion_in_progress':not future.done()})
    state=future.result(timeout=300);assert state['status']=='indexed',state.get('index_error')
 report['image_status']=state['status'];report['model']=embeddings.get_embedder().stats()
 report['visual_search_has_photo']=any(r['document_id']==image_meta['document_id'] for r in search.find_documents(root,'a brown tabby cat',limit=10))
 assert report['visual_search_has_photo'] and any(q['ingestion_in_progress'] for q in report['queries'])
 embeddings.unload_idle(force=True)
(OUT/(os.getenv('OVERLAP_RESULT','overlap-workload')+'.json')).write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
