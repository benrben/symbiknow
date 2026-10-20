"""Reusable Docling process. Only bounded job descriptors and paths cross IPC."""

import contextlib
import gc
import json
import os
from pathlib import Path
import resource
import shutil
import sys
import tempfile
import threading
import time


_CONVERTER = None


def start_guard(parent_pid, timeout, destination):
    """Do not leave OCR models behind after a killed server or stuck conversion."""
    finished = threading.Event()
    deadline = time.monotonic() + timeout

    def watch():
        while not finished.wait(0.25):
            orphaned = os.getppid() != parent_pid
            if orphaned or time.monotonic() >= deadline:
                root = Path(destination).resolve()
                if (orphaned and root.name.startswith("symbiknow-convert-")
                        and root.parent == Path(tempfile.gettempdir()).resolve()):
                    shutil.rmtree(root, ignore_errors=True)
                os._exit(125 if orphaned else 124)

    threading.Thread(target=watch, name="conversion-lifetime", daemon=True).start()
    return finished


def convert(source, destination, filename):
    global _CONVERTER
    from symbiknow.ingestion.service import _converter
    from docling.datamodel.base_models import ConversionStatus

    if _CONVERTER is None:
        _CONVERTER = _converter()
    result = _CONVERTER.convert(
        Path(source), max_num_pages=int(os.getenv("SYMBIKNOW_MAX_PAGES", "1000"))
    )
    if result.status not in {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}:
        raise ValueError(f"Docling conversion status: {result.status}")
    result.document.name = filename
    root = Path(destination)
    result.document.save_as_json(root / "document.json")
    return {"partial": result.status == ConversionStatus.PARTIAL_SUCCESS}


def main():
    parent_pid = int(sys.argv[1])
    idle_seconds = float(sys.argv[2])
    # Idle workers also leave promptly after owner death or idle expiry. Per-job
    # guards below enforce deadlines even if native conversion hangs.
    lifetime = {"deadline": time.monotonic() + idle_seconds, "active": False}

    def watch_idle():
        while True:
            time.sleep(.25)
            if os.getppid() != parent_pid:
                if lifetime["active"]:
                    continue  # The job guard also removes its scratch directory.
                os._exit(125)
            if not lifetime["active"] and time.monotonic() > lifetime["deadline"]:
                os._exit(0)

    threading.Thread(target=watch_idle, daemon=True, name="conversion-idle").start()
    for line in sys.stdin:
        if len(line) > 64 * 1024:
            raise ValueError("Conversion request exceeds protocol budget")
        request = json.loads(line)
        lifetime["active"] = True
        finished = start_guard(parent_pid, float(request["timeout"]), request["destination"])
        try:
            # Docling libraries may print progress to stdout. Reserve it for IPC.
            with contextlib.redirect_stdout(sys.stderr):
                result = convert(request["source"], request["destination"], request["filename"])
            gc.collect()
            rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            result["rss_bytes"] = rss if sys.platform == "darwin" else rss * 1024
        except Exception as exc:
            result = {"error": type(exc).__name__,
                      "permanent": isinstance(exc, (ValueError, UnicodeError))}
        finally:
            finished.set()
            lifetime["deadline"] = time.monotonic() + idle_seconds
            lifetime["active"] = False
        print(json.dumps(dict(result, id=request["id"])), flush=True)
        if result.get("error"):
            break  # Failed converter state is never reused.


if __name__ == "__main__":
    main()
