"""Rebuildable extraction artifacts; originals and durable receipts live elsewhere.

Schema 1 stores Docling's full JSON document, never cleaned evidence or vectors.
An incompatible descriptor is a cache miss. Removing this directory is the rollback
and recovery operation; committed originals and indexing retries remain authoritative.
"""

from importlib.metadata import version
import hashlib
import json
import os
from pathlib import Path
import tempfile

from filelock import FileLock

from symbiknow.core.cache import dependency_key


EXTRACTION_SCHEMA = 1
CONVERTER_REVISION = "docling-structure-2"


def extraction_descriptor():
    return {
        "schema": EXTRACTION_SCHEMA,
        "converter": CONVERTER_REVISION,
        "docling": version("docling"),
        "docling_core": version("docling-core"),
        "ocr": True,
        "tables": True,
        "page_images": False,
        "batch_size": 1,
        "queue_max_size": 4,
        "images_scale": 1.0,
        "max_pages": int(os.getenv("SYMBIKNOW_MAX_PAGES", "1000")),
        "timeout": float(os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300")),
    }


class ExtractionArtifacts:
    """Library-scoped disk budget, atomic publication and corruption recovery.

    The lock spans conversion so concurrent retries share the same completed work.
    It is independent of storage/index locks and must never be taken inside them.
    Eviction can discard artifacts, never originals or durable retry receipts.
    """

    def __init__(self, data_dir, *, max_entries=None, max_bytes=None):
        self.library = str(Path(data_dir).resolve())
        self.root = Path(self.library) / "temp" / "extraction-artifacts"
        self.max_entries = int(os.getenv("SYMBIKNOW_EXTRACTION_CACHE_ENTRIES", "256")) if max_entries is None else max_entries
        self.max_bytes = int(os.getenv("SYMBIKNOW_EXTRACTION_CACHE_BYTES", str(256 * 1024**2))) if max_bytes is None else max_bytes
        if self.max_entries < 0 or self.max_bytes < 0:
            raise ValueError("Extraction cache budgets must be nonnegative")
        self.hits = self.misses = 0

    def key(self, metadata, digest, *, descriptor=None):
        return dependency_key(
            "extraction", library=self.library, source_sha256=digest,
            document_id=metadata.get("document_id"), version=str(metadata["version"]),
            filename=metadata["filename"],
            mime_type=metadata.get("mime_type", ""), descriptor=descriptor or extraction_descriptor(),
        ).split(":", 1)[1]

    def document(self, metadata, digest, compute):
        from docling_core.types.doc import DoclingDocument

        self.root.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.root / ".lock")):
            # A previous owner may have died between staging and rename.
            for stage in self.root.glob(".stage-*"):
                stage.unlink(missing_ok=True)
            self._prune()
            descriptor = extraction_descriptor()
            identity = self.key(metadata, digest, descriptor=descriptor)
            source_id = metadata.get("document_id")
            prefix = _document_prefix(source_id) + "-" if source_id else ""
            target = self.root / f"{prefix}{identity}.json"
            try:
                record = json.loads(target.read_text())
                if (record["schema"] != EXTRACTION_SCHEMA or record["descriptor"] != descriptor
                        or record["identity"] != identity):
                    raise ValueError("Incompatible extraction artifact")
                doc = DoclingDocument.model_validate(record["document"])
                try:
                    os.utime(target, None)  # Unlike touch(), never recreate a concurrently deleted hit.
                except FileNotFoundError:
                    pass
                self.hits += 1
                return doc, []
            except (OSError, ValueError, KeyError, TypeError):
                target.unlink(missing_ok=True)
            self.misses += 1
            doc, warnings = compute()
            # Partial/OCR-failed results may improve on retry; retain only complete success.
            if not warnings and self.max_entries and self.max_bytes:
                record = {"schema": EXTRACTION_SCHEMA, "descriptor": descriptor, "identity": identity,
                          "document": doc.model_dump(mode="json")}
                stage = None
                try:
                    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.root,
                                                     prefix=f".stage-{prefix}", delete=False) as stream:
                        stage = Path(stream.name)
                        json.dump(record, stream, ensure_ascii=False)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if stage.stat().st_size <= self.max_bytes:
                        if source_id:
                            from symbiknow.library import storage

                            # Conversion and serialization happen above, outside
                            # original locks. This brief guard orders rename vs.
                            # purge+discard, preventing late plaintext publication.
                            with storage.read_snapshot(self.library):
                                if storage.current_version(self.library, source_id) == str(metadata["version"]):
                                    stage.replace(target)
                        else:
                            stage.replace(target)
                    self._prune()
                finally:
                    if stage:
                        stage.unlink(missing_ok=True)
            return doc, warnings

    def _prune(self):
        retained = total = 0
        paths = []
        for path in self.root.glob("*.json"):
            try:
                record = path.stat()
            except FileNotFoundError:
                continue  # A deletion discards published files without waiting for OCR.
            paths.append((record.st_mtime_ns, record.st_size, path))
        for _, size, path in sorted(paths, reverse=True):
            retained += 1
            total += size
            if retained > self.max_entries or total > self.max_bytes:
                path.unlink(missing_ok=True)


def _document_prefix(document_id):
    return hashlib.sha256(document_id.encode("utf-8")).hexdigest()


def discard_document(data_dir, document_id):
    """Remove one source's plaintext without blocking deletion behind active OCR.

    Storage calls this after its purge. Artifact publication takes an original
    read snapshot, so it either precedes this cleanup or observes the missing head.
    No unrelated library, source, durable ledger or leased original is removed.
    """
    root = Path(data_dir).resolve() / "temp" / "extraction-artifacts"
    for path in root.glob(f"{_document_prefix(document_id)}-*.json"):
        path.unlink(missing_ok=True)
