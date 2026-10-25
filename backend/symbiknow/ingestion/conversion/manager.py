"""One bounded, reusable Docling worker lane; no embedding model lives here."""

from symbiknow.core.paths import REPO_ROOT

import atexit
import json
import os
import queue
import subprocess
import sys
import threading
import uuid


class ConversionBusy(RuntimeError):
    pass


class ConversionManager:
    def __init__(self, *, capacity=8, max_jobs=16, max_rss_bytes=512 * 1024**2,
                 timeout=None, command=None, idle_seconds=15):
        if capacity < 1 or max_jobs < 1 or max_rss_bytes < 1:
            raise ValueError("Conversion worker budgets must be positive")
        self.slots = threading.BoundedSemaphore(capacity)
        self.lock = threading.RLock()
        self.max_jobs, self.max_rss_bytes = max_jobs, max_rss_bytes
        self.timeout = float(os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300")) + 30 if timeout is None else timeout
        if self.timeout <= 0:
            raise ValueError("Conversion deadline must be positive")
        self.command = command
        if idle_seconds <= 0:
            raise ValueError("Conversion idle lifetime must be positive")
        self.idle_seconds = idle_seconds
        self.process = None
        self.reader = None
        self.responses = None
        self.jobs = self.starts = self.completed = self.restarts = 0
        self.closed = False
        self.configuration = None

    def _start(self):
        self.configuration = (os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300"),
                              os.getenv("SYMBIKNOW_MAX_PAGES", "1000"),
                              os.getenv("SYMBIKNOW_CONVERSION_DEVICE", "cpu"))
        self.responses = queue.Queue(maxsize=2)
        process = subprocess.Popen(
            self.command or [sys.executable, "-m", "symbiknow.ingestion.conversion.worker", str(os.getpid()), str(self.idle_seconds)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd=REPO_ROOT,
        )
        self.process = process
        responses = self.responses

        def read():
            try:
                for line in process.stdout:
                    try:
                        responses.put_nowait(line)
                    except queue.Full:
                        process.terminate()
                        return
            finally:
                try:
                    responses.put_nowait(None)
                except queue.Full:
                    pass

        self.reader = threading.Thread(target=read, daemon=True, name="conversion-response")
        self.reader.start()
        self.jobs = 0
        self.starts += 1

    def _stop(self):
        if self.process is not None:
            process = self.process
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            if self.reader:
                self.reader.join(timeout=2)
            process.stdin.close()
            process.stdout.close()
            self.process = None
            self.reader = None
            self.restarts += 1

    def convert(self, source, destination, filename, *, heavy=False):
        if not self.slots.acquire(blocking=False):
            raise ConversionBusy("Conversion queue is full; committed originals will retry")
        try:
            with self.lock:
                if self.closed:
                    raise RuntimeError("Conversion manager is closed")
                configuration = (os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300"),
                                 os.getenv("SYMBIKNOW_MAX_PAGES", "1000"),
                                 os.getenv("SYMBIKNOW_CONVERSION_DEVICE", "cpu"))
                if self.process is not None and (
                        self.process.poll() is not None or configuration != self.configuration):
                    self._stop()
                if self.process is None:
                    self._start()
                identity = uuid.uuid4().hex
                request = dict(id=identity, source=str(source), destination=str(destination),
                               filename=filename, timeout=self.timeout)
                try:
                    self.process.stdin.write(json.dumps(request) + "\n")
                    self.process.stdin.flush()
                    try:
                        line = self.responses.get(timeout=self.timeout)
                    except queue.Empty as exc:
                        raise TimeoutError("Docling conversion deadline exceeded; original is safe") from exc
                    if line is None:
                        raise RuntimeError("Conversion worker exited")
                    result = json.loads(line)
                    if result.get("id") != identity:
                        raise RuntimeError("Invalid conversion worker response")
                    if result.get("error"):
                        error = ValueError if result.get("permanent") else RuntimeError
                        hint = ("The file may be corrupt, encrypted or not a valid document of its type; upload a valid copy "
                                "as a new version. If other files of this type also fail, check OCR/model configuration."
                                if result["error"] == "ConversionError" else "Retry after checking OCR/model configuration.")
                        raise error(f"Docling conversion failed ({result['error']}); original is safe. {hint}")
                    self.jobs += 1
                    self.completed += 1
                    if (self.jobs >= self.max_jobs or result.get("rss_bytes", 0) >= self.max_rss_bytes
                            or heavy):
                        self._stop()
                    return result
                except (Exception, KeyboardInterrupt):
                    self._stop()
                    raise
        finally:
            self.slots.release()

    def close(self):
        with self.lock:
            self._stop()
            self.closed = True

    def stats(self):
        with self.lock:
            return dict(starts=self.starts, completed=self.completed, restarts=self.restarts,
                        alive=bool(self.process and self.process.poll() is None),
                        max_jobs=self.max_jobs, max_rss_bytes=self.max_rss_bytes, idle_seconds=self.idle_seconds)


_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def get_conversion_manager():
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None or _MANAGER.closed:
            _MANAGER = ConversionManager()
        return _MANAGER


def close_conversion_manager():
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is not None:
            _MANAGER.close()
            _MANAGER = None


atexit.register(close_conversion_manager)
