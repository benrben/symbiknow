"""Read-only original inventory, independent of searchable evidence.

The disk catalogue is a rebuildable enumeration aid. OCFL metadata/heads remain
authoritative. Bootstrap streams in a worker; requests read bounded keyset pages
and bind continuations to source, evidence and organization revisions.
"""
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import base64
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import threading
import uuid

from symbiknow.library import storage

_LOCK = threading.RLock()
SCHEMA = """
CREATE TABLE originals(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
"""


def _path(root):
    return Path(root) / "temp" / "library-catalog.sqlite3"


@contextmanager
def _db(root):
    with _LOCK:
        file = _path(root)
        db = sqlite3.connect(file, timeout=15) if file.exists() else None
        try:
            if db is not None:
                db.execute("PRAGMA secure_delete=ON")
                with db:
                    yield db
            else:
                yield None
        finally:
            if db is not None:
                db.close()


def source_committed(root, metadata, previous_revision):
    """Publication cache failures must never turn a committed original into a failed upload."""
    try:
        with _db(root) as db:
            if db is None:
                return
            saved = db.execute("SELECT value FROM metadata WHERE key='source_revision'").fetchone()
            db.execute("INSERT OR REPLACE INTO originals VALUES(?,?)", (metadata["document_id"], json.dumps(metadata)))
            # A failed older publication must stay stale until full reconciliation.
            if saved and saved[0] == previous_revision:
                db.execute("UPDATE metadata SET value=? WHERE key='source_revision'", (storage.source_revision(root),))
    except (sqlite3.Error, OSError):
        # The source token was already advanced, so the old catalogue stays
        # invalid and a worker reconciles it before the next inventory read.
        logging.getLogger(__name__).exception("Original catalogue publication deferred")
        try:
            with _LOCK:
                _path(root).unlink(missing_ok=True)
        except OSError:
            logging.getLogger(__name__).exception("Original catalogue invalidation deferred")


def source_deleted(root, identity, previous_revision=None):
    with _db(root) as db:
        if db is not None:
            saved = db.execute("SELECT value FROM metadata WHERE key='source_revision'").fetchone()
            db.execute("DELETE FROM originals WHERE id=?", (identity,))
            if saved and saved[0] == previous_revision:
                db.execute("UPDATE metadata SET value=? WHERE key='source_revision'", (storage.source_revision(root),))

    # Taxonomy includes private folder/project/topic names. An obsolete snapshot
    # must not survive a source deletion, even though it cannot be served.
    with _LOCK:
        taxonomy = Path(root) / "temp" / "library-taxonomy.sqlite3"
        if taxonomy.exists():
            with closing(sqlite3.connect(taxonomy)) as db, db:
                db.execute("PRAGMA secure_delete=ON")
                db.execute("DELETE FROM facets")
            taxonomy.unlink(missing_ok=True)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def page_cursor(binding, position):
    return base64.urlsafe_b64encode(json.dumps([binding, position], separators=(",", ":")).encode()).decode()


def read_cursor(cursor, binding):
    if not cursor:
        return ""
    try:
        if not isinstance(cursor, str) or len(cursor) > 8192:
            raise ValueError()
        value = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if not isinstance(value, list) or len(value) != 2 or value[0] != binding or not isinstance(value[1], str):
            raise ValueError()
        return value[1]
    except (ValueError, TypeError, UnicodeDecodeError):
        raise ValueError("The library or filters changed; restart pagination without a cursor") from None


def _limit(limit):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")


def _revision(root):
    from symbiknow.search.index import revisions
    return _digest([storage.source_revision(root), revisions(root)])


def _error(status, error):
    if not error:
        return ""
    return ("This format has no supported extraction; the original remains available."
            if status == "unsupported" else "Indexing could not complete; the original remains available.")


