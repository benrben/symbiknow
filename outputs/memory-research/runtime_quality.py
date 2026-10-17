"""Actual production adapters, same preprocessed corpus, no user's data.
Compares text-only/full text, English/Hebrew, image search, and legacy-vector search.
This is a regression gate, not representative production-quality certification.
Run with Metal access and pinned MLX PYTHONPATH, HF_HOME. Saves vectors & JSON.
"""
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.embeddings import EmbeddingGemma2, MLXEmbeddingGemma2
from PIL import Image
base = Path(__file__).parent / 'quantization'
fixtures = json.loads((base / 'fixtures.json').read_text())
report = {'synthetic_only': True, 'thresholds': {'min_cosine': .995, 'allowed_top1_regressions': 1, 'image_top1': 12}, 'runtimes': {}}
outputs = {}
for name, cls in [('torch', EmbeddingGemma2), ('mlx', MLXEmbeddingGemma2)]:
    start = time.perf_counter()
    runtime = cls(vision=False)
    def encode(texts):
        return np.concatenate([runtime.encode(texts[i:i+4]) for i in range(0, len(texts), 4)])
    docs = encode(fixtures['documents']); queries = encode(fixtures['queries'])
    runtime.clear(); del runtime.model; runtime.clear(); del runtime
    runtime = cls(vision=True)
    full_queries = encode(fixtures['queries'])
    images = []
    for index in range(12):
        with Image.open(base / f'image-{index:02d}.png') as image:
            items = [image]
            images.append(runtime.encode(items, images=True))
    image_vectors = np.concatenate(images)
    image_queries = encode(fixtures['image_queries'])
    outputs[name] = {'documents': docs, 'queries': queries, 'images': image_vectors, 'image_queries': image_queries}
    report['runtimes'][name] = {'top1': int(np.sum(np.argmax(queries @ docs.T, axis=1) == fixtures['expected'])),
        'image_top1': int(np.sum(np.argmax(image_queries @ image_vectors.T, axis=1) == np.arange(12))),
        'text_full_max_difference': float(np.abs(queries-full_queries).max()), 'seconds': time.perf_counter()-start}
    runtime.clear(); del runtime.model; runtime.clear(); del runtime
    np.savez(Path(__file__).parent / f'production-{name}-vectors.npz', **outputs[name])
report['min_query_cosine'] = float(np.sum(outputs['torch']['queries'] * outputs['mlx']['queries'], axis=1).min())
report['mlx_query_on_float32_top1'] = int(np.sum(np.argmax(outputs['mlx']['queries'] @ outputs['torch']['documents'].T, axis=1) == fixtures['expected']))
report['passed_synthetic_regression'] = (report['min_query_cosine'] >= .995 and report['mlx_query_on_float32_top1'] >= report['runtimes']['torch']['top1'] - 1 and report['runtimes']['mlx']['image_top1'] == 12)
(Path(__file__).parent / 'production-adapter-quality.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
