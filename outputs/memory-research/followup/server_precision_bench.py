"""Actual isolated HTTP owners; fixtures are prepared OUTSIDE measured server trees.

Matched float32/INT8 text, image, 16 MiB transfer and 10-page PDF; INT8 also 100/250.
Never opens the user's storage/index. No hosted calls. Native charges and GPU
counters are recorded separately, never summed. Run on Apple Silicon macOS.
"""
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
LIB = ctypes.CDLL("/usr/lib/libproc.dylib")


def native(pid):
    lines = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss="], text=True).splitlines()
    processes = {int(a): (int(b), int(c) * 1024) for a, b, c in (line.split() for line in lines)}
    selected = {pid}
    for _ in range(8):
        selected.update(p for p, (parent, _) in processes.items() if parent in selected)
    values = []
    for p in selected:
        data = ctypes.create_string_buffer(1024)
        if p in processes and LIB.proc_pid_rusage(p, 0, data) == 0:
            values.append({"pid": p, "root": p == pid, "rss_bytes": processes[p][1],
                           "physical_bytes": ctypes.c_uint64.from_buffer(data, 72).value})
    return values


def run(precision, fixtures):
    with tempfile.TemporaryDirectory(prefix=f"symbiknow-server-{precision}-") as temporary:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        env = {**os.environ, "SYMBIKNOW_DATA_DIR": temporary, "SYMBIKNOW_STORAGE_ONLY": "0",
               "SYMBIKNOW_EMBEDDING_RUNTIME": "torch", "SYMBIKNOW_TORCH_QUANTIZATION": precision,
               "SYMBIKNOW_EMBEDDING_DEVICE": "mps", "SYMBIKNOW_MODEL_IDLE_SECONDS": "60",
               "HF_HOME": str(ROOT / "data/models"), "HF_HUB_OFFLINE": "1", "TYPESAFE_API_KEY": ""}
        env.pop("PYTHONPATH", None)
        label = precision + ("-" + os.environ["SERVER_BENCH_TAG"] if os.getenv("SERVER_BENCH_TAG") else "")
        log = (OUT / f"server-{label}.log").open("w")
        owner = subprocess.Popen([str(ROOT / ".venv/bin/python"), "-m", "app.server", "--web", "--port", str(port)],
                                 cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        report = {"precision": precision, "isolated": True, "fixture_creation_outside_server": True,
                  "native_samples": [], "gpu_samples": [], "stages": [], "workloads": []}
        stage = "startup"
        stop = threading.Event()

        def request(route, body=None, timeout=180):
            data = json.dumps(body).encode() if body is not None else None
            headers = {"Content-Type": "application/json", "Origin": url, "X-Symbiknow-UI": "1"}
            with urllib.request.urlopen(urllib.request.Request(url + route, data=data, headers=headers), timeout=timeout) as response:
                return json.load(response)

        def sample_native():
            while not stop.is_set():
                report["native_samples"].append({"stage": stage, "time": time.monotonic(), "processes": native(owner.pid)})
                stop.wait(.2)

        def sample_gpu():
            while not stop.is_set():
                try:
                    report["gpu_samples"].append({"stage": stage, "time": time.monotonic(), "runtime": request("/api/runtime", timeout=5)})
                except (OSError, ValueError):
                    pass
                stop.wait(1)

        def checkpoint(label):
            value = {"stage": label, "native": native(owner.pid), "runtime": request("/api/runtime")}
            report["stages"].append(value)
            print(precision, label, json.dumps(value), flush=True)

        def upload(path, mime):
            size = path.stat().st_size
            with path.open("rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            receipt = uuid.uuid4().hex
            with path.open("rb") as f:
                for offset in range(0, size, 262144):
                    chunk = f.read(262144)
                    args = {"filename": path.name, "mime_type": mime, "request_id": receipt,
                            "offset": offset, "total_size": size, "sha256": digest,
                            "content_base64": base64.b64encode(chunk).decode(), "final": offset + len(chunk) == size}
                    item = request("/api/upload", {"files": [args]})["files"][0]
                    assert not item.get("error"), item
            assert item["stored"]
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                library = request("/api/library?limit=100")
                row = next((d for d in library["documents"] if d["document_id"] == item["document_id"]), {})
                if row.get("status") in {"indexed", "skipped", "unsupported"}:
                    break
                assert row.get("status") != "failed", row.get("index_error")
                time.sleep(.5)
            else:
                raise RuntimeError("Isolated ingestion did not complete")
            h = hashlib.sha256()
            with urllib.request.urlopen(url + "/api/download?id=" + item["document_id"], timeout=120) as response:
                for chunk in iter(lambda: response.read(262144), b""):
                    h.update(chunk)
            assert h.hexdigest() == digest
            return item

        threads = [threading.Thread(target=sample_native), threading.Thread(target=sample_gpu)]
        try:
            for _ in range(240):
                assert owner.poll() is None, "server exited; see owner log"
                try:
                    request("/api/library?limit=1", timeout=2); break
                except (OSError, ValueError):
                    time.sleep(.25)
            else:
                raise RuntimeError("Server startup timed out")
            for thread in threads: thread.start()
            checkpoint("startup_idle")
            for name, mime in [("english.txt", "text/plain"), ("hebrew.txt", "text/plain"),
                               ("large.bin", "application/octet-stream"), ("cat.png", "image/png")]:
                stage = name
                start = time.perf_counter(); upload(fixtures / name, mime)
                report["workloads"].append({"name": name, "seconds": time.perf_counter() - start, "original_sha256_verified": True})
                checkpoint(name + "_complete")
            counts = tuple(map(int, os.environ["SERVER_BENCH_PAGES"].split(","))) if os.getenv("SERVER_BENCH_PAGES") else ((10,) if precision == "none" else (10, 100, 250))
            for pages in counts:
                stage = f"pdf{pages}"
                start = time.perf_counter(); upload(fixtures / f"pages{pages}.pdf", "application/pdf")
                report["workloads"].append({"name": stage, "seconds": time.perf_counter() - start, "original_sha256_verified": True})
                checkpoint(stage + "_complete")
                time.sleep(5); checkpoint(stage + "_settled_5s")
            stage = "warm_searches"
            times = []
            for index in range(8):
                start = time.perf_counter()
                response = request("/api/search", {"query": "cat on a sofa" if index % 2 else "חתול נח על הספה", "mode": "semantic", "limit": 10, "evaluate": False})
                assert response["status"] == "ok" and response["matches"]
                times.append(time.perf_counter() - start)
            report["warm_search_median_seconds"] = statistics.median(times[1:])
            checkpoint("after_searches")
            stage = "idle_66s"
            for _ in range(66): time.sleep(1)
            checkpoint("idle_66s")
            assert not report["stages"][-1]["runtime"]["model"]["loaded"]
            stage = "cold_search"
            start = time.perf_counter()
            response = request("/api/search", {"query": "חתול על הספה", "mode": "semantic", "limit": 10, "evaluate": False})
            assert response["status"] == "ok" and response["matches"]
            report["cold_search_seconds"] = time.perf_counter() - start
            report["library_total"] = request("/api/library?limit=100")["library_total"]
        finally:
            stop.set()
            for thread in threads:
                if thread.ident is not None: thread.join(timeout=10)
            owner.send_signal(signal.SIGINT)
            owner.wait(timeout=90)
            log.close()
            report["server_exit_code"] = owner.returncode
            report["observed_peak_simultaneous_physical_bytes"] = max((sum(p["physical_bytes"] for p in s["processes"]) for s in report["native_samples"]), default=0)
            report["limitations"] = ["GPU counters overlap physical footprint; never add them.",
                "Sparse generated PDFs; dense OCR can use more memory.", "200ms native and 1s GPU sampling can miss spikes.",
                "Hosted Jev disabled; browser memory is measured by separate transfer probes."]
            (OUT / f"server-{label}-bench.json").write_text(json.dumps(report, indent=2))


with tempfile.TemporaryDirectory(prefix="symbiknow-bench-inputs-") as inputs:
    inputs = Path(inputs)
    (inputs / "english.txt").write_text("A cat rests on the sofa in the house.")
    (inputs / "hebrew.txt").write_text("חתול נח על הספה בבית.")
    with (inputs / "large.bin").open("wb") as f:
        for _ in range(16): f.write(b"x" * 1024**2)
    (inputs / "cat.png").write_bytes((OUT.parent / "real-photos/chelsea.png").read_bytes())
    with Image.new("RGB", (800, 1000), "white") as page:
        for count in (10, 100, 250):
            page.save(inputs / f"pages{count}.pdf", "PDF", save_all=True, append_images=[page] * (count - 1))
    for precision in ("none", "int8"):
        run(precision, inputs)
