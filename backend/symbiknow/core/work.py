"""Durable bounded work queues. Acknowledge by generation so retries cannot lose updates."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
import threading
import uuid

_SCHEMA_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS work(
 lane TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'queued',available REAL NOT NULL DEFAULT 0,
 payload TEXT NOT NULL,result TEXT,error TEXT,created REAL NOT NULL,
 PRIMARY KEY(lane,id));
CREATE INDEX IF NOT EXISTS work_due ON work(lane,state,available,id);
CREATE INDEX IF NOT EXISTS work_retention ON work(lane,state,created,id);
CREATE TABLE IF NOT EXISTS job_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
INSERT OR IGNORE INTO job_revision VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS jobs_insert_revision AFTER INSERT ON work WHEN NEW.lane='jobs'
BEGIN UPDATE job_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS jobs_update_revision AFTER UPDATE ON work WHEN NEW.lane='jobs'
BEGIN UPDATE job_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS jobs_delete_revision AFTER DELETE ON work WHEN OLD.lane='jobs'
BEGIN UPDATE job_revision SET revision=revision+1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS deleted_sources(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS work_sources(lane TEXT,id TEXT,source TEXT,
 PRIMARY KEY(lane,id,source));
CREATE INDEX IF NOT EXISTS work_source ON work_sources(source,lane,id);
"""

# Match the independently serviced job pools. A bulk backlog must not consume
# admission slots needed to search or open a document. Total pending work is
# still bounded (four pools of 256), including running jobs and retry requests.
JOB_POOL_LIMIT = 256


def job_pool(payload):
    kind = payload.get("kind")
    if kind in {"search", "ask"}:
        return kind
    if kind in {"preview", "original-prepare", "original-range"}:
        return "artifacts"
    return "bulk"


