"""Schema 1 manual folder overrides and recoverable metadata transactions.

Original OCFL objects are never written here. The atomic ledger is authoritative
across content updates; a prepared transaction rolls forward after interruption.
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


def clear(data_dir, identities, reset=False):
    state = read(data_dir)
    for identity in identities:
        state["assignments"].pop(identity, None)
    state["revision"] = str(uuid.uuid4())
    if reset:
        state["change"] = {"kind": "reset", "document_ids": list(identities)}
    atomic(path(data_dir), state)


def recover(data_dir):
    from app.search import save_organization, get_document_status

    state = read(data_dir)
    transaction = state.get("transaction")
    if not transaction:
        return
    for identity, decision in transaction["decisions"].items():
        row = get_document_status(data_dir, identity)
        if row:
            # On startup no worker can race recovery. Filter links whose heads changed.
            from app.storage import current_version

            decision = {
                **decision,
                "links": [
                    link
                    for link in decision.get("links", [])
                    if link.get("source_version") == row["version"]
                    and current_version(data_dir, link["document_id"]) == link.get("version")
                ],
            }
            save_organization(data_dir, identity, row["version"], decision)
    state.pop("transaction")
    atomic(path(data_dir), state)


def edit(action, args):
    from app import server
    from app.rebuild import status
    from app.search import INDEX_LOCK, _table, folder_condition, get_document_status

    with server.write_lock, INDEX_LOCK:
        job = status()
        if job and job["status"] in {"queued", "running"}:
            raise ValueError("Wait for the organization job to finish before moving or renaming")
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
            rows = (
                table.search()
                .where(folder_condition(source))
                .limit(max(1, table.count_rows()))
                .to_list()
                if table
                else []
            )
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
                    table.search().select(["folder"]).limit(max(1, table.count_rows())).to_batches()
                ):
                    for row in batch.to_pylist():
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
        before = read(server.DATA_DIR)
        decisions = {}
        for row in rows:
            identity = row["document_id"]
            state["assignments"][identity] = {"folder": destinations[identity]}
            decisions[identity] = {
                **json.loads(row["organization_json"]),
                "status": row["organization_status"],
                "folder": destinations[identity],
                "groups": row["groups"],
                "links": json.loads(row["links_json"]),
                "origin": "manual",
            }
        state["revision"] = str(uuid.uuid4())
        state["change"] = {
            "kind": "rename" if rename else "move",
            "paths": rename,
            "document_ids": list(destinations),
        }
        state["transaction"] = {"decisions": decisions}
        atomic(path(server.DATA_DIR), state)
        try:
            recover(server.DATA_DIR)
        except Exception:
            atomic(path(server.DATA_DIR), before)
            from app.search import save_organization

            for row in rows:
                save_organization(
                    server.DATA_DIR,
                    row["document_id"],
                    row["version"],
                    {
                        **json.loads(row["organization_json"]),
                        "status": row["organization_status"],
                        "folder": row["folder"],
                        "groups": row["groups"],
                        "links": json.loads(row["links_json"]),
                    },
                )
            raise
        return {"updated": len(rows), "folder": destination, "paths": rename}
