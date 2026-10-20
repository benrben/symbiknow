"""Local composition root and protected read snapshots.

Adapters configure this owner; domain operations consume a library-scoped context
instead of importing HTTP/MCP modules. No state or current-head cache is shared
between library roots.
"""

from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Callable
import uuid
import queue
import threading
from collections import OrderedDict

from symbiknow.library import storage
from symbiknow.core.contracts import RevisionToken, freeze_json


class Originals:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()

    def heads_many(self, document_ids):
        return storage.heads_many(self.data_dir, document_ids)

    def metadata_many(self, document_ids):
        return storage.metadata_many(self.data_dir, document_ids)

    def metadata(self, document_id, version=None):
        return storage.read_metadata(self.data_dir, document_id, version)

    def verified_file(self, document_id, version=None):
        return storage.verified_file(self.data_dir, document_id, version)

    def commit(self, content, filename, **metadata):
        return storage.save_file(self.data_dir, content, filename, **metadata)

    def history_page(self, document_id, **page):
        return storage.version_page(self.data_dir, document_id, **page)

    def delete(self, document_id, expected_version):
        return storage.delete_document(self.data_dir, document_id, expected_version)


class Evidence:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()

    def document_statuses(self, document_ids):
        from symbiknow.search.index import document_statuses

        return document_statuses(self.data_dir, document_ids)

    def resolve_evidence_many(self, references):
        from symbiknow.search.index import resolve_evidence_many

        return resolve_evidence_many(self.data_dir, references)

    def find_documents(self, query, mode, limit, folder, group, **options):
        from symbiknow.search.index import find_documents

        return find_documents(self.data_dir, query, mode, limit, folder, group, **options)

    def batches(self, document_id, version, batch_size=32):
        from symbiknow.search.index import evidence_batches
        return evidence_batches(self.data_dir, document_id, version, batch_size)


@dataclass
class ProtectedSnapshot:
    originals: Originals
    revision: RevisionToken
    _metadata: dict = field(default_factory=dict)
    _active: bool = True

    def metadata_many(self, document_ids):
        if not self._active:
            raise RuntimeError("Protected snapshot has ended; acquire a fresh snapshot")
        identities = list(dict.fromkeys(document_ids))
        missing = [identity for identity in identities if identity not in self._metadata]
        for offset in range(0, len(missing), 800):
            self._metadata.update(self.originals.metadata_many(missing[offset : offset + 800]))
        return MappingProxyType(
            {
                identity: freeze_json(self._metadata[identity])
                if self._metadata[identity]
                else None
                for identity in identities
            }
        )

    def heads_many(self, document_ids):
        return MappingProxyType(
            {
                identity: value["version"] if value else None
                for identity, value in self.metadata_many(document_ids).items()
            }
        )


class SnapshotCoordinator:
    def __init__(self, context):
        self.context = context

    @contextmanager
    def read(self):
        from symbiknow.search.index import INDEX_LOCK, revisions
        from symbiknow.search.metrics import add, timed_lock

        context = self.context
        with (
            timed_lock(context.write_lock, "final_write_lock"),
            timed_lock(context.index_lock, "final_server_index_lock"),
            timed_lock(INDEX_LOCK, "final_index_lock"),
            storage.read_snapshot(context.DATA_DIR),
        ):
            current = revisions(context.DATA_DIR)
            add("snapshot_acquisitions", 1)
            snapshot = ProtectedSnapshot(
                context.originals,
                RevisionToken(
                    str(context.DATA_DIR),
                    current["index"],
                    current["organization"],
                    uuid.uuid4().hex,
                ),
            )
            try:
                yield snapshot
            finally:
                snapshot._active = False
                snapshot._metadata.clear()


@dataclass(frozen=True)
class ApplicationSettings:
    storage_only: bool = False
    max_chunk_bytes: int = 256 * 1024
    max_file_bytes: int = 256 * 1024 * 1024
    status_entries: int = 4096

    def __post_init__(self):
        if not isinstance(self.storage_only, bool):
            raise ValueError("storage_only must be boolean")
        if not 1 <= self.max_chunk_bytes <= self.max_file_bytes:
            raise ValueError("Require 0 < max_chunk_bytes <= max_file_bytes")
        if self.status_entries < 1:
            raise ValueError("status_entries must be positive")


class ApplicationContext:
    def __init__(self, data_dir, *, settings=None, **dependencies):
        self.settings = settings or ApplicationSettings()
        self.DATA_DIR = Path(data_dir).resolve()
        self.write_lock = threading.RLock()
        self.index_lock = threading.RLock()
        for name in ("wake", "stop", "processing", "rescan"):
            setattr(self, name, threading.Event())
        self.pending = queue.Queue(maxsize=128)
        self.retry_ids = set()
        self.status_cache = OrderedDict()
        self.organization_attempts = set()
        self.__dict__.update(dependencies)
        self.originals = Originals(self.DATA_DIR)
        self.evidence = Evidence(self.DATA_DIR)
        self.snapshots = SnapshotCoordinator(self)
        from symbiknow.search.service import SearchService

        self.search = SearchService(self)
        from symbiknow.library.service import LibraryService

        self.library = LibraryService(self)
        from symbiknow.transfers.service import TransferService

        self.transfers = TransferService(self)
        from symbiknow.freshness.service import FreshnessService

        self.freshness = FreshnessService(self)
        from symbiknow.organization.decisions import DecisionService

        self.decisions = DecisionService(self)

    @property
    def STORAGE_ONLY(self):
        return self.settings.storage_only

    @property
    def MAX_CHUNK(self):
        return self.settings.max_chunk_bytes

    @property
    def MAX_FILE(self):
        return self.settings.max_file_bytes

    @property
    def STATUS_CACHE_LIMIT(self):
        return self.settings.status_entries

    def _cache_status(self, metadata, indexed):
        identity = metadata["document_id"]
        self.status_cache[identity] = {key: indexed.get(key) for key in (
            "version", "status", "indexed_version", "searchable_text", "searchable_visual", "index_error")}
        while len(self.status_cache) > self.STATUS_CACHE_LIMIT:
            self.status_cache.pop(next(iter(self.status_cache)))
        self.organization_attempts.difference_update(
            entry for entry in list(self.organization_attempts)
            if entry[0] == identity and entry[1] != metadata["version"])
        while len(self.organization_attempts) > self.STATUS_CACHE_LIMIT:
            self.organization_attempts.pop()
        if indexed.get("status") in ("pending", "failed", "superseded"):
            self.retry_ids.add(identity)
        else:
            self.retry_ids.discard(identity)

    def schedule(self, document_id):
        try:
            self.pending.put_nowait(document_id)
        except queue.Full:
            self.rescan.set()
        self.wake.set()


_factory: Callable[[], ApplicationContext] | None = None


def configure_application_factory(factory):
    global _factory
    _factory = factory


def current_application():
    if _factory is None:
        raise RuntimeError("Application owner has not been configured")
    return _factory()
