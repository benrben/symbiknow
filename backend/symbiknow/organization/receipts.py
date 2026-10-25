"""Durable indexed decision receipts; independent of rebuildable projections."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3


@contextmanager
def connection(root):
    path = Path(root) / "temp" / "jev-decisions.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS receipt_scope ON receipts(scope)")
        db.execute("CREATE INDEX IF NOT EXISTS receipt_document ON receipts(substr(id,1,instr(id,':')-1))")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS receipt_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
            INSERT OR IGNORE INTO receipt_revision VALUES(1,0);
            CREATE TRIGGER IF NOT EXISTS receipt_insert_revision AFTER INSERT ON receipts
            BEGIN UPDATE receipt_revision SET revision=revision+1 WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS receipt_update_revision AFTER UPDATE ON receipts
            BEGIN UPDATE receipt_revision SET revision=revision+1 WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS receipt_delete_revision AFTER DELETE ON receipts
            BEGIN UPDATE receipt_revision SET revision=revision+1 WHERE id=1; END;
        """)
        db.execute("CREATE TABLE IF NOT EXISTS migration(id INTEGER PRIMARY KEY)")
        with db:
            if not db.execute("SELECT 1 FROM migration WHERE id=1").fetchone():
                legacy = path.with_name("jev-decisions.json")
                values = json.loads(legacy.read_text()) if legacy.exists() else {}
                db.executemany("INSERT OR IGNORE INTO receipts VALUES(?,?,?)",
                               [(k, v.get("scope", k), json.dumps(v)) for k, v in values.items()])
                db.execute("INSERT INTO migration VALUES(1)")
            yield db
    finally:
        db.close()


def get(root, identity):
    with connection(root) as db:
        row = db.execute("SELECT payload FROM receipts WHERE id=?", (identity,)).fetchone()
        return json.loads(row[0]) if row else None


def handled(root, identity, scope):
    with connection(root) as db:
        return bool(db.execute("SELECT 1 FROM receipts WHERE id=? OR scope=? LIMIT 1", (identity, scope)).fetchone())


def save(root, receipt):
    with connection(root) as db:
        db.execute("INSERT INTO receipts VALUES(?,?,?)", (receipt["id"], receipt["scope"], json.dumps(receipt)))


def revision(root):
    path = Path(root) / "temp" / "jev-decisions.sqlite3"
    if not path.exists():
        return "0"
    with connection(root) as db:
        return str(db.execute("SELECT revision FROM receipt_revision WHERE id=1").fetchone()[0])


def purge_document(root, identity):
    """Privacy cleanup includes legacy receipts without explicit document fields."""
    path = Path(root) / "temp" / "jev-decisions.sqlite3"
    if path.exists():
        with connection(root) as db:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("DELETE FROM receipts WHERE (id>=? AND id<?) OR json_extract(payload,'$.target_document_id')=?",
                       (identity + ":", identity + ";", identity))
            db.commit()
            db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    legacy = path.with_name("jev-decisions.json")
    if legacy.exists():
        from symbiknow.organization.edits import atomic
        values = json.loads(legacy.read_text())
        kept = {key: value for key, value in values.items() if not key.startswith(identity + ":")
                and value.get("target_document_id") != identity}
        atomic(legacy, kept)
