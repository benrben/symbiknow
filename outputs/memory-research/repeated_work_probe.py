"""Count repeated work in current functions using synthetic, isolated inputs.

No models, live server, OCFL repository, or real database are opened.
These counts are not RAM or latency benchmarks. Run from the repository root:
    .venv/bin/python outputs/memory-research/repeated_work_probe.py
"""

import ast
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import storage  # noqa: E402


def source_function(relative_path, name, namespace):
    """Execute just the reviewed function, with explicit fake dependencies."""
    path = ROOT / relative_path
    tree = ast.parse(path.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"), namespace)
    return namespace[name]


def history_counts():
    results = []
    for count in (1, 10, 100, 1000):
        calls = []

        def fake_run(_data_dir, *args):
            calls.append(args[0])
            if args[0] == "log":
                return "".join(f"v{i}\tdate\n" for i in range(1, count + 1)).encode()
            version = args[2]
            return json.dumps({
                "document_id": "example", "version": version, "request_id": version,
            }).encode()

        with patch.object(storage, "_run", fake_run):
            # save_file evaluates this eager list before checking even the newest receipt.
            found = next(v for v in reversed(storage.list_versions("unused", "example"))
                         if v["request_id"] == f"v{count}")
        assert found["version"] == f"v{count}"
        results.append({"versions": count, "log_calls": calls.count("log"),
                        "metadata_calls": calls.count("cat")})
    return results


def recovery_counts():
    rows = [{"document_id": f"d{i}", "version": "v1", "folder": "", "groups": []}
            for i in range(100)]

    class FakeTable:
        def search(self): return self
        def where(self, _condition): return self
        def select(self, _columns): return self
        def limit(self, _limit): return self
        def count_rows(self): return len(rows)
        def to_batches(self): return [SimpleNamespace(to_pylist=lambda: rows)]

    updates = []
    recover = source_function("app/search.py", "recover_organization_filters", {
        "INDEX_LOCK": threading.RLock(), "_table": lambda *_: FakeTable(),
        "_set_chunk_filters": lambda _directory, row: updates.append(row["document_id"]),
    })
    recover("unused")
    first = len(updates)
    recover("unused")
    return {"indexed_documents": len(rows), "first_run_update_calls": first,
            "unchanged_second_run_update_calls": len(updates) - first}


def concurrent_thumbnail_counts():
    from PIL import Image

    original = BytesIO()
    Image.new("RGB", (32, 32), "blue").save(original, "PNG")
    workers = 4
    barrier = threading.Barrier(workers)
    calls = []

    def fake_read(*_args):
        calls.append(1)
        # Hold every cache miss here until all four enter the generation path.
        barrier.wait(timeout=10)
        return original.getvalue(), {"mime_type": "image/png"}

    with tempfile.TemporaryDirectory(prefix="symbiknow-preview-probe-") as directory:
        render = source_function("app/ui.py", "thumbnail", {
            "server": SimpleNamespace(DATA_DIR=Path(directory), write_lock=threading.RLock()),
            "storage": SimpleNamespace(_validate_id=storage._validate_id,
                                       _validate_version=storage._validate_version,
                                       read_file=fake_read),
            "BytesIO": BytesIO, "Path": Path, "tempfile": tempfile,
            "Response": lambda content, **_kwargs: content,
        })
        with ThreadPoolExecutor(max_workers=workers) as pool:
            responses = list(pool.map(lambda _: render("example", "v1"), range(workers)))
        assert all(response == responses[0] for response in responses)
        render("example", "v1")
        return {"simultaneous_requests_for_same_uncached_image": workers,
                "source_reads_and_generation_path_entries": len(calls),
                "subsequent_cached_request_added_source_reads": len(calls) - workers}


if __name__ == "__main__":
    report = {"kind": "synthetic dependency-isolated call counts; not RAM/latency",
              "history": history_counts(), "startup_recovery": recovery_counts(),
              "thumbnail": concurrent_thumbnail_counts()}
    destination = Path(__file__).with_name("repeated-work-results.json")
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
