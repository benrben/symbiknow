"""Bounded reads across retained organization ledgers; no synthesized history."""
from contextlib import closing
import json
import sqlite3

from symbiknow.library import storage
from symbiknow.library.catalog import _digest, _limit, _revision, inventory_document, page_cursor, read_cursor


def history(context, document_id, *, limit=50, cursor=None):
    """Bounded provenance ledger reads; order is stable, not invented chronology."""
    root = context.DATA_DIR
    _limit(limit)
    identity = storage._validate_id(document_id)
    from symbiknow.organization import edits, receipts, projects
    from symbiknow.search import index
    with context.snapshots.read() as snapshot:
        metadata = snapshot.metadata_many([identity]).get(identity)
        if not metadata:
            raise FileNotFoundError("Document not found")
        revision = _digest([_revision(root), receipts.revision(root)])
        binding = _digest(["organization-history-v1", revision, identity, limit])
        after = read_cursor(cursor, binding)
        row = index.document_statuses(root, [identity]).get(identity)
        if row is None or row.get("version") != metadata["version"]:
            row = projects.overlay(root, [{"document_id": identity, "version": metadata["version"],
                                          "status": "unregistered", "organization_json": "{}", "folder": "", "groups": []}])[0]
            manual = edits.override(root, identity)
            if manual:
                state = json.loads(row["organization_json"])
                state["manual_folder_override"] = manual
                row.update(folder=manual["folder"], organization_json=json.dumps(state))
        current = inventory_document(metadata, row)
        state = json.loads((row or {}).get("organization_json") or "{}")
        current.update(automatic_owner_suggestion=state.get("automatic_owner_suggestion"),
                       effective_owner=state.get("effective_owner", state.get("canonical_project")),
                       manual_folder_override=edits.override(root, identity))
        events = []
        sources = [
            ("correction", "organization-corrections.sqlite3", "corrections", "document=?", (identity,)),
            ("ownership", "project-identities.sqlite3", "history", "json_extract(payload,'$.document_id')=?", (identity,)),
            ("decision", "jev-decisions.sqlite3", "receipts", "substr(id,1,instr(id,':')-1)=?", (identity,)),
        ]
        after_kind, _, after_position = after.partition(":")
        if after and (after_kind not in {"correction", "ownership", "decision", "manual"}
                      or (after_kind != "manual" and not after_position.isdigit())):
            raise ValueError("Invalid history cursor; restart pagination")
        for kind, filename, table, condition, args in sources:
            if kind < after_kind:
                continue
            position_after = int(after_position) if kind == after_kind else 0
            path = root / "temp" / filename
            if not path.exists():
                continue
            # Each durable ledger contributes at most limit+1 rows. The
            # composite key makes pagination independent of missing dates.
            with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
                rows = db.execute(f"SELECT rowid,payload FROM {table} WHERE {condition} "
                                  "AND rowid>? ORDER BY rowid LIMIT ?",
                                  (*args, position_after, limit + 1)).fetchall()
            for position, payload in rows:
                value = json.loads(payload)
                key = f"{kind}:{position:020d}"
                event = dict(id=value.get("id", value.get("revision", key)), kind=kind,
                             action=value.get("action", "correct-ownership" if kind == "ownership" else "recorded-decision"),
                             actor=value.get("actor"), timestamp=value.get("timestamp", value.get("created_at")),
                             reason=value.get("reason"), version=value.get("version"),
                             document_id=identity, evidence_revision=value.get("evidence_revision"))
                for field in ("value", "effective_owner", "automatic_owner_suggestion", "target_document_id", "target_version"):
                    if field in value:
                        item = value[field]
                        # Retained proof bodies can be large. History presents
                        # the correction value; exact proofs remain in detail.
                        if isinstance(item, dict):
                            allowed = {"id", "name", "document_id", "version", "source_version", "relation",
                                       "source_chunk_id", "target_chunk_id", "reviewed_by", "decision_id", "correction_id"}
                            item = {key: child for key, child in item.items() if key in allowed}
                        event[field] = item
                events.append((key, event))
        manual = current["manual_folder_override"]
        if manual:
            key = "manual:current"
            if key > after:
                events.append((key, dict(id="manual:" + str(manual.get("revision", identity)), kind="manual",
                                        action="manual-folder-override", actor=manual.get("actor"),
                                        timestamp=manual.get("timestamp", manual.get("created_at")),
                                        reason=manual.get("reason"), version=manual.get("version"),
                                        document_id=identity, value=manual.get("folder"))))
        events.sort(key=lambda item: item[0])
        more = len(events) > limit
        return dict(document_id=identity, current=current, entries=[event for _, event in events[:limit]],
                    revision=revision, has_more=more,
                    next_cursor=page_cursor(binding, events[limit - 1][0]) if more else None,
                    limitations=["Only retained explicit records are included; automatic organization is current state, not a complete historical log.",
                                 "Older manual placements and decision receipts may not record an actor, date or version; missing values are null.",
                                 "Entries use stable ledger order, not chronological order."])
