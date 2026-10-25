"""Atomic authoritative manual overrides shared by display and scope filtering.

Placements survive source updates and automatic review. Explicit Reset can remove
the selected pre-request assignments; subsequent manual edits always win. The recovery
consumes assignments already committed by earlier schema 1 edit transactions.
"""

import json
import os
import re
import uuid
import sqlite3
from contextlib import contextmanager
from collections import OrderedDict
import threading
from pathlib import Path


def atomic(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as handle:
        json.dump(state, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def path(data_dir):
    return Path(data_dir) / "temp" / "manual-organization.json"


_SNAPSHOTS = OrderedDict()
_SNAPSHOT_LOCK = threading.RLock()
_FOLDER_OPERATIONS = threading.RLock()


@contextmanager
def _database(data_dir):
    file = path(data_dir).with_suffix(".sqlite3")
    file.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file, timeout=15)
    try:
        with _SNAPSHOT_LOCK:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,args TEXT,state TEXT,result TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS moves(operation TEXT,id TEXT,version TEXT,source TEXT,destination TEXT,state TEXT DEFAULT 'pending',PRIMARY KEY(operation,id))")
            db.execute("CREATE INDEX IF NOT EXISTS pending_moves ON moves(operation,state,id)")
        legacy = path(data_dir)
        # The marker lives in the copied database: file inode/mtime are not a
        # migration identity. Import and marker commit together, exactly once.
        with db:
            saved = db.execute("SELECT payload FROM metadata WHERE key='legacy'").fetchone()
            if not saved:
                db.execute("BEGIN IMMEDIATE")
                saved = db.execute("SELECT payload FROM metadata WHERE key='legacy'").fetchone()
            if not saved:
                value = json.loads(legacy.read_text()) if legacy.exists() else {"schema": 1, "assignments": {}}
                db.executemany("INSERT OR IGNORE INTO assignments VALUES(?,?)", [(identity, json.dumps(assignment)) for identity, assignment in value["assignments"].items()])
                db.execute("INSERT OR IGNORE INTO metadata VALUES('summary',?)", (json.dumps({k: value[k] for k in ("revision", "change") if k in value}),))
                db.execute("INSERT INTO metadata VALUES('legacy','imported')")
            yield db
    finally:
        db.close()


def _publish(db, change):
    # Presentation invalidation is bounded even when a background operation moves
    # a large folder. The authoritative assignments are indexed separately.
    ids = change.get("document_ids", [])
    change = {**change, "document_ids": ids[:100], "all_documents": len(ids) > 100}
    db.execute("INSERT OR REPLACE INTO metadata VALUES('summary',?)",
               (json.dumps({"revision": str(uuid.uuid4()), "change": change}),))


def read(data_dir):
    """Full export for background maintenance; never used by a bounded read."""
    with _database(data_dir) as db:
        state = json.loads(db.execute("SELECT payload FROM metadata WHERE key='summary'").fetchone()[0])
        return {"schema": 1, **state, "assignments": {r[0]: json.loads(r[1]) for r in db.execute("SELECT id,payload FROM assignments")}}


def summary(data_dir):
    with _database(data_dir) as db:
        return json.loads(db.execute("SELECT payload FROM metadata WHERE key='summary'").fetchone()[0])


def assignment_ids(data_dir):
    with _database(data_dir) as db:
        return frozenset(r[0] for r in db.execute("SELECT id FROM assignments"))


def normalize(value, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError("Folder path must be text")
    parts = [part.strip() for part in re.split(r"\s*[/\\›]\s*", value.strip())]
    if allow_empty and parts == [""]:
        return ""
    if len(parts) > 12 or any(
        not part
        or part in {".", ".."}
        or len(part) > 200
        or any(ord(c) < 32 or ord(c) == 127 for c in part)
        for part in parts
    ):
        raise ValueError("Use nonempty folder names, at most 200 characters per level")
    return " / ".join(parts)


def override(data_dir, identity):
    return overrides(data_dir, [identity]).get(identity)


def overrides(data_dir, identities):
    """One indexed lookup per bounded batch; no full-ledger deserialization."""
    from itertools import islice
    result = {}
    iterator = iter(dict.fromkeys(identities))
    with _database(data_dir) as db:
        while batch := list(islice(iterator, 256)):
            result.update((r[0], json.loads(r[1])) for r in db.execute(
                "SELECT id,payload FROM assignments WHERE id IN (" + ",".join("?" for _ in batch) + ")", batch))
    return result


def clear(data_dir, identities, reset=False):
    identities = list(identities)
    with _database(data_dir) as db:
        db.executemany("DELETE FROM assignments WHERE id=?", [(identity,) for identity in identities])
        _publish(db, {"kind": "reset" if reset else "move", "document_ids": identities})
    from symbiknow.organization import readmodel
    readmodel.refresh(data_dir, identities)


def reset_expected(data_dir, expected, request_id):
    """Replayable reset; the SQL predicate preserves every later manual edit."""
    removed = []
    with _database(data_dir) as db:
        for identity, assignment in expected.items():
            found = db.execute("SELECT payload FROM assignments WHERE id=?", (identity,)).fetchone()
            if found and json.loads(found[0]) == assignment:
                db.execute("DELETE FROM assignments WHERE id=?", (identity,))
                removed.append(identity)
        if removed:
            _publish(db, {"kind": "reset", "request_id": request_id, "document_ids": removed})
    if removed:
        from symbiknow.organization import readmodel
        readmodel.refresh(data_dir, removed)


def recover(data_dir):
    # Legacy authoritative assignments migrate transactionally on first access.
    with _database(data_dir):
        pass


def edit(action, args, context=None, *, operation_id=None):
    from symbiknow.core.application import current_application
    server = context or current_application()
    from symbiknow.search.index import INDEX_LOCK, _table, get_document_status
    from symbiknow.organization import readmodel
    if action != "move-documents" and readmodel.ready(server.DATA_DIR):
        with _FOLDER_OPERATIONS:
            return _edit_folder(action, args, server, operation_id or str(uuid.uuid4()))

    with server.write_lock, INDEX_LOCK:
        recover(server.DATA_DIR)
        table = _table(server.DATA_DIR, "documents")
        rows = []
        rename = None
        if action == "move-documents":
            items = args.get("documents", [])
            if not isinstance(items, list) or not 1 <= len(items) <= 100:
                raise ValueError("Select 1–100 loaded documents")
            destination = normalize(args["folder"], allow_empty=True)
            for item in items:
                row = get_document_status(server.DATA_DIR, item["document_id"])
                if row is None or row["version"] != item["expected_version"]:
                    raise ValueError("A selected file changed; refresh before moving it")
                rows.append(row)
            destinations = {row["document_id"]: destination for row in rows}
        else:
            source = normalize(args["folder"])
            from symbiknow.organization.store import scope_condition, overlay
            rows = (
                table.search()
                .where(scope_condition(server.DATA_DIR, source))
                .limit(max(1, table.count_rows()))
                .to_list()
                if table
                else []
            )
            rows = overlay(server.DATA_DIR, rows)
            if not rows:
                raise FileNotFoundError("Folder not found")
            if action == "remove-folder":
                destination = ""
            elif action == "rename-folder":
                name = normalize(args["name"])
                if " / " in name:
                    raise ValueError("Rename accepts one folder name; use Move to for a path")
                parent = source.rsplit(" / ", 1)[0] if " / " in source else ""
                destination = (parent + " / " if parent else "") + name
            else:
                parent = normalize(args["destination"], allow_empty=True)
                if parent == source or parent.startswith(source + " / "):
                    raise ValueError("A folder cannot move into itself or a descendant")
                destination = (parent + " / " if parent else "") + source.split(" / ")[-1]
            if destination and source != destination:
                for batch in (
                    table.search().limit(max(1, table.count_rows())).to_batches(batch_size=512)
                ):
                    for row in overlay(server.DATA_DIR, batch.to_pylist()):
                        folder = row["folder"]
                        if (
                            folder.casefold() == destination.casefold()
                            or folder.casefold().startswith(destination.casefold() + " / ")
                        ):
                            raise ValueError(
                                "A folder already exists at the destination; choose another name"
                            )
            destinations = {
                row["document_id"]: destination + row["folder"][len(source) :]
                if destination
                else ""
                for row in rows
            }
            rename = {"from": source, "to": destination} if destination else None

        with _database(server.DATA_DIR) as db:
            db.executemany("INSERT OR REPLACE INTO assignments VALUES(?,?)", [
                (identity, json.dumps({"folder": folder, "revision": str(uuid.uuid4())}))
                for identity, folder in destinations.items()])
            _publish(db, {"kind": "rename" if rename else "move", "paths": rename, "document_ids": list(destinations)})
        from symbiknow.organization import readmodel
        readmodel.refresh(server.DATA_DIR, destinations)
        return {"updated": len(rows), "folder": destination, "paths": rename}


def _edit_folder(action, args, context, operation_id):
    """Capture once, then publish bounded guarded batches with durable progress."""
    from symbiknow.organization import readmodel
    from symbiknow.search.index import document_statuses
    from itertools import islice
    root = context.DATA_DIR
    binding = json.dumps([action, args], sort_keys=True)
    source = normalize(args["folder"])
    if action == "remove-folder":
        destination = ""
    elif action == "rename-folder":
        name = normalize(args["name"])
        if " / " in name:
            raise ValueError("Rename accepts one folder name; use Move to for a path")
        parent = source.rsplit(" / ", 1)[0] if " / " in source else ""
        destination = (parent + " / " if parent else "") + name
    elif action == "move-folder":
        parent = normalize(args["destination"], allow_empty=True)
        if parent == source or parent.startswith(source + " / "):
            raise ValueError("A folder cannot move into itself or a descendant")
        destination = (parent + " / " if parent else "") + source.split(" / ")[-1]
    else:
        raise ValueError("Unknown organization edit")
    rename = {"from": source, "to": destination} if destination else None
    with _database(root) as db:
        old = db.execute("SELECT args,state,result FROM operations WHERE id=?", (operation_id,)).fetchone()
        if old and old[0] != binding:
            raise ValueError("Operation ID belongs to another edit")
        if old and old[1] == "completed":
            return json.loads(old[2])
        capturing = not old or old[1] == "capturing"
        if capturing:
            db.execute("INSERT OR REPLACE INTO operations VALUES(?,?,'capturing',NULL)", (operation_id, binding))
            db.execute("DELETE FROM moves WHERE operation=?", (operation_id,))
    if capturing:
        with readmodel.connection(root) as snapshot:
            snapshot.execute("BEGIN")
            if destination and destination != source and snapshot.execute(
                "SELECT 1 FROM counts WHERE kind='folder-casefold' AND name=? AND value>0", (destination.casefold(),)).fetchone():
                raise ValueError("A folder already exists at the destination; choose another name")
            cursor = snapshot.execute("SELECT d.payload FROM membership m JOIN documents d ON d.id=m.id WHERE m.scope=? ORDER BY m.id", (readmodel.scope_key(source),))
            count = 0
            while batch := list(islice(cursor, 128)):
                values = []
                for row in batch:
                    row = readmodel.decode(row[0])
                    target = destination + row["folder"][len(source):] if destination else ""
                    values.append((operation_id, row["document_id"], row["version"], row["folder"], target))
                with _database(root) as db:
                    db.executemany("INSERT INTO moves(operation,id,version,source,destination) VALUES(?,?,?,?,?)", values)
                count += len(values)
            if not count:
                raise FileNotFoundError("Folder not found")
        with _database(root) as db:
            db.execute("UPDATE operations SET state='applying' WHERE id=?", (operation_id,))
    while True:
        if context.stop.is_set():
            raise InterruptedError("Folder edit will resume after restart")
        with _database(root) as db:
            batch = db.execute("SELECT id,version,source,destination FROM moves WHERE operation=? AND state='pending' ORDER BY id LIMIT 16", (operation_id,)).fetchall()
        if not batch:
            break
        with context.snapshots.read() as snapshot:
            ids = [r[0] for r in batch]
            rows, heads = document_statuses(root, ids), snapshot.heads_many(ids)
            applied = []
            with _database(root) as db:
                for identity, version, old_folder, target in batch:
                    row = rows.get(identity)
                    valid = row and row["version"] == heads.get(identity) == version and row["folder"] == old_folder
                    if valid:
                        db.execute("INSERT OR REPLACE INTO assignments VALUES(?,?)", (identity, json.dumps({"folder": target, "revision": str(uuid.uuid4())})))
                        applied.append(identity)
                    db.execute("UPDATE moves SET state=? WHERE operation=? AND id=?", ("applied" if valid else "skipped", operation_id, identity))
                _publish(db, {"kind": "rename" if rename else "move", "paths": rename, "document_ids": applied})
            readmodel.refresh(root, applied)
    with _database(root) as db:
        counts = dict(db.execute("SELECT state,count(*) FROM moves WHERE operation=? GROUP BY state", (operation_id,)))
        result = {"updated": counts.get("applied", 0), "skipped": counts.get("skipped", 0), "folder": destination, "paths": rename}
        db.execute("UPDATE operations SET state='completed',result=? WHERE id=?", (json.dumps(result), operation_id))
        db.execute("DELETE FROM moves WHERE operation=?", (operation_id,))
    return result