class WorkStore:
    def __init__(self, root):
        self.path = Path(root) / "temp" / "work.sqlite3"

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with _SCHEMA_LOCK:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA secure_delete=ON")
                db.executescript(SCHEMA)
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, lane, identity, payload, *, replace=False, delay=0):
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        if len(encoded.encode()) > 128 * 1024:
            raise ValueError("Work arguments exceed 128 KiB; use staged payloads")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT payload,state FROM work WHERE lane=? AND id=?", (lane, identity)).fetchone()
            sources = self._sources(payload, None)
            deleted = any(db.execute("SELECT 1 FROM deleted_sources WHERE id=?", (source,)).fetchone() for source in sources)
            deleted = deleted or db.execute("SELECT 1 FROM work_sources JOIN deleted_sources ON deleted_sources.id=work_sources.source WHERE lane=? AND work_sources.id=? LIMIT 1", (lane, identity)).fetchone()
            if deleted:
                self._discard_input(payload)
                raise ValueError("A source document was deleted; use a new upload request for a new file")
            if existing and not replace:
                if existing[0] != encoded:
                    raise ValueError("Work request ID was already used with different arguments")
                return identity
            if lane == "jobs":
                pool = job_pool(payload)
                occupied = db.execute(
                    "SELECT count(*) FROM work WHERE lane='jobs' AND state IN ('queued','running') AND id<>? AND "
                    "CASE json_extract(payload,'$.kind') WHEN 'search' THEN 'search' WHEN 'ask' THEN 'ask' "
                    "WHEN 'preview' THEN 'artifacts' WHEN 'original-prepare' THEN 'artifacts' "
                    "WHEN 'original-range' THEN 'artifacts' ELSE 'bulk' END=?", (identity, pool)
                ).fetchone()[0]
                if occupied >= JOB_POOL_LIMIT:
                    raise ValueError(f"{pool.capitalize()} job queue is full; wait for existing jobs before retrying")
            db.execute("INSERT INTO work(lane,id,payload,available,created) VALUES(?,?,?,?,?) "
                       "ON CONFLICT(lane,id) DO UPDATE SET generation=generation+1,state='queued',"
                       "payload=excluded.payload,available=excluded.available,result=NULL,error=NULL",
                       (lane, identity, encoded, time.time() + delay, time.time()))
            db.execute("DELETE FROM work_sources WHERE lane=? AND id=?", (lane, identity))
            db.executemany("INSERT INTO work_sources VALUES(?,?,?)", [(lane, identity, source) for source in sources])
        return identity

    def active_inputs(self, kind):
        """Staged payload identities held by queued or running jobs."""
        with self.connection() as db:
            return {row[0] for row in db.execute(
                "SELECT json_extract(payload,'$.args.input') FROM work "
                "WHERE lane='jobs' AND state IN ('queued','running') AND json_extract(payload,'$.kind')=?", (kind,))
                if row[0] is not None}

    def claim(self, lane, limit=1, *, kinds=None, exclude=False):
        if not 1 <= limit <= 128:
            raise ValueError("Work batch limit must be 1–128")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            condition, parameters = "", [lane, time.time()]
            if kinds:
                condition = " AND json_extract(payload,'$.kind') " + ("NOT IN" if exclude else "IN")
                condition += " (" + ",".join("?" for _ in kinds) + ")"
                parameters.extend(kinds)
            rows = db.execute("SELECT * FROM work WHERE lane=? AND state='queued' AND available<=? "
                              + condition + " ORDER BY available,id LIMIT ?", (*parameters, limit)).fetchall()
            db.executemany("UPDATE work SET state='running' WHERE lane=? AND id=? AND generation=?",
                           [(lane, r["id"], r["generation"]) for r in rows])
            return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    def _sources(self, payload, result):
        sources = set()

        def visit(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"document_id", "source_document_id", "target_document_id"} and isinstance(child, str):
                        sources.add(child)
                    else:
                        visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(payload)
        visit(result)
        # Upgrade pre-dependency folder jobs while the manifest still exists.
        if payload.get("kind") == "folder-export" and isinstance(result, dict):
            try:
                token = str(uuid.UUID(result.get("transfer_id", "")))
                manifest = self.path.parent / "folder-exports" / (token + ".json")
                visit(json.loads(manifest.read_text()))
            except (ValueError, OSError, TypeError):
                pass
        if payload.get("kind") == "folder-upload":
            from symbiknow.transfers.folders import staged_input, upload_sources
            try:
                file = staged_input(self.path.parent.parent, payload["args"]["input"])
                sources.update(upload_sources(json.loads(file.read_text())))
            except (ValueError, KeyError, OSError, TypeError):
                pass
        return sources

    def _discard_input(self, payload):
        if payload.get("kind") == "folder-upload":
            from symbiknow.transfers.folders import staged_input
            staged_input(self.path.parent.parent, payload["args"]["input"]).unlink(missing_ok=True)

    @staticmethod
    def _record_sources(db, item, sources):
        current = db.execute("SELECT generation FROM work WHERE lane=? AND id=?", (item["lane"], item["id"])).fetchone()
        if not current or current[0] != item["generation"]:
            return False
        db.executemany("INSERT OR IGNORE INTO work_sources VALUES(?,?,?)",
                       [(item["lane"], item["id"], source) for source in sources])
        return db.execute("SELECT 1 FROM work_sources JOIN deleted_sources ON deleted_sources.id=work_sources.source WHERE lane=? AND work_sources.id=? LIMIT 1",
                          (item["lane"], item["id"])).fetchone() is not None

    def track_sources(self, item, sources):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._record_sources(db, item, sources):
                raise FileNotFoundError("A source document was deleted")

    def purge_document(self, identity):
        """Invalidate in-flight generations and erase completed source copies.

        A tombstone guards late results from workers that opened bytes before
        deletion. Durable dependencies also cover ZIP first ranges and answers.
        """
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR IGNORE INTO deleted_sources VALUES(?)", (identity,))
            for row in db.execute("SELECT * FROM work").fetchall():
                payload = json.loads(row["payload"])
                result = json.loads(row["result"]) if row["result"] else None
                sources = self._sources(payload, result)
                self._record_sources(db, row, sources)
                # Taxonomy results contain source-derived names/counts without
                # per-document references; invalidate every catalogue snapshot.
                affected = payload.get("kind") == "library-catalog" or identity in sources or (row["lane"] != "jobs" and row["id"] == identity)
                affected = affected or db.execute("SELECT 1 FROM work_sources WHERE lane=? AND id=? AND source=?",
                                                 (row["lane"], row["id"], identity)).fetchone()
                if affected:
                    self._discard_input(payload)
                    db.execute("UPDATE work SET generation=generation+1,state='failed',result=NULL,error=? WHERE lane=? AND id=?",
                               ("A source document was deleted", row["lane"], row["id"]))
        from symbiknow.transfers.folders import purge_staged_document
        purge_staged_document(self.path.parent.parent, identity)
        # Secure-delete removes content from live pages; truncate the superseded
        # WAL after committing rather than retaining old result bodies until prune.
        with self.connection() as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def finish(self, item, result=None, *, error=None, retry_after=None, remove=False, dependencies=()):
        encoded = json.dumps(result) if result is not None else None
        if encoded and len(encoded.encode()) > 2 * 1024**2:
            raise ValueError("Job result exceeds 2 MiB; use paginated detail")
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            args = (item["lane"], item["id"], item["generation"])
            sources = self._sources(item["payload"], result) | set(dependencies)
            if self._record_sources(db, item, sources):
                encoded, error, retry_after = None, "A source document was deleted", None
            if remove:
                db.execute("DELETE FROM work WHERE lane=? AND id=? AND generation=?", args)
            else:
                db.execute("UPDATE work SET state=?,result=?,error=?,available=? WHERE lane=? AND id=? AND generation=?",
                           ("queued" if retry_after is not None else "failed" if error else "completed",
                            encoded, error,
                            time.time() + (retry_after or 0), *args))

    @staticmethod
    def _expire_exports(db):
        db.execute("UPDATE work SET generation=generation+1,state='failed',result=NULL,error='Folder export expired; prepare a new export' "
                   "WHERE lane='jobs' AND json_extract(payload,'$.kind')='folder-export' "
                   "AND json_extract(result,'$.expires_at')<=?", (time.time(),))

    def prune(self):
        with self.connection() as db:
            self._expire_exports(db)
            for state in ("completed", "failed"):
                db.execute("DELETE FROM work WHERE lane='jobs' AND id IN (SELECT id FROM work "
                           "WHERE lane='jobs' AND state=? AND created<? ORDER BY created LIMIT 64)",
                           (state, time.time() - 7 * 86400))
                db.execute("DELETE FROM work WHERE lane='jobs' AND id IN (SELECT id FROM work "
                           "WHERE lane='jobs' AND state=? ORDER BY created DESC,id LIMIT 64 OFFSET 1024)", (state,))

            db.execute("DELETE FROM work_sources WHERE NOT EXISTS (SELECT 1 FROM work WHERE work.lane=work_sources.lane AND work.id=work_sources.id)")

    def recover(self):
        # Only the server-lock owner calls this, before starting workers.
        with self.connection() as db:
            db.execute("UPDATE work SET state='queued' WHERE state='running'")
            # Old folder jobs embedded a ZIP range but did not name its sources.
            # Backfill from retained manifests; without one there is no way to
            # prove the copied bytes still belong to undeleted originals.
            for row in db.execute("SELECT * FROM work WHERE lane='jobs' AND json_extract(payload,'$.kind')='folder-export'").fetchall():
                payload = json.loads(row["payload"])
                result = json.loads(row["result"]) if row["result"] else None
                sources = self._sources(payload, result)
                deleted = self._record_sources(db, row, sources)
                known = db.execute("SELECT 1 FROM work_sources WHERE lane=? AND id=? LIMIT 1", (row["lane"], row["id"])).fetchone()
                if deleted or (result and not known):
                    db.execute("UPDATE work SET generation=generation+1,state='failed',result=NULL,error=? WHERE lane=? AND id=?",
                               ("Export source snapshot is unavailable; prepare a new export", row["lane"], row["id"]))
        with self.connection() as db:
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def get(self, lane, identity):
        with self.connection() as db:
            row = db.execute("SELECT id,state,result,error,payload FROM work WHERE lane=? AND id=?", (lane, identity)).fetchone()
            if not row:
                raise FileNotFoundError("Job not found")
            value = {**dict(row), "payload": json.loads(row["payload"]), "result": json.loads(row["result"]) if row["result"] else None}
            result = value["result"]
            if value["payload"].get("kind") == "folder-export" and result and result.get("expires_at", float("inf")) <= time.time():
                error = "Folder export expired; prepare a new export"
                db.execute("UPDATE work SET generation=generation+1,state='failed',result=NULL,error=? WHERE lane=? AND id=?", (error, lane, identity))
                value.update(state="failed", result=None, error=error)
            return value

    def progress(self, item, result):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._record_sources(db, item, self._sources(item["payload"], result)):
                return
            db.execute("UPDATE work SET result=? WHERE lane=? AND id=? AND generation=? AND state='running'",
                       (json.dumps(result), item["lane"], item["id"], item["generation"]))

    def start(self, kind, args, request_id=None):
        identity = request_id or str(uuid.uuid4())
        if not isinstance(identity, str) or not 1 <= len(identity) <= 128:
            raise ValueError("Use a request ID of 1–128 characters")
        self.enqueue("jobs", identity, {"kind": kind, "args": args})
        return {"job_id": identity, "status": self.get("jobs", identity)["state"]}