def inventory_document(metadata, row):
    """Public metadata never exposes a local provenance path or provider error."""
    from symbiknow.organization.policy import project_identity
    current = row if row and row.get("version") == metadata["version"] else {}
    organization = json.loads(current.get("organization_json") or "{}")
    project = organization.get("effective_owner", organization.get("canonical_project"))
    project = project_identity(project["name"], [project]) if project else None
    project = {key: project[key] for key in ("id", "name")} if project else None
    status = current.get("status", "unregistered")
    searchable = status == "indexed" and current.get("indexed_version") == metadata["version"]
    if status == "indexed" and not searchable:
        status = "pending"
    return {**{k: metadata[k] for k in ("document_id", "version", "filename", "mime_type", "size", "sha256", "created_at") if k in metadata},
            "source_filename": metadata["filename"],
            "stored": True, "storage_status": "stored", "indexing_status": status,
            "searchable": searchable, "searchable_text": searchable and bool(current.get("searchable_text")),
            "searchable_visual": searchable and bool(current.get("searchable_visual")),
            "indexing_error": _error(status, current.get("index_error")),
            "project": project, "folder": current.get("folder", ""),
            "topics": list(current.get("groups", [])), "groups": list(current.get("groups", [])),
            "organization_status": current.get("organization_status", "pending"),
            "evidence_revision": current.get("evidence_revision", ""),
            "folder_origin": "manual" if organization.get("manual_folder_override") else organization.get("origin", "unknown")}


