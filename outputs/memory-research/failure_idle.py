"""Ten-minute real-wall-time retry/model-load probe, isolated OCFL data."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.pop('TYPESAFE_API_KEY', None)
from app import server, storage
from app.embeddings import get_embedder
with tempfile.TemporaryDirectory(prefix='symbiknow-failure-idle-') as temporary:
    server.DATA_DIR = Path(temporary); server.STORAGE_ONLY = False
    storage.save_file(temporary, b'\xff\xfe\x80', 'damaged.txt')
    server.stop.clear(); server.retry_ids.clear()
    worker = threading.Thread(target=server._worker, daemon=True)
    worker.start(); start = time.monotonic(); samples = []
    while time.monotonic() - start < 600:
        time.sleep(10)
        from app.retry import state
        meta = storage.list_documents(temporary)[0]
        samples.append({'seconds':time.monotonic()-start,'retry':state(temporary, meta), 'model':get_embedder().stats()})
        server.wake.set()  # New work must not bypass a paused failure.
        Path(__file__).with_name('failure-idle-live.json').write_text(json.dumps(samples,indent=2))
    server.stop.set(); server.wake.set(); worker.join()
    Path(__file__).with_name('failure-idle-final.json').write_text(json.dumps({'wall_seconds':time.monotonic()-start, 'samples':samples},indent=2))
