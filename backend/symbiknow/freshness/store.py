"""One durable, paginated owner of manual freshness jobs and review records."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

# SQLite transactions commit a comparison result, its finding and progress
# together. Originals and embeddings remain in their existing repositories.
SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, request_key TEXT UNIQUE, active INTEGER NOT NULL,
 payload TEXT NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active ON jobs(active) WHERE active=1;
CREATE TABLE IF NOT EXISTS documents (
 scan TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
 filename TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(scan,id));
CREATE TABLE IF NOT EXISTS passages (
 scan TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
 position INTEGER NOT NULL, payload TEXT NOT NULL, kind TEXT, matched INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scan,id));
CREATE INDEX IF NOT EXISTS passage_work ON passages(scan,kind,matched);
CREATE INDEX IF NOT EXISTS passage_document ON passages(scan,document);
CREATE TABLE IF NOT EXISTS pairs (
 scan TEXT NOT NULL, id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(scan,id));
CREATE INDEX IF NOT EXISTS pair_work ON pairs(scan,status,id);
CREATE TABLE IF NOT EXISTS findings (
 scan TEXT NOT NULL, id TEXT NOT NULL, document_a TEXT NOT NULL,
 document_b TEXT NOT NULL, category TEXT NOT NULL, review TEXT NOT NULL,
 revision INTEGER NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(scan,id));
CREATE INDEX IF NOT EXISTS finding_page ON findings(scan,id);
CREATE INDEX IF NOT EXISTS finding_a ON findings(document_a,scan);
CREATE INDEX IF NOT EXISTS finding_b ON findings(document_b,scan);
CREATE TABLE IF NOT EXISTS reviews (
 scan TEXT NOT NULL, finding TEXT NOT NULL, revision INTEGER NOT NULL,
 payload TEXT NOT NULL, PRIMARY KEY(scan,finding,revision));
CREATE TABLE IF NOT EXISTS cache (
 id TEXT PRIMARY KEY, payload TEXT NOT NULL, touched INTEGER NOT NULL);
"""


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class FreshnessStore:
    def __init__(self, root):
        self.path = Path(root) / "freshness" / "reviews.sqlite3"

    @contextmanager
    def connection(self, *, create=False):
        if not create and not self.path.exists():
            yield None
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            if create:
                db.execute("PRAGMA journal_mode=WAL")
                db.executescript(SCHEMA)
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, 3):
                raise ValueError("Unsupported freshness store version")
            with db:
                if version < 2:
                    # Retire the former generic label, including saved results
                    # and their counts, so old scans match the current UI/MCP.
                    db.execute(
                        "DELETE FROM reviews WHERE EXISTS (SELECT 1 FROM findings f "
                        "WHERE f.scan=reviews.scan AND f.id=reviews.finding AND f.category='needs_review')")
                    db.execute("DELETE FROM findings WHERE category='needs_review'")
                    for row in db.execute("SELECT id,payload FROM jobs").fetchall():
                        job = json.loads(row["payload"])
                        job["findings_total"] = db.execute(
                            "SELECT COUNT(*) FROM findings WHERE scan=?", (row["id"],)).fetchone()[0]
                        self.save_job(db, job)
                if version < 3:
                    if "context_key" not in {r[1] for r in db.execute("PRAGMA table_info(pairs)")}:
                        db.execute("ALTER TABLE pairs ADD COLUMN context_key TEXT")
                    db.execute(
                        "UPDATE pairs SET context_key=(SELECT CASE WHEN a.document<=b.document "
                        "THEN a.document || char(10) || b.document ELSE b.document || char(10) || a.document END "
                        "FROM passages a JOIN passages b ON a.scan=b.scan "
                        "WHERE a.scan=pairs.scan AND a.id=pairs.a AND b.id=pairs.b) WHERE context_key IS NULL")
                    db.execute("CREATE INDEX IF NOT EXISTS pair_context ON pairs(scan,context_key,status,id)")
                    db.execute("CREATE INDEX IF NOT EXISTS cache_age ON cache(touched)")
                    db.execute("PRAGMA user_version=3")
                yield db
        finally:
            db.close()

    @staticmethod
    def job(db, scan=None):
        if db is None:
            return None
        row = db.execute(
            "SELECT payload FROM jobs WHERE id=?" if scan else
            "SELECT payload FROM jobs ORDER BY created DESC, id DESC LIMIT 1",
            (scan,) if scan else (),
        ).fetchone()
        if scan and row is None:
            raise FileNotFoundError("Freshness scan not found")
        return json.loads(row[0]) if row else None

    @staticmethod
    def save_job(db, job):
        job["revision"] += 1
        db.execute("UPDATE jobs SET payload=?, active=? WHERE id=?",
                   (encode(job), int(job["status"] in {"queued", "reading", "matching", "comparing"}), job["scan_id"]))

    def remove_document(self, identity):
        """Remove copied text; retain a redacted audit record for prior reviews.

        Called under the index/deletion lock before removing the index row, so
        interrupted deletion recovery repeats this operation.
        """
        with self.connection() as db:
            if db is None:
                return
            db.execute("DELETE FROM passages WHERE document=?", (identity,))
            for row in db.execute("SELECT scan,payload FROM documents WHERE id=?", (identity,)).fetchall():
                doc = json.loads(row["payload"])
                redacted = {k: doc[k] for k in ("document_id", "version", "evidence_revision")}
                redacted["filename"] = "(removed file)"
                db.execute("UPDATE documents SET payload=?,filename=?,status='removed' WHERE scan=? AND id=?",
                           (encode(redacted), "(removed file)", row["scan"], identity))
            for row in db.execute("SELECT scan,id,payload FROM findings WHERE document_a=? OR document_b=?", (identity, identity)).fetchall():
                finding = json.loads(row["payload"])
                for evidence in finding["evidence"]:
                    if evidence["document_id"] == identity:
                        evidence.update(text="", filename="(removed file)", provenance={})
                finding.pop("review_note", None)
                db.execute("UPDATE findings SET payload=?,revision=revision+1 WHERE scan=? AND id=?",
                           (encode(finding), row["scan"], row["id"]))
                db.execute("DELETE FROM reviews WHERE scan=? AND finding=?", (row["scan"], row["id"]))
            # Successful decisions contain no original text. Drop them anyway
            # so removed sources cannot leave reusable derived judgments.
            db.execute("DELETE FROM cache")
