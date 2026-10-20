"""Atomic authoritative manual overrides shared by display and scope filtering.

Placements survive source updates and automatic review. Explicit Reset can remove
the selected pre-request assignments; subsequent manual edits always win. The recovery
consumes assignments already committed by earlier schema 1 edit transactions.
"""

import json
import os
import re
import uuid
import copy
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


def _state(data_dir):
    file = path(data_dir).resolve()
    with _SNAPSHOT_LOCK:
        stamp = (file.stat().st_mtime_ns, file.stat().st_ino) if file.exists() else None
        cached = _SNAPSHOTS.get(file)
        if cached is None or cached[0] != stamp:
            value = json.loads(file.read_text()) if stamp else {"schema": 1, "assignments": {}}
            cached = (stamp, value, frozenset(value["assignments"]))
            _SNAPSHOTS[file] = cached
        _SNAPSHOTS.move_to_end(file)
        while len(_SNAPSHOTS) > 4:
            _SNAPSHOTS.popitem(last=False)
        return cached[1]


def read(data_dir):
    # Mutable copies only for callers performing an edit.
    with _SNAPSHOT_LOCK:
        return copy.deepcopy(_state(data_dir))


def summary(data_dir):
    with _SNAPSHOT_LOCK:
        value = _state(data_dir)
        return {key: copy.deepcopy(value[key]) for key in ("revision", "change") if key in value}


def assignment_ids(data_dir):
    with _SNAPSHOT_LOCK:
        _state(data_dir)
        return _SNAPSHOTS[path(data_dir).resolve()][2]


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
    return copy.deepcopy(_state(data_dir)["assignments"].get(identity))


def overrides(data_dir, identities):
    """One authoritative ledger snapshot for a bounded metadata batch."""
    with _SNAPSHOT_LOCK:
        assignments = _state(data_dir)["assignments"]
        return {identity: copy.deepcopy(assignments[identity]) for identity in identities if identity in assignments}


def clear(data_dir, identities, reset=False):
    state = read(data_dir)
    for identity in identities:
        state["assignments"].pop(identity, None)
    state["revision"] = str(uuid.uuid4())
    if reset:
        state["change"] = {"kind": "reset", "document_ids": list(identities)}
    atomic(path(data_dir), state)


def reset_expected(data_dir, expected, request_id):
    """Replayable explicit reset: never erase a manual edit made after capture."""
    with _SNAPSHOT_LOCK:
        state = read(data_dir)
        removed = [identity for identity, assignment in expected.items()
                   if state["assignments"].get(identity) == assignment]
        if not removed:
            return
        for identity in removed:
            state["assignments"].pop(identity)
        state["revision"] = str(uuid.uuid4())
        state["change"] = {"kind": "reset", "request_id": request_id, "document_ids": removed}
        atomic(path(data_dir), state)


def recover(data_dir):
    # Schema 1 transactions already stored their authoritative assignments before
    # writing derived rows. The shared manual view now publishes those atomically.
    state = read(data_dir)
    if state.pop("transaction", None) is not None:
        atomic(path(data_dir), state)


def edit(action, args, context=None):
    from symbiknow.core.application import current_application
    server = context or current_application()
    from symbiknow.search.index import INDEX_LOCK, _table, get_document_status

    with server.write_lock, INDEX_LOCK:
        recover(server.DATA_DIR)
        state = read(server.DATA_DIR)
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

        for row in rows:
            identity = row["document_id"]
            state["assignments"][identity] = {"folder": destinations[identity], "revision": str(uuid.uuid4())}
        state["revision"] = str(uuid.uuid4())
        state["change"] = {
            "kind": "rename" if rename else "move",
            "paths": rename,
            "document_ids": list(destinations),
        }
        atomic(path(server.DATA_DIR), state)
        return {"updated": len(rows), "folder": destination, "paths": rename}