class CatalogService:
    def __init__(self, context):
        self.context = context
        self.root = context.DATA_DIR

    def ready(self):
        try:
            with _db(self.root) as db:
                row = db.execute("SELECT value FROM metadata WHERE key='source_revision'").fetchone() if db else None
            return bool(row and row[0] == storage.source_revision(self.root))
        except (sqlite3.Error, OSError):
            return False  # Rebuildable caches never block reading authoritative originals.

    def prepare(self):
        """Worker/startup-only streaming reconciliation; no request-side scan."""
        if self.ready():
            return
        self.root.joinpath("temp").mkdir(parents=True, exist_ok=True)
        candidate = self.root / "temp" / ("catalog-build-" + uuid.uuid4().hex + ".sqlite3")
        initial = storage.source_revision(self.root)
        db = sqlite3.connect(candidate)
        try:
            db.executescript(SCHEMA)
            with db:
                for metadata in storage.iter_documents(self.root, batch_size=128):
                    db.execute("INSERT INTO originals VALUES(?,?)", (metadata["document_id"], json.dumps(metadata)))
                db.execute("INSERT INTO metadata VALUES('source_revision',?)", (initial,))
            db.close()
            with storage.read_snapshot(self.root), _LOCK:
                if storage.source_revision(self.root) != initial:
                    raise ValueError("The original inventory changed during preparation; retry")
                candidate.replace(_path(self.root))
        finally:
            db.close()
            candidate.unlink(missing_ok=True)

    def _read(self, kind, args):
        request = str(uuid.uuid5(uuid.NAMESPACE_URL, "symbiknow:catalog:" + _digest([_revision(self.root), kind, args])))
        return self.context.jobs.start("library-catalog", {"read": kind, "args": args}, request_id=request)

    def list_documents(self, *, limit=50, cursor=None, folder=None, topic=None, project=None, status=None):
        _limit(limit)
        for value in (folder, topic, project, status):
            if value is not None and (not isinstance(value, str) or len(value) > 500):
                raise ValueError("Inventory filters must be text of at most 500 characters")
        args = dict(limit=limit, cursor=cursor, folder=folder, topic=topic, project=project, status=status)
        if not self.ready():
            if cursor:
                raise ValueError("The original inventory changed; restart pagination")
            return self._read("list_documents", args)
        from symbiknow.search.index import document_statuses
        from symbiknow.organization import edits, projects
        with self.context.snapshots.read() as snapshot:
            revision = _revision(self.root)
            binding = _digest(["inventory-v1", revision, {k: v for k, v in args.items() if k != "cursor"}])
            position = read_cursor(cursor, binding)
            documents, scanned, more = [], 0, True
            with _db(self.root) as db:
                if not self.ready():
                    raise ValueError("The original inventory changed; restart pagination")
                total = db.execute("SELECT count(*) FROM originals").fetchone()[0]
                while scanned < 512 and len(documents) < limit:
                    batch = db.execute("SELECT id,payload FROM originals WHERE id>? ORDER BY id LIMIT ?",
                                       (position, min(128, 512 - scanned))).fetchall()
                    if not batch:
                        more = False
                        break
                    ids = [row[0] for row in batch]
                    metadata = snapshot.metadata_many(ids)
                    states = document_statuses(self.root, ids)
                    manual = edits.overrides(self.root, ids)
                    for identity, payload in batch:
                        position, scanned = identity, scanned + 1
                        original = metadata.get(identity)
                        if original is None or original["version"] != json.loads(payload)["version"]:
                            raise ValueError("The original inventory changed; restart pagination")
                        state = states.get(identity)
                        if state is None or state.get("version") != original["version"]:
                            state = {"document_id": identity, "version": original["version"], "status": "unregistered",
                                     "organization_json": "{}", "folder": "", "groups": []}
                            state = projects.overlay(self.root, [state])[0]
                            if identity in manual:
                                detail = json.loads(state["organization_json"])
                                detail["manual_folder_override"] = manual[identity]
                                state.update(folder=manual[identity]["folder"], organization_json=json.dumps(detail))
                        item = inventory_document(original, state)
                        if folder is not None and not (item["folder"] == folder or (folder and item["folder"].startswith(folder + " / "))):
                            continue
                        if topic is not None and topic not in item["topics"]:
                            continue
                        if project is not None and project not in {(item["project"] or {}).get("id", ""), (item["project"] or {}).get("name", "")}:
                            continue
                        if status is not None and item["indexing_status"] != status:
                            continue
                        documents.append(item)
                        if len(documents) == limit:
                            break
                    if len(documents) == limit:
                        break
                more = more and bool(db.execute("SELECT 1 FROM originals WHERE id>? LIMIT 1", (position,)).fetchone())
            return {"documents": documents, "count": len(documents), "total_originals": total,
                    **({"total": total} if all(v is None for v in (folder, topic, project, status)) else {}),
                    "revision": revision, "has_more": more, "next_cursor": page_cursor(binding, position) if more else None,
                    "filters": {k: v for k, v in args.items() if k not in {"limit", "cursor"}},
                    "scope": "All current stored originals, including files without searchable evidence"}

    def _taxonomy_path(self):
        return self.root / "temp" / "library-taxonomy.sqlite3"

    def taxonomy_ready(self):
        file = self._taxonomy_path()
        if not file.exists() or not self.ready():
            return False
        try:
            with closing(sqlite3.connect(file)) as db:
                saved = db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
            return bool(saved and saved[0] == _revision(self.root))
        except (sqlite3.Error, OSError):
            return False

    def prepare_taxonomy(self):
        """Worker-only aggregation; changing organization never rebuilds originals."""
        self.prepare()
        revision = _revision(self.root)
        candidate = self.root / "temp" / ("taxonomy-build-" + uuid.uuid4().hex + ".sqlite3")
        db = sqlite3.connect(candidate)
        try:
            db.executescript("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);"
                             "CREATE TABLE facets(kind TEXT,name TEXT,id TEXT,count INTEGER,PRIMARY KEY(kind,id));")
            cursor = None
            with db:
                while True:
                    page = self.list_documents(limit=100, cursor=cursor)
                    if "job_id" in page:
                        raise ValueError("The inventory changed during taxonomy preparation; retry")
                    for item in page["documents"]:
                        facets = [("folders", item["folder"], item["folder"]),
                                  ("statuses", item["indexing_status"], item["indexing_status"])]
                        facets.extend(("topics", topic, topic) for topic in set(item["topics"]))
                        project = item["project"]
                        facets.append(("projects", project["name"] if project else "No project", project["id"] if project else ""))
                        for kind, name, identity in facets:
                            db.execute("INSERT INTO facets VALUES(?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET count=count+1",
                                       (kind, name, identity))
                    if not page["has_more"]:
                        break
                    cursor = page["next_cursor"]
                db.execute("INSERT INTO metadata VALUES('revision',?)", (revision,))
            db.close()
            with self.context.snapshots.read(), _LOCK:
                if _revision(self.root) != revision:
                    raise ValueError("The library changed during taxonomy preparation; retry")
                candidate.replace(self._taxonomy_path())
        finally:
            db.close()
            candidate.unlink(missing_ok=True)

    def taxonomy(self, *, dimension="all", limit=50, cursor=None):
        _limit(limit)
        if dimension not in {"all", "projects", "folders", "topics", "statuses"}:
            raise ValueError("Use all, projects, folders, topics or statuses")
        args = dict(dimension=dimension, limit=limit, cursor=cursor)
        if not self.taxonomy_ready():
            if cursor:
                raise ValueError("The taxonomy changed; restart pagination")
            return self._read("taxonomy", args)
        from symbiknow.ai.topics import DEFINITIONS
        with self.context.snapshots.read():
            revision = _revision(self.root)
            binding = _digest(["taxonomy-v1", revision, dimension, limit])
            after = read_cursor(cursor, binding)
            with closing(sqlite3.connect(self._taxonomy_path())) as db:
                if db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0] != revision:
                    raise ValueError("The taxonomy changed; restart pagination")
                rows = db.execute("SELECT kind,name,id,count FROM facets WHERE (kind=? OR ?='all') "
                                  "AND (kind||char(31)||id)>? ORDER BY kind,id LIMIT ?",
                                  (dimension, dimension, after, limit + 1)).fetchall()
            items = [{"dimension": kind, "name": name, "id": identity, "count": count,
                      "definition": DEFINITIONS.get(name) if kind == "topics" else None}
                     for kind, name, identity, count in rows[:limit]]
            more = len(rows) > limit
            position = rows[limit - 1][0] + chr(31) + rows[limit - 1][2] if more else ""
            return {"items": items, "revision": revision, "has_more": more,
                    "next_cursor": page_cursor(binding, position) if more else None,
                    "semantics": {"projects": "Effective ownership; independent of placement",
                                  "folders": "Exact effective folder paths; manual placement wins",
                                  "topics": "Many-to-many subject labels; independent of folders",
                                  "statuses": "Current original readiness; stored does not mean searchable"}}

    def jobs(self, *, limit=50, cursor=None, status=None):
        _limit(limit)
        if status is not None and status not in {"queued", "running", "completed", "failed"}:
            raise ValueError("Use queued, running, completed or failed")
        # Never expose job arguments/results here: they can contain queries,
        # staged paths, bytes or provider errors. get_job reads a known result.
        with self.context.work.connection() as db:
            revision = str(db.execute("SELECT revision FROM job_revision WHERE id=1").fetchone()[0])
            binding = _digest(["jobs-v1", revision, limit, status])
            position = read_cursor(cursor, binding)
            rows = db.execute("SELECT id,state,created,json_extract(payload,'$.kind') FROM work "
                              "WHERE lane='jobs' AND id>? AND (state=? OR ? IS NULL) ORDER BY id LIMIT ?",
                              (position, status, status, limit + 1)).fetchall()
            jobs = [{"job_id": row[0], "status": row[1], "created_at": datetime.fromtimestamp(row[2], timezone.utc).isoformat(),
                     "kind": row[3], "error": "Job failed; inspect its result with get_job." if row[1] == "failed" else None}
                    for row in rows[:limit]]
            more = len(rows) > limit
            return {"jobs": jobs, "revision": revision, "has_more": more,
                    "next_cursor": page_cursor(binding, jobs[-1]["job_id"]) if more else None,
                    "scope": "Retained durable jobs; completed records may expire. No cancellation is implied."}


    def history(self, document_id, *, limit=50, cursor=None):
        from symbiknow.organization.history import history
        return history(self.context, document_id, limit=limit, cursor=cursor)
