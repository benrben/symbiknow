"""Actual PDF preview concurrency and combined renderer accounting, isolated OCFL."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import sys
import tempfile
import threading
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from app import server, storage, ui
import pypdfium2 as pdfium
import subprocess

report={'renders':0,'active':0,'peak_renderers':0,'source_extractions':0}
lock=threading.Lock()
actual=subprocess.run

def run(args,**kwargs):
    render=any('pdf_thumbnail.py' in str(a) for a in args)
    with lock:
        if render:
            report['renders']+=1;report['active']+=1
            report['peak_renderers']=max(report['peak_renderers'],report['active'])
        if 'original' in args and 'cat' in args:report['source_extractions']+=1
    try:return actual(args,**kwargs)
    finally:
        if render:
            with lock:report['active']-=1

with tempfile.TemporaryDirectory(prefix='symbiknow-preview-workload-') as temporary:
    root=Path(temporary);server.DATA_DIR=root
    path=root/'source.pdf'
    with pdfium.PdfDocument.new() as pdf:
        for _ in range(8):pdf.new_page(600,800).close()
        pdf.save(path)
    meta=storage.save_file(root,path,'source.pdf',mime_type='application/pdf')
    subprocess.run=run
    start=time.perf_counter()
    with ThreadPoolExecutor(8) as pool:
        results=list(pool.map(lambda _:ui.pdf_page(meta['document_id'],'v1',1),range(8)))
        assert len({r.body for r in results})==1
        report['identical_request_renders']=report['renders']
        assert report['renders']==1
        results=list(pool.map(lambda page:ui.pdf_page(meta['document_id'],'v1',page),range(2,9)))
        assert all(r.status_code==200 for r in results)
    report['seconds']=time.perf_counter()-start
    assert report['peak_renderers']<=2 and report['source_extractions']==1
    assert not storage._TRANSFER_ACTIVE
report.pop('active')
(Path(__file__).parent/'preview-workload.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
