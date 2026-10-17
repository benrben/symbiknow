"""Aggregate current evidence and retain explicitly labelled historical results."""
import json
from pathlib import Path

OUT = Path(__file__).parent


def read(name):
    return json.loads((OUT / name).read_text())


def stages(name):
    return {s['stage']: s for s in read(name)['samples']}


a = stages('baseline-models-app.json')
b = stages('after-cpu-app.json')
current = read('followup/summary.json')
report = {
    'tasks_complete': current['completed_tasks'],
    'active_runtime': 'torch/int8',
    'task1': {'status': 'complete under revised user scope',
              'requirement': '8-bit PyTorch without MLX',
              'existing_index_validation': current['existing_index_validation']},
    'paired_cpu_historical': {
        'before_retained_physical_bytes': a['unloaded']['physical_footprint_bytes'],
        'after_retained_physical_bytes': b['unloaded']['physical_footprint_bytes'],
        'before_search_median_s': read('baseline-models-app.json')['timing_summary']['search']['median_s'],
        'after_search_median_s': read('after-cpu-app.json')['timing_summary']['search']['median_s'],
        'note': 'Matched CPU workload; separate from later MPS/INT8 server benchmarks.'},
    'historical_mlx_pdf': {},
    'historical_generated_quality': {k: v for k, v in read('generated-quality.json').items() if k != 'results'},
    'regular_pytorch_followup': current,
    'live': current['live'],
    'tests': current['tests'],
    'limits': current['limitations'],
}
for pages, name, tree in [
    (10, 'after-mlx-pdf10-final-app.json', 'pdf10-final-tree.json'),
    (100, 'after-mlx-pdf100-app.json', 'pdf100-tree.json'),
    (250, 'after-mlx-pdf250-app.json', 'pdf250-tree.json'),
]:
    data = read(name)
    report['historical_mlx_pdf'][str(pages)] = {
        'status': data['pdf_status'],
        'import_s': data['timing_summary']['pdf_import']['median_s'],
        'observed_simultaneous_physical_peak_bytes': read(tree)['peak_simultaneous_footprint_bytes'],
        'active_configuration': False,
    }
(OUT / 'implementation-summary.json').write_text(json.dumps(report, indent=2))
print(json.dumps({'tasks_complete': len(report['tasks_complete']),
                  'live_pid': report['live']['after_pid'],
                  'documents': report['live']['after']['library_total'],
                  'inventories_unchanged': report['live']['inventories_unchanged']}, indent=2))
