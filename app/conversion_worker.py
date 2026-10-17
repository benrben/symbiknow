"""One conversion per process. Only paths cross the process boundary."""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time


def start_guard(parent_pid, timeout, destination):
    """Do not leave OCR models behind after a killed server or stuck conversion."""
    finished = threading.Event()
    deadline = time.monotonic() + timeout

    def watch():
        while not finished.wait(0.25):
            orphaned = os.getppid() != parent_pid
            if orphaned or time.monotonic() >= deadline:
                root = Path(destination).resolve()
                if (
                    orphaned
                    and root.name.startswith("symbiknow-convert-")
                    and root.parent == Path(tempfile.gettempdir()).resolve()
                ):
                    shutil.rmtree(root, ignore_errors=True)
                os._exit(125 if orphaned else 124)

    threading.Thread(target=watch, name="conversion-lifetime", daemon=True).start()
    return finished


def main():
    source, destination, filename, parent_pid = sys.argv[1:]
    finished = start_guard(
        int(parent_pid),
        float(os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300")) + 30,
        destination,
    )
    try:
        convert(source, destination, filename)
    except Exception as exc:
        (Path(destination) / "result.json").write_text(
            json.dumps(
                {
                    "error": type(exc).__name__,
                    "permanent": isinstance(exc, (ValueError, UnicodeError)),
                }
            )
        )
        raise
    finally:
        finished.set()


def convert(source, destination, filename):
    from app.ingest import _converter
    from docling.datamodel.base_models import ConversionStatus

    result = _converter().convert(
        Path(source), max_num_pages=int(os.getenv("SYMBIKNOW_MAX_PAGES", "1000"))
    )
    if result.status not in {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}:
        raise ValueError(f"Docling conversion status: {result.status}")
    result.document.name = filename
    root = Path(destination)
    result.document.save_as_json(root / "document.json")
    (root / "result.json").write_text(
        json.dumps({"partial": result.status == ConversionStatus.PARTIAL_SUCCESS})
    )


if __name__ == "__main__":
    main()
