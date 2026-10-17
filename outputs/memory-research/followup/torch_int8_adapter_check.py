"""Reproduce the integrated-adapter/image comparison from saved vectors.

Optional --rebuild uses the real production adapter on isolated public inputs,
writing reproduced-* artifacts so the live approval's provenance stays intact.
"""
import json
import os
from pathlib import Path
import sys

import numpy as np

OUT = Path(__file__).parent
if '--rebuild' in sys.argv:
    os.environ.update(SYMBIKNOW_EMBEDDING_RUNTIME='torch', SYMBIKNOW_TORCH_QUANTIZATION='int8',
                      SYMBIKNOW_EMBEDDING_DEVICE='mps')
    import torch_int8_trial as trial
    from app import embeddings
    trial.TrialRuntime = embeddings.EmbeddingGemma2
    trial.LABEL = 'reproduced-production-adapter'
    trial.run()
    integrated = OUT / 'reproduced-production-adapter-vectors.npz'
else:
    integrated = OUT / 'torch-int8-production-adapter-vectors.npz'
with np.load(integrated) as current, np.load(OUT / 'torch-int8-group16-f32-vectors.npz') as trial:
    differences = {key: float(np.abs(current[key] - trial[key]).max()) for key in current.files}
    assert all(value == 0 for value in differences.values()), differences
    with np.load(OUT.parent / 'generated-quality-torch.npz') as baseline:
        expected = np.arange(10) % 5
        result = {
            'int8_query_float32_photos': int(np.sum(np.argmax(current['photo_queries'] @ baseline['photo_vectors'].T, axis=1) == expected)),
            'float32_query_int8_photos': int(np.sum(np.argmax(baseline['photo_queries'] @ current['photo_vectors'].T, axis=1) == expected)),
            'min_photo_cosine': float(np.sum(current['photo_vectors'] * baseline['photo_vectors'], axis=1).min()),
            'adapter_maximum_absolute_differences': differences,
        }
        assert result['int8_query_float32_photos'] == result['float32_query_int8_photos'] == 10
        assert result['min_photo_cosine'] > .995
print(json.dumps(result, indent=2))
