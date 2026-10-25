"""One owner for bounded preview work, keyed in-flight coalescing and disk cleanup."""

import asyncio
import json
from io import BytesIO
from symbiknow.library import storage
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import threading
import time

# Includes original raster/PDF renderer settings. Extraction-based cards bind
# their response reuse to the published index and organization revisions.
RENDERER_REVISION = "preview-2"


class PreviewBusy(ValueError):
    pass


class PreviewJobs:
    def __init__(self, workers=2, capacity=10):
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="symbiknow-preview")
        self.capacity = capacity
        self.lock = threading.RLock()
        self.flights = {}

    def submit(self, key, function, *args):
        with self.lock:
            if key in self.flights:
                return self.flights[key]
            if len(self.flights) >= self.capacity:
                raise PreviewBusy("Preview queue is full; retry shortly")
            future = self.pool.submit(function, *args)
            self.flights[key] = future

            def finished(_):
                with self.lock:
                    self.flights.pop(key, None)

            future.add_done_callback(finished)
            return future

    def run(self, key, function, *args):
        return self.submit(key, function, *args).result()

    async def wait(self, key, function, *args):
        # Canceling a waiter must not cancel shared work or release a running renderer's slot.
        return await asyncio.shield(asyncio.wrap_future(self.submit(key, function, *args)))

    def drain(self):
        with self.lock:
            futures = list(self.flights.values())
            for future in futures:
                future.cancel()  # Only queued jobs; running renderers retain capacity.
        for future in futures:
            try:
                future.result()
            except Exception:
                pass

    def shutdown(self):
        self.pool.shutdown(wait=True, cancel_futures=True)


JOBS = PreviewJobs()


def prune(root, keep):
    budget = int(os.getenv("SYMBIKNOW_PREVIEW_CACHE_BYTES", str(256 * 1024**2)))
    age = float(os.getenv("SYMBIKNOW_PREVIEW_CACHE_SECONDS", str(7 * 86400)))
    total = 0
    for path in sorted(Path(root).glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True):
        total += path.stat().st_size
        if path != keep and (total > budget or time.time() - path.stat().st_mtime > age):
            path.unlink(missing_ok=True)
            path.with_suffix(".json").unlink(missing_ok=True)


def cached(context, path, doc_id, version, *, page=False):
    """Copy a bounded preview while holding the same lock as eviction/deletion."""
    with context.write_lock:
        info_path = path.with_suffix(".json")
        if not path.exists() or (page and not info_path.exists()):
            return None
        storage.read_metadata(context.DATA_DIR, doc_id, version)
        headers = {
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        }
        if page:
            headers["X-PDF-Page-Count"] = str(json.loads(info_path.read_text())["pages"])
        content = path.read_bytes()
        return content, headers


def render_thumbnail(context, doc_id, version):
    from symbiknow.previews.service import RENDERER_REVISION
    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("Thumbnail must pin a version")
    path = context.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}-{RENDERER_REVISION}.jpg"
    result = cached(context, path, doc_id, version)
    if result is not None:
        return result
    from PIL import Image

    metadata = storage.read_metadata(context.DATA_DIR, doc_id, version)
    if metadata["mime_type"] == "application/pdf" and metadata["size"] > 32 * 1024**2:
        raise ValueError("PDF is too large for a thumbnail; open or download the original")
    with storage.verified_file(context.DATA_DIR, doc_id, version) as (source_path, metadata):
        if metadata["mime_type"] == "application/pdf":
            import subprocess
            import sys

            try:
                content = subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("pdf.py")),
                        str(source_path),
                    ],
                    check=True,
                    timeout=20,
                    capture_output=True,
                ).stdout
            except (subprocess.SubprocessError, OSError):
                raise ValueError(
                    "PDF thumbnail unavailable; open or download the original"
                ) from None
            source_input = BytesIO(content)
        else:
            source_input = source_path
        with Image.open(source_input) as source:
            source.thumbnail((264, 340))
            output = BytesIO()
            rgb = source.convert("RGB")
            try:
                rgb.save(output, format="JPEG", quality=85)
            finally:
                rgb.close()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with context.write_lock:
        if storage.current_version(context.DATA_DIR, doc_id) is None:
            raise FileNotFoundError("Document deleted during preview")
        temporary.write_bytes(output.getvalue())
        temporary.replace(path)
        return cached(context, path, doc_id, version)


