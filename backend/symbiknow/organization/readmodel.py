"""Rebuildable, transactional read projections owned by organization.

Writers update only changed documents. Bootstrap is a worker/startup operation,
never a read-side cache fill. Original heads and evidence remain authoritative.
"""
from contextlib import contextmanager
import base64
import binascii
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import uuid
import zlib
from collections import Counter

_FILES_LOCK = threading.RLock()
_LEASES = Counter()
_PREPARED = set()

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(
 id TEXT PRIMARY KEY,filename TEXT NOT NULL,mime_type TEXT NOT NULL,created_at TEXT NOT NULL,
 folder TEXT NOT NULL,status TEXT NOT NULL,proposal INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS by_filename ON documents(filename,id);
CREATE INDEX IF NOT EXISTS by_type ON documents(mime_type,id);
CREATE INDEX IF NOT EXISTS by_date ON documents(created_at,id);
CREATE INDEX IF NOT EXISTS by_proposal ON documents(proposal,id);
CREATE TABLE IF NOT EXISTS membership(
 scope TEXT NOT NULL,id TEXT NOT NULL,filename TEXT NOT NULL,mime_type TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(scope,id));
CREATE INDEX IF NOT EXISTS member_filename ON membership(scope,filename,id);
CREATE INDEX IF NOT EXISTS member_type ON membership(scope,mime_type,id);
CREATE INDEX IF NOT EXISTS member_date ON membership(scope,created_at,id);
CREATE INDEX IF NOT EXISTS member_id ON membership(id);
CREATE TABLE IF NOT EXISTS counts(kind TEXT NOT NULL,name TEXT NOT NULL,value INTEGER NOT NULL,
 PRIMARY KEY(kind,name));
CREATE TABLE IF NOT EXISTS edges(source TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(source,target));
CREATE INDEX IF NOT EXISTS incoming ON edges(target,source);
CREATE TABLE IF NOT EXISTS dependencies(source TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(source,target));
CREATE INDEX IF NOT EXISTS dependents ON dependencies(target,source);
"""


def path(root):
    from symbiknow.organization.store import manifest
    name = (manifest(root) or {}).get("read_projection", "organization-read.sqlite3")
    return Path(root) / "index" / name


@contextmanager
def connection(root, create=False, *, file=None):
    with _FILES_LOCK:
        file = (file or path(root)).resolve()
        present = create or file.exists()
        if present:
            _LEASES[file] += 1
    if not present:
        yield None
        return
    db = None
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(file, timeout=15)
        db.row_factory = sqlite3.Row
        if create:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
        with db:
            yield db
    finally:
        if db is not None:
            db.close()
        with _FILES_LOCK:
            _LEASES[file] -= 1
            if not _LEASES[file]:
                del _LEASES[file]


def release_generation(root, name):
    with _FILES_LOCK:
        _PREPARED.discard((Path(root) / "index" / name).resolve())


def prune(root):
    """Discard at most 64 obsolete projections, preserving readers/preparation."""
    from itertools import islice
    with _FILES_LOCK:
        protected = {path(root).resolve(), *_LEASES, *_PREPARED}
        removed = 0
        for file in islice((Path(root) / "index").glob("organization-read*.sqlite3"), 256):
            if file.name != "organization-read.sqlite3" and not re.fullmatch(r"organization-read-[0-9a-f]{32}\.sqlite3", file.name):
                continue
            if file.resolve() in protected:
                continue
            for suffix in ("", "-wal", "-shm"):
                Path(str(file) + suffix).unlink(missing_ok=True)
            removed += 1
            if removed == 64:
                break


def ready(root):
    with connection(root) as db:
        return bool(db and db.execute("SELECT 1 FROM meta WHERE key='ready'").fetchone())


def fingerprint(root):
    from symbiknow.search.index import revisions
    from symbiknow.library.storage import source_revision
    return json.dumps([3, revisions(root), source_revision(root)], sort_keys=True)


def checkpoint(root):
    with connection(root) as db:
        if db is not None:
            db.execute("INSERT OR REPLACE INTO meta VALUES('fingerprint',?)", (fingerprint(root),))


def initialize(root):
    """Clean starts reuse durable projections; interrupted publications rebuild."""
    if ready(root):
        with connection(root) as db:
            saved = db.execute("SELECT value FROM meta WHERE key='fingerprint'").fetchone()
        if saved and saved[0] == fingerprint(root):
            return False
    rebuild(root)
    return True


def scope_key(folder=None, group=None):
    return json.dumps([folder, group], ensure_ascii=False, separators=(",", ":"))


def scopes(row):
    folder = row.get("folder", "")
    parts = folder.split(" / ")
    folders = [None, *[" / ".join(parts[:i]) for i in range(1, len(parts) + 1)]]
    return [scope_key(f, g) for f in folders for g in [None, *set(row.get("groups", []))]]


def counter_keys(row):
    folder = row.get("folder", "")
    keys = [("scope", key) for key in scopes(row)]
    keys += [("folder", folder), ("state", row.get("status", "pending"))]
    parts = folder.split(" / ")
    keys += [("folder-casefold", " / ".join(parts[:i]).casefold()) for i in range(1, len(parts) + 1)]
    for group in set(row.get("groups", [])):
        keys += [("group", group), ("group-folder:" + group, folder)]
    state = row.get("organization_status", "")
    if "failed" in state:
        keys.append(("state", "organization_failed"))
    if state in {"pending", "reset_pending"} and row.get("status") == "indexed":
        keys.append(("state", "organization_pending"))
    if not folder and not row.get("_manual", False):
        keys.append(("special", "unfiled_review_count"))
    return keys


def _delta(db, row, amount):
    db.executemany("INSERT INTO counts VALUES(?,?,?) ON CONFLICT(kind,name) DO UPDATE SET value=value+excluded.value",
                   [(kind, name, amount) for kind, name in counter_keys(row)])


def decode(value):
    return json.loads(zlib.decompress(value) if isinstance(value, bytes) else value)


def _put(db, row=None, identity=None):
    identity = identity or row["document_id"]
    old = db.execute("SELECT payload FROM documents WHERE id=?", (identity,)).fetchone()
    if old:
        _delta(db, decode(old[0]), -1)
    for table, column in (("documents", "id"), ("membership", "id"), ("edges", "source"), ("dependencies", "source")):
        db.execute(f"DELETE FROM {table} WHERE {column}=?", (identity,))
    if row is None:
        return
    state = json.loads(row.get("organization_json") or "{}")
    # This is an indexed candidate bit, not a verdict; bounded final validation
    # in DecisionService retains the existing evidence policy.
    from symbiknow.ai.jev import SUBJECT_CONFIDENCE
    outcome = state.get("ownership", {}).get("outcome", "")
    proposal = int(state.get("status") == "evaluated" and (
        outcome == "multiple_projects" or (outcome.startswith("o") and outcome[1:].isdigit())
        or (outcome == "accepted" and state.get("folder_confidence", 1) < SUBJECT_CONFIDENCE)
        or any(not item.get("accepted") and .5 <= item.get("topic", 0) < .8
               for item in state.get("link_evaluations", []))))
    values = (row.get("filename", ""), row.get("mime_type", ""), row.get("created_at", ""))
    db.execute("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)",
               (identity, *values, row.get("folder", ""), row.get("status", "pending"), proposal,
                zlib.compress(json.dumps({k: v for k, v in row.items() if k not in {"source", "index_error", "organization_json", "links_json"}}, ensure_ascii=False, separators=(",", ":")).encode())))
    db.executemany("INSERT INTO membership VALUES(?,?,?,?,?)", [(s, identity, *values) for s in scopes(row)])
    db.executemany("INSERT OR IGNORE INTO edges VALUES(?,?)", [(identity, link["document_id"])
                   for link in json.loads(row.get("links_json") or "[]") if link.get("document_id")])
    db.executemany("INSERT OR IGNORE INTO dependencies VALUES(?,?)", [(identity, target)
                   for target in json.loads(row.get("evidence_dependencies_json") or "{}")])
    _delta(db, row, 1)


def refresh(root, identities):
    if not ready(root):
        return
    from symbiknow.search.index import document_statuses
    from symbiknow.organization.edits import overrides
    identities = list(dict.fromkeys(identities))
    for start in range(0, len(identities), 256):
        batch = identities[start:start + 256]
        rows = document_statuses(root, batch)
        manual = overrides(root, batch)
        with connection(root) as db:
            for identity in batch:
                row = rows.get(identity)
                _put(db, {**row, "_manual": identity in manual} if row else None, identity)
            db.execute("INSERT OR REPLACE INTO meta VALUES('revision',?)", (uuid.uuid4().hex,))
            db.execute("DELETE FROM counts WHERE value<=0")
        from symbiknow.search.index import publish_scope_postings
        publish_scope_postings(root, list(rows.values()))
    checkpoint(root)


def rebuild(root):
    """Streaming startup/migration; caller owns the publication lock."""
    from symbiknow.search.index import metadata_batches
    from symbiknow.organization.edits import overrides
    with connection(root, create=True) as db:
        for table in ("documents", "membership", "counts", "edges", "dependencies", "meta"):
            db.execute(f"DELETE FROM {table}")
        for batch in metadata_batches(root):
            manual = overrides(root, [r["document_id"] for r in batch])
            for row in batch:
                _put(db, {**row, "_manual": row["document_id"] in manual})
        db.execute("INSERT INTO meta VALUES('ready','1')")
        db.execute("INSERT INTO meta VALUES('revision',?)", (uuid.uuid4().hex,))
    checkpoint(root)


def prepare_generation(root, publication, capture):
    """Prepare a new projection off-path; final revision guards bind its inputs."""
    from symbiknow.search.index import INDEX_LOCK, captured_metadata_page, publish_scope_postings
    from symbiknow.organization.store import overlay, _pinned
    from symbiknow.organization.edits import overrides
    name = "organization-read-" + uuid.uuid4().hex + ".sqlite3"
    target = Path(root) / "index" / name
    table = _pinned(str(Path(root).resolve()), publication["table"], publication["version"])
    with _FILES_LOCK:
        _PREPARED.add(target.resolve())
    after = ""
    try:
        with connection(root, create=True, file=target) as db:
            while True:
                with INDEX_LOCK:
                    batch = captured_metadata_page(root, capture, after, 128)
                    if not batch:
                        break
                    old = overlay(root, batch)
                    rows = overlay(root, batch, publication_table=table)
                    manual = overrides(root, [r["document_id"] for r in rows])
                    # Add future candidates without removing current candidates.
                    # Final organization/evidence guards still decide membership.
                    publish_scope_postings(root, rows, additional=old)
                for row in rows:
                    _put(db, {**row, "_manual": row["document_id"] in manual})
                after = batch[-1]["document_id"]
            db.execute("INSERT INTO meta VALUES('ready','1')")
            db.execute("INSERT INTO meta VALUES('scope_postings','1')")
            db.execute("INSERT INTO meta VALUES('revision',?)", (uuid.uuid4().hex,))
        return name
    except BaseException:
        release_generation(root, name)
        target.unlink(missing_ok=True)
        raise


def related(root, identity, *, dependencies=False, limit=100, after=""):
    with connection(root) as db:
        table = "dependencies" if dependencies else "edges"
        return [r[0] for r in db.execute(f"SELECT source FROM {table} WHERE target=? AND source>? ORDER BY source LIMIT ?",
                                       (identity, after, limit))]


def candidates(root, after="", limit=100, inclusive=False):
    with connection(root) as db:
        return [r[0] for r in db.execute(f"SELECT id FROM documents WHERE proposal=1 AND id {'>=' if inclusive else '>'} ? ORDER BY id LIMIT ?", (after, limit))]


def source_changed(root, identity):
    """Revoke projections at the original commit boundary, before reconciliation."""
    if not ready(root):
        return
    with connection(root) as db:
        # The indexed reverse dependency lookup touches affected documents only.
        ids = [identity, *[r[0] for r in db.execute("SELECT source FROM dependencies WHERE target=?", (identity,))]]
        changed = []
        for key in ids:
            found = db.execute("SELECT payload FROM documents WHERE id=?", (key,)).fetchone()
            if found:
                row = decode(found[0])
                row.update(folder=row.get("folder", "") if row.get("_manual") else "", groups=[],
                           links_json="[]", organization_json="{}", organization_status="pending")
                if key == identity:
                    row.update(status="pending", indexed_version="")
                _put(db, row)
                changed.append(row)
        db.execute("DELETE FROM counts WHERE value<=0")
        db.execute("INSERT OR REPLACE INTO meta VALUES('revision',?)", (uuid.uuid4().hex,))
    # Final evidence/head guards reject stale postings until reconciliation.
    # Never acquire the index lock while holding the original storage lock.


def aggregates(root, folder=None, group=None, *, after="", limit=100):
    if not 1 <= limit <= 100:
        raise ValueError("Use a taxonomy limit between 1 and 100")
    with connection(root) as db:
        revision = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
        positions = [None, None]
        if after:
            try:
                token = json.loads(base64.urlsafe_b64decode(after))
                if len(token) != 3 or token[0] != revision:
                    raise ValueError()
                positions = token[1:]
            except (ValueError, TypeError, IndexError, binascii.Error):
                raise ValueError("Taxonomy changed; restart browsing") from None
        def counts(kind, start=None, scope=None):
            clauses, args = ["kind=?"], [kind]
            if start is not None:
                clauses.append("name>?")
                args.append(start)
            if scope is not None:
                if scope:
                    clauses.append("(name=? OR (name>=? AND name<?))")
                    args.extend([scope, scope + " / ", scope + " /! "])
                else:
                    clauses.append("name=''")
            return {r[0]: r[1] for r in db.execute(
                "SELECT name,value FROM counts WHERE " + " AND ".join(clauses) + " ORDER BY name LIMIT ?", (*args, limit + 1))}
        folders, groups = counts("folder", positions[0]), counts("group", positions[1])
        more = len(folders) > limit or len(groups) > limit
        folders, groups = dict(list(folders.items())[:limit]), dict(list(groups.items())[:limit])
        next_after = base64.urlsafe_b64encode(json.dumps([
            revision, list(folders)[-1] if folders else positions[0], list(groups)[-1] if groups else positions[1]
        ]).encode()).decode() if more else None
        scoped = counts("group-folder:" + group if group is not None else "folder", scope=folder)
        total = db.execute("SELECT value FROM counts WHERE kind='scope' AND name=?", (scope_key(),)).fetchone()
        unfiled = db.execute("SELECT value FROM counts WHERE kind='special' AND name='unfiled_review_count'").fetchone()
        return dict(folders=folders, scoped_folders=dict(list(scoped.items())[:limit]),
                    groups=list(groups), processing_states=counts("state"),
                    library_total=total[0] if total else 0, unfiled_review_count=unfiled[0] if unfiled else 0,
                    taxonomy_has_more=more, taxonomy_next_after=next_after)


def browse(root, limit=60, folder=None, group=None, recent=False, sort="filename", descending=False, cursor=None, offset=0):
    column = {"filename": "filename", "type": "mime_type", "date": "created_at"}.get(sort)
    if column is None or not 1 <= limit <= 1001 or offset < 0 or offset > 10000:
        raise ValueError("Use a valid sort, a bounded limit and cursor pagination")
    column = "created_at" if recent else column
    descending = recent or descending
    key = scope_key(folder, group)
    binding = hashlib.sha256(json.dumps([key, column, descending]).encode()).hexdigest()
    with connection(root) as db:
        revision = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0]
        params = [key]
        where = "m.scope=?"
        if cursor:
            try:
                token = json.loads(base64.urlsafe_b64decode(cursor))
                if not isinstance(token, list) or len(token) != 4 or not all(isinstance(v, str) for v in token) or token[0:2] != [revision, binding]:
                    raise ValueError()
                where += f" AND (m.{column},m.id) {'<' if descending else '>'} (?,?)"
                params += token[2:4]
            except (ValueError, TypeError, IndexError, binascii.Error):
                raise ValueError("Library changed or cursor belongs to another view; restart browsing") from None
        direction = "DESC" if descending else "ASC"
        rows = db.execute(f"SELECT d.payload,m.{column},m.id FROM membership m JOIN documents d ON d.id=m.id WHERE {where} ORDER BY m.{column} {direction},m.id {direction} LIMIT ? OFFSET ?", (*params, limit + 1, offset)).fetchall()
        total = db.execute("SELECT value FROM counts WHERE kind='scope' AND name=?", (key,)).fetchone()
        more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = base64.urlsafe_b64encode(json.dumps([revision, binding, rows[-1][1], rows[-1][2]]).encode()).decode() if more else None
        documents = [{k: v for k, v in decode(r[0]).items() if not k.startswith("_")} for r in rows]
        return dict(documents=documents, total=total[0] if total else 0, offset=offset, has_more=more, next_cursor=next_cursor)


def scope_exists(root, kind, value):
    with connection(root) as db:
        key = scope_key(folder=value) if kind == "folder" else scope_key(group=value)
        return bool(db.execute("SELECT 1 FROM counts WHERE kind='scope' AND name=? AND value>0", (key,)).fetchone())
