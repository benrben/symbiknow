"""Bounded original reads at 1 and 100 MiB; temporary OCFL libraries only.

The first sample restarts the native metadata reader; OS caches are not flushed.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import resource
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from symbiknow.library import storage  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
results = []
with tempfile.TemporaryDirectory(prefix='symbiknow-range-benchmark-') as temporary:
    root = Path(temporary)
    block = bytes(range(256)) * 4096
    for size in (1, 100):
        source = root / 'input.bin'
        with source.open('wb') as handle:
            for _ in range(size):
                handle.write(block)
        started = time.perf_counter()
        saved = storage.save_file(root, source, f'{size}MiB.bin')
        commit_seconds = time.perf_counter() - started
        storage.close_readers()
        samples = []
        for number in range(31):
            started = time.perf_counter()
            with storage.verified_ranges(root, saved['document_id'], 'v1') as (reader, metadata):
                offset = (number * 123457) % (metadata['size'] - 262144)
                value = reader.read(offset, 262144)
                assert len(value) == 262144
                assert value == (block + block)[offset % len(block):offset % len(block) + len(value)]
            samples.append((time.perf_counter() - started) * 1000)
        ordered = sorted(samples[1:])
        result = dict(size_bytes=saved['size'], commit_seconds=commit_seconds,
                      first_native_reader_ms=samples[0],
                      **{f'p{p}_ms': ordered[math.ceil(p / 100 * len(ordered)) - 1] for p in (50,95,99)})
        results.append(result)
        print(json.dumps(result), flush=True)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = dict(scope=__doc__, results=results, peak_rss_bytes=peak if sys.platform == 'darwin' else peak * 1024,
                  integrity_index_bytes=(root / 'temp/original-ranges.sqlite3').stat().st_size,
                  source_sha256=hashlib.sha256(Path(storage.__file__).read_bytes()).hexdigest())
    (args.output / 'original-ranges.json').write_text(json.dumps(report, indent=2) + '\n')
    assert all(row['p95_ms'] < 200 and row['first_native_reader_ms'] < 300 for row in results)
