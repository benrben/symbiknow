"""Rebuild the current report from raw PyTorch artifacts, preserving history."""
import json
from pathlib import Path

OUT = Path(__file__).parent


def read(name):
    return json.loads((OUT / name).read_text())


def server(name):
    data = read(name)
    assert data['isolated'] and data['fixture_creation_outside_server']
    assert data['server_exit_code'] == 0
    assert all(w['original_sha256_verified'] for w in data['workloads'])
    idle = next(s for s in data['stages'] if s['stage'] == 'idle_66s')
    assert not idle['runtime']['model']['loaded']
    return {
        'source': name,
        'peak_simultaneous_physical_bytes': data['observed_peak_simultaneous_physical_bytes'],
        'warm_search_median_seconds': data['warm_search_median_seconds'],
        'reload_after_idle_seconds': data['cold_search_seconds'],
        'idle_simultaneous_physical_bytes': sum(p['physical_bytes'] for p in idle['native']),
        'workloads': data['workloads'],
    }


assert '21 passed' in (OUT / 'browser-final.log').read_text()
assert '23 passed' in (OUT / 'resource-tests.log').read_text()
full = read('full-tests-result.json')
assert full['exit_code'] == 0 and full['passed'] == 273
approval = read('live-int8-approval.json')
assert approval['approved']
live = read('live-int8.json')
assert live['inventories_unchanged'] and live['after']['library_total'] == 89
assert all(s['runtime']['runtime'] == 'torch' and
           s['runtime']['model']['torch_quantization'] == 'int8' for s in live['samples'])
assert not live['samples'][-1]['runtime']['model']['loaded']
assert live['samples'][-1]['runtime']['model']['mps']['active_bytes'] == 0
pdf = read('torch-int8-real-pdf.json')
assert pdf['passed'] and pdf['original_sha256_verified']
overlap = read('torch-int8-overlap.json')
assert overlap['image_status'] == 'indexed' and overlap['visual_search_has_photo']
quality = read('production-guide-torch-int8.json')
report = {
    'selected_runtime': 'torch',
    'quantization': 'torchao-0.17.0-int8-group16/float32-text/bfloat16-vision',
    'completed_tasks': list(range(1, 21)),
    'task1_revised_scope': 'User selected 8-bit PyTorch without MLX.',
    'tests': {'full_backend': full, 'related_browser': '21 passed',
              'resource_recovery': '23 passed', 'repeat_drag_undo_log': 'drag-repeated.log',
              'build': 'production-build.log', 'lint': 'ruff-final.log'},
    'matched_5_document_workload': {
        'float32_before_preconversion_unload': server('server-none-bench.json'),
        'float32_after_preconversion_unload': server('server-none-matched10-bench.json'),
        'int8_after_preconversion_unload': server('server-int8-matched10-bench.json'),
    },
    'long_pdf_sweep_before_preconversion_unload': server('server-int8-bench.json'),
    'dense_scanned_pdf': {'checks': pdf, 'memory': read('dense-int8-summary.json')},
    'overlapping_search_ingestion': overlap,
    'model_only_idle_cycles': {p: read(f'torch-cycles-{p}.json') for p in ('none', 'int8')},
    'existing_index_validation': approval['validation'],
    'live': live,
    'quality': {mode: value['summary'] for mode, value in quality['modes'].items()},
    'fallback_quality': {mode: value['summary'] for mode, value in quality['float32_queries_on_int8'].items()},
    'limitations': [
        'Generated bilingual labels are not independent production certification.',
        'The baseline also misses the historical absolute 90% top-three gate; precision-preservation checks passed.',
        'Hebrew queries over English guides remain less accurate than English queries.',
        'GPU counters overlap process physical footprint and must not be added.',
        '3.98 GiB is a matched workload observation, not an OCR ceiling; dense OCR reached about 5.00 GiB.',
        'Idle is about 1 GiB; eight-bit storage does not make every active workload fit in 1 GiB.',
        'Other applications ran concurrently; observations do not establish capacity or a whole-system ceiling.',
        '8-bit execution was tested on Apple M5 Pro MPS; CPU/CUDA use the explicit unquantized fallback.',
    ],
}
(OUT / 'summary.json').write_text(json.dumps(report, indent=2))
print(json.dumps({'completed': 20, 'runtime': 'torch/int8', 'pid': live['after_pid'],
                  'live_idle_MiB': live['samples'][-1]['native']['physical_bytes'] / 2**20,
                  'documents': live['after']['library_total']}, indent=2))
