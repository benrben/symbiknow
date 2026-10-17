"""Isolated real Docling chunking + actual runtime + LanceDB retrieval, no hosted calls.
Uses the unchanged generated 80-question labels. Inline Markdown conversion avoids
starting 54 identical import-only child processes; conversion/content logic is the
production path. This measures retrieval quality, not ingestion process memory.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
os.environ.setdefault('HF_HOME', str(ROOT/'data/models'))
os.environ['HF_HUB_OFFLINE']='1'
from app import embeddings, ingest, search, storage
OUT=Path(__file__).parent
corpus=json.loads((OUT.parent/'generated-quality-corpus.json').read_text())
report={'runtime':embeddings.runtime_name(),'quantization':embeddings.torch_quantization(),'provenance':corpus['provenance'],'production_chunking':True,'conversion_isolation':False,'modes':{},'indexing_seconds':0}

def evaluate(root, manager):
 result={}
 for mode in ['semantic','hybrid']:
    cases=[];start=time.perf_counter()
    for i,c in enumerate(corpus['cases']):
        matches=search.find_documents(root,c['question'],mode=mode,limit=5,embedder=manager)
        sources=[m['filename'] for m in matches]
        rank=sources.index(c['source'])+1 if c['source'] in sources else None
        cases.append({**c,'id':i,'rank_in_five':rank,'returned_sources':sources})
    summary={lang:{'top1':sum(c['rank_in_five']==1 for c in cases if c['language']==lang),'top3':sum(c['rank_in_five'] is not None and c['rank_in_five']<=3 for c in cases if c['language']==lang),'total':sum(c['language']==lang for c in cases)} for lang in ['en','he']}
    result[mode]={'summary':summary,'seconds':time.perf_counter()-start,'cases':cases}
    print(mode,summary,flush=True)
 return result

with tempfile.TemporaryDirectory(prefix='symbiknow-guide-quality-') as temp:
 root=Path(temp);embeddings.validate_index(root);manager=embeddings.get_embedder()
 start=time.perf_counter()
 for source in sorted((ROOT/'docs/knowledge-library').glob('*.md')):
    content=source.read_bytes();meta=storage.save_file(root,content,source.name)
    result=ingest.index_document(root,meta,content,manager)
    assert result['status']=='indexed',result.get('index_error')
 report['indexing_seconds']=time.perf_counter()-start
 report['documents']=len(list((ROOT/'docs/knowledge-library').glob('*.md')))
 report['chunks']=search._table(root,'chunks').count_rows()
 report['modes']=evaluate(root,manager)
 embeddings.unload_idle(force=True)
 if os.getenv('QUALITY_COMPARE_FLOAT32')=='1':
    os.environ['SYMBIKNOW_TORCH_QUANTIZATION']='none'
    fallback=embeddings.ModelManager(timeout=0)
    manifest=root/'index/embedding-runtime.json';frozen=manifest.read_bytes()
    def verify_probe_index(directory):
        # Test-only read evaluation before approval; retain the real model ID,
        # which is also the stored-vector filter. Never alter the index manifest.
        assert Path(directory).resolve()==root.resolve() and manifest.read_bytes()==frozen
    try:
        with patch.object(embeddings,'validate_index',verify_probe_index):
            report['float32_queries_on_int8']=evaluate(root,fallback)
    finally:fallback.unload(force=True)
report['limitations']=['Generated regression labels; not independent held-out user labels.','Existing 90% threshold is unchanged. No default runtime change or private index access.','Input set is English technical guides, not a diverse production library.']
(OUT/(os.environ.get('QUALITY_LABEL',f"production-guide-{report['runtime']}")+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='modes'},indent=2))
