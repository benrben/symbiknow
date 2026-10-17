"""Isolated, repeatable whole-server workload. Never opens a user's OCFL/index.
Run: HF_HOME=$PWD/data/models .venv/bin/python outputs/memory-research/app_workload.py baseline
Optional --models exercises real checkpoint, --pdf-pages N adds OCR conversion.
GPU accounting is reported separately, never summed with physical footprint.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
parser = argparse.ArgumentParser()
parser.add_argument('label')
parser.add_argument('--models', action='store_true')
parser.add_argument('--pdf-pages', type=int, default=0)
args = parser.parse_args()
os.environ.setdefault('HF_HOME', str(ROOT / 'data/models'))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ.pop('TYPESAFE_API_KEY', None)
report = {'isolated': True, 'models': args.models, 'samples': [], 'timings': {}, 'errors': []}
lib = ctypes.CDLL('/usr/lib/libproc.dylib') if sys.platform == 'darwin' else None

def sample(stage):
    import resource
    entry = {'stage': stage, 'rss_peak_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    if lib:
        data = ctypes.create_string_buffer(1024)
        if lib.proc_pid_rusage(os.getpid(), 0, data) == 0:
            entry['physical_footprint_bytes'] = ctypes.c_uint64.from_buffer(data, 72).value
    if 'mlx.core' in sys.modules:
        mx = sys.modules['mlx.core']; mx.synchronize()
        entry['gpu_allocator_active_bytes'] = mx.get_active_memory()
        entry['gpu_allocator_cache_bytes'] = mx.get_cache_memory()
        entry['gpu_allocator_peak_bytes'] = mx.get_peak_memory()
    if 'torch' in sys.modules:
        torch = sys.modules['torch']
        if torch.backends.mps.is_available():
            torch.mps.synchronize()
            entry['gpu_tensor_bytes'] = torch.mps.current_allocated_memory()
            entry['gpu_driver_bytes'] = torch.mps.driver_allocated_memory()
    report['samples'].append(entry)
    print(json.dumps(entry), flush=True)

def timed(name, fn):
    start = time.perf_counter()
    value = fn()
    report['timings'].setdefault(name, []).append(time.perf_counter() - start)
    return value

sample('python')
try:
    from app import server, storage, ui, search
    from app.ingest import index_document
    from test_search import FixtureEmbedder
    sample('server_imports')
    with tempfile.TemporaryDirectory(prefix='symbiknow-memory-') as temporary:
        root = Path(temporary); server.DATA_DIR = root
        storage.init_storage(root)
        if args.models:
            from app.embeddings import get_embedder
            embedder = timed('model_load', get_embedder)
            if hasattr(__import__('app.embeddings', fromlist=['validate_index']), 'validate_index'):
                from app.embeddings import validate_index
                validate_index(root)
        else:
            embedder = FixtureEmbedder()
        for name, body in [('english.txt', 'A cat rests on the sofa.'), ('hebrew.txt', 'חתול ישן על הספה בבית.')]:
            metadata = storage.save_file(root, body.encode(), name)
            state = timed('text_import', lambda: index_document(root, metadata, body.encode(), None if args.models else embedder))
            if state['status'] != 'indexed': raise RuntimeError(state['index_error'])
        sample('text_indexed')
        for repeat in range(3):
            for query in ['cat on a sofa', 'חתול בבית']:
                timed('search', lambda: search.find_documents(root, query, embedder=embedder))
        sample('warm_search')
        body = b'x' * (16 * 1024**2)
        meta = timed('large_upload', lambda: storage.save_file(root, body, 'large.bin'))
        del body
        for offset in range(0, meta['size'], server.MAX_CHUNK):
            reply = timed('download_range', lambda: server.download([{'document_id': meta['document_id'], 'version': 'v1', 'offset': offset}]))
            if 'error' in reply['files'][0]: raise RuntimeError(reply)
        response = timed('zip', lambda: ui.bulk_download({'documents': [meta]}))
        Path(response.path).unlink(missing_ok=True)
        for _ in range(12): timed('library', lambda: ui.library({}))
        sample('transfers_complete')
        if args.models or args.pdf_pages:
            from PIL import Image
            from io import BytesIO
            image = Image.new('RGB', (800, 1000), 'white')
            output = BytesIO(); image.save(output, 'PNG')
            content = output.getvalue(); meta = storage.save_file(root, content, 'photo.png')
            state = timed('image_import', lambda: index_document(root, meta, content, None if args.models else embedder))
            report['image_status'] = state['status']; sample('image_complete')
            if args.pdf_pages:
                output = BytesIO(); image.save(output, 'PDF', save_all=True, append_images=[image] * (args.pdf_pages - 1))
                content = output.getvalue(); meta = storage.save_file(root, content, 'long.pdf')
                state = timed('pdf_import', lambda: index_document(root, meta, content, None if args.models else embedder))
                report['pdf_status'] = state['status']; sample('pdf_complete')
        if args.models:
            for _ in range(2):
                timed('search_after_work', lambda: search.find_documents(root, 'חתול בבית', embedder=embedder))
            from app import embeddings
            if hasattr(embeddings, 'unload_idle'): embeddings.unload_idle(force=True)
            sample('unloaded')
except Exception as exc:
    report['errors'].append(f'{type(exc).__name__}: {exc}')
    sample('error')
finally:
    report['timing_summary'] = {k: {'count':len(v), 'median_s':statistics.median(v), 'max_s':max(v)} for k,v in report['timings'].items()}
    (Path(__file__).parent / f'{args.label}-app.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report['timing_summary']), flush=True)