def render_page(context, doc_id, version, page_number):
    """Reader-sized page image; originals and the first-page card cache stay separate."""
    import subprocess
    import sys
    from symbiknow.previews.service import RENDERER_REVISION

    storage._validate_id(doc_id)
    storage._validate_version(version)
    if not version:
        raise ValueError("PDF preview must pin a version")
    page_number = int(page_number)
    if not 1 <= page_number <= 10000:
        raise ValueError("PDF page is out of range")
    path = context.DATA_DIR / "temp" / "thumbnails" / f"{doc_id}-{version}-page-{page_number}-{RENDERER_REVISION}.jpg"
    info_path = path.with_suffix(".json")
    result = cached(context, path, doc_id, version, page=True)
    if result is not None:
        return result
    metadata = storage.read_metadata(context.DATA_DIR, doc_id, version)
    if metadata["mime_type"] != "application/pdf":
        raise ValueError("Page preview requires a PDF")
    if metadata.get("size", 0) > 32 * 1024 * 1024:
        raise ValueError("PDF is too large for an inline preview; open or download the original")
    with storage.verified_file(context.DATA_DIR, doc_id, version) as (input_path, _):
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("pdf.py")),
                    str(input_path),
                    str(page_number),
                    "1400",
                ],
                check=True,
                timeout=20,
                capture_output=True,
            )
            page_count = int(result.stderr.decode().rsplit("pages:", 1)[1].strip())
        except (subprocess.SubprocessError, OSError, ValueError, IndexError):
            raise ValueError("PDF page unavailable or out of range; open the original") from None
    with context.write_lock:
        if storage.current_version(context.DATA_DIR, doc_id) is None:
            raise FileNotFoundError("Document deleted during preview")
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_suffix(".tmp")
        staging.write_bytes(result.stdout)
        staging.replace(path)
        info_staging = info_path.with_suffix(".json.tmp")
        info_staging.write_text(json.dumps({"pages": page_count}))
        info_staging.replace(info_path)
        return cached(context, path, doc_id, version, page=True)



def preview_path(context, identity, version, page=None):
    storage._validate_id(identity)
    storage._validate_version(version)
    if not version:
        raise ValueError("Preview must pin a version")
    if page is not None and (type(page) is not int or not 1 <= page <= 10000):
        raise ValueError("PDF page is out of range")
    suffix = f"-page-{page}" if page is not None else ""
    return context.DATA_DIR / "temp" / "thumbnails" / f"{identity}-{version}{suffix}-{RENDERER_REVISION}.jpg"


def request(context, identity, version, page=None):
    from symbiknow.core.cache import dependency_key
    path = preview_path(context, identity, version, page)
    if cached(context, path, identity, version, page=page is not None) is not None:
        return {"ready": True}
    metadata = storage.read_metadata(context.DATA_DIR, identity, version)
    if page is not None and metadata["mime_type"] != "application/pdf":
        raise ValueError("Page preview requires a PDF")
    if metadata["mime_type"] == "application/pdf" and metadata["size"] > 32 * 1024**2:
        raise ValueError("PDF is too large for an inline preview; open or download the original")
    args = {"document_id": identity, "version": version, "page": page}
    identity = dependency_key("preview-job", **args, renderer=RENDERER_REVISION)
    try:
        previous = context.work.get("jobs", identity)
    except FileNotFoundError:
        previous = None
    if previous and previous["state"] == "completed":
        context.work.enqueue("jobs", identity, {"kind": "preview", "args": args}, replace=True)
    return context.jobs.start("preview", args, identity)


def prepare(context, document_id, version, page=None):
    if page is None:
        render_thumbnail(context, document_id, version)
    else:
        render_page(context, document_id, version, page)
    prune(context.DATA_DIR / "temp" / "thumbnails", preview_path(context, document_id, version, page))
    return {"ready": True}
