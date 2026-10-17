"""Offline synthetic memory probes; never opens the application index."""
import ctypes
import gc
import json
import os
from pathlib import Path
import resource
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ['HF_HOME'] = str(ROOT / 'data/models')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
mode = sys.argv[1]
records = []
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')

def snapshot(stage, **extra):
    data = ctypes.create_string_buffer(1024)
    result = libproc.proc_pid_rusage(os.getpid(), 0, ctypes.byref(data))
    record = {'stage': stage, 'mode': mode, 'peak_rss_mib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, **extra}
    if result == 0:
        record['physical_footprint_mib'] = ctypes.c_uint64.from_buffer(data, 72).value / 2**20
    if 'torch' in sys.modules and torch.backends.mps.is_available():
        torch.mps.synchronize()
        record['mps_tensor_mib'] = torch.mps.current_allocated_memory() / 2**20
        record['mps_driver_mib'] = torch.mps.driver_allocated_memory() / 2**20
    records.append(record)
    print(json.dumps(record), flush=True)

try:
    snapshot('python')
    if mode == 'server':
        import app.ui
        snapshot('server_imports')
    else:
        import torch
        from sentence_transformers import SentenceTransformer
        snapshot('ml_imports', mps_available=torch.backends.mps.is_available())
        if not torch.backends.mps.is_available():
            raise RuntimeError('MPS unavailable; do not substitute CPU')
        config = {'audio_config': None}
        if mode.startswith('text'):
            config['vision_config'] = None
        dtype = torch.bfloat16 if mode.endswith('bf16') else torch.float32
        start = time.perf_counter()
        model = SentenceTransformer(str(ROOT / 'data/models/hub/models--google--embeddinggemma-2/snapshots/2c791de4ddbe5cabd592cc93692f7acb67e52555'), device='mps', config_kwargs=config, model_kwargs={'torch_dtype': dtype}, local_files_only=True)
        snapshot('loaded', seconds=time.perf_counter()-start, parameter_mib=sum(p.numel()*p.element_size() for p in model.parameters())/2**20)
        texts = ['task: search result | query: temperature at which water freezes', 'title: Facts | text: Water freezes at zero degrees Celsius.', 'title: Cats | text: A domestic feline sleeps indoors.', 'task: search result | query: חתול ישן בבית']
        start = time.perf_counter()
        vectors = model.encode(texts, normalize_embeddings=True, batch_size=4, show_progress_bar=False)
        snapshot('text_encoded', seconds=time.perf_counter()-start, finite=bool(__import__('numpy').isfinite(vectors).all()))
        __import__('numpy').save(ROOT / f'outputs/memory-research/{mode}-text.npy', vectors)
        if not mode.startswith('text'):
            from PIL import Image
            images = [Image.new('RGB', (512,512), c) for c in ['red','blue']]
            iv = model.encode([{'image': im} for im in images], normalize_embeddings=True, batch_size=1, show_progress_bar=False)
            __import__('numpy').save(ROOT / f'outputs/memory-research/{mode}-image.npy', iv)
            snapshot('image_encoded', finite=bool(__import__('numpy').isfinite(iv).all()))
        torch.mps.empty_cache()
        snapshot('empty_cache_model_live')
        if mode == 'full-fp32':
            from app.ingest import extract_units, _converter
            from io import BytesIO
            from PIL import Image, ImageDraw
            from types import SimpleNamespace
            source = Image.new('RGB', (1200,1600), 'white')
            ImageDraw.Draw(source).text((100,300), 'CAT RESTS ON SOFA', fill='black', font_size=60)
            pdf = BytesIO()
            source.save(pdf, format='PDF')
            units, visual, warnings = extract_units({'filename':'synthetic.pdf','mime_type':'application/pdf'}, pdf.getvalue(), SimpleNamespace(tokenizer=model.tokenizer))
            snapshot('docling_pdf', text_units=len(units), images=len(visual), warnings=warnings)
            del units, visual, source, pdf
            gc.collect()
            torch.mps.empty_cache()
            snapshot('docling_results_released')
            _converter.cache_clear()
        del model
        gc.collect()
        torch.mps.empty_cache()
        snapshot('models_released')
        time.sleep(1)
        snapshot('models_released_after_1s')
        time.sleep(4)
        snapshot('models_released_after_5s')
except Exception as exc:
    snapshot('error', error=f'{type(exc).__name__}: {exc}')
finally:
    (ROOT / f'outputs/memory-research/{mode}.json').write_text(json.dumps(records, indent=2))
