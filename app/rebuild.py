"""Durable selective organization requests, processed by the one ingestion worker."""

from __future__ import annotations

import json
import os
import uuid
import copy
from collections.abc import MutableMapping
from pathlib import Path
from itertools import islice
from datetime import datetime, timezone

from app import server, storage
from app.search import (
    INDEX_LOCK,
    _table,
    document_evidence,
    folder_condition,
    organization_neighbors,
    get_document_status,
    save_organization,
    _organization_names,
    project_roster,
)


def _path():
    return server.DATA_DIR / "temp" / "organization-rebuild.json"


_SNAPSHOT = None
_STAMP = None
_ACTIVE_JOB = None
_ACTIVE_STAMP = None
_PERSISTED = None


def _stamp():
    files = [_path(), _path().with_suffix(".jsonl")]
    return tuple(
        (str(f), f.stat().st_ino, f.stat().st_mtime_ns, f.stat().st_size)
        if f.exists()
        else (str(f),)
        for f in files
    )


def _state():
    """Durable snapshot, reloaded/replayed once per external revision."""
    global _SNAPSHOT, _STAMP
    stamp = _stamp()
    if stamp != _STAMP:
        value = json.loads(_path().read_text()) if _path().exists() else None
        journal = _path().with_suffix(".jsonl")
        if value and journal.exists():
            with journal.open() as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        break  # Interrupted final append is replayable.
                    if event.get("checkpoint") != value.get("checkpoint"):
                        continue
                    value.update(event["progress"])
                    identity = event.get("identity")
                    if identity:
                        if event["kind"] == "completed" and identity not in value["completed_ids"]:
                            value["completed_ids"].append(identity)
                        elif event["kind"] in {"failures", "skips"}:
                            value.setdefault(event["kind"], {})[identity] = event["reason"]
                        if event.get("outcome") is not None:
                            value.setdefault("outcomes", {})[identity] = event["outcome"]
        _SNAPSHOT, _STAMP = value, stamp
    return _SNAPSHOT


def _active_state():
    global _ACTIVE_JOB, _ACTIVE_STAMP, _PERSISTED
    if _ACTIVE_STAMP != _stamp():
        _ACTIVE_JOB = copy.deepcopy(_state())
        _ACTIVE_STAMP = _stamp()
        _PERSISTED = None
    return _ACTIVE_JOB


def owns(identity):
    with server.write_lock:
        state = _active_state()
        if not state or state["status"] not in {"queued", "running"}:
            return False
        global _OWNED
        if _OWNED[0] != state["request_id"]:
            _OWNED = (state["request_id"], frozenset(state["document_ids"]))
        return identity in _OWNED[1]


_OWNED = (None, frozenset())


def common_context():
    with server.write_lock:
        return list((_active_state() or {}).get("common_lines", []))


def status():
    with server.write_lock:
        value = copy.deepcopy(_state())
        # Live activity is a compact overlay; durable completion remains checkpointed.
        if (
            value
            and _ACTIVE_JOB
            and _ACTIVE_STAMP == _stamp()
            and _ACTIVE_JOB["request_id"] == value["request_id"]
        ):
            for key in ("activity", "current_filename"):
                if key in _ACTIVE_JOB:
                    value[key] = _ACTIVE_JOB[key]
        return value


def progress():
    with server.write_lock:
        state = _active_state()
        if state is None:
            return None
        keys = (
            "request_id",
            "status",
            "phase",
            "activity",
            "current_filename",
            "total",
            "layout_revision",
            "layout_scope",
            "folder",
            "grouping",
            "links",
            "mode",
            "grouped",
            "unfiled",
            "links_added",
        )
        return {key: state.get(key) for key in keys} | {
            "completed": len(state["completed_ids"]),
            "failed": len(state["failures"]),
            "skipped": len(state.get("skips", {})),
            "details": copy.deepcopy(state.get("progress_details", [])),
            "failures": dict(islice(state["failures"].items(), 30)),
        }


def _persist(state, progress_only=False):
    """Append one small outcome per item. Full checkpoints only at phase boundaries.

    Both publication and each journal record are replayable. A new checkpoint ID
    makes old journal tails harmless after a crash between replacement/truncation.
    """
    global _SNAPSHOT, _STAMP, _ACTIVE_JOB, _ACTIVE_STAMP, _PERSISTED
    from app.organization_edits import atomic

    if progress_only:
        _ACTIVE_JOB = state
        return
    previous = _PERSISTED
    full = (
        previous is None
        or previous["request_id"] != state["request_id"]
        or state.get("phase") == "clearing"
        or previous["phase"] != state.get("phase")
        or previous["taxonomy_ready"] != state.get("taxonomy_ready")
    )
    journal = _path().with_suffix(".jsonl")
    if full:
        state["checkpoint"] = str(uuid.uuid4())
        atomic(_path(), state)
        journal.unlink(missing_ok=True)
    else:
        keys = (
            "cursor",
            "status",
            "phase",
            "activity",
            "current_filename",
            "layout_revision",
            "layout_scope",
            "grouped",
            "unfiled",
            "links_added",
            "progress_details",
        )
        event = {
            "checkpoint": state["checkpoint"],
            "progress": {k: state[k] for k in keys if k in state},
        }
        cursor = state.get("cursor", 0)
        if cursor > previous["cursor"]:
            identity = state["work_ids"][cursor - 1]
            kind = (
                "failures"
                if identity in state["failures"]
                else "skips"
                if identity in state.get("skips", {})
                else "completed"
            )
            event.update(
                identity=identity,
                kind=kind,
                reason=state.get(kind, {}).get(identity) if kind != "completed" else None,
                outcome=state.get("outcomes", {}).get(identity),
            )
        with journal.open("ab") as handle:
            handle.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
            handle.flush()
            os.fsync(handle.fileno())
    _PERSISTED = {
        "request_id": state["request_id"],
        "phase": state.get("phase"),
        "taxonomy_ready": state.get("taxonomy_ready"),
        "cursor": state.get("cursor", 0),
    }
    _STAMP = None
    _SNAPSHOT = None
    _ACTIVE_JOB, _ACTIVE_STAMP = state, _stamp()


def request(folder=None, grouping=True, links=True, retry=False, mode="reset"):
    if mode not in ("reset", "unfiled", "links"):
        raise ValueError("Choose reset, unfiled, or links review")
    if type(grouping) is not bool or type(links) is not bool or type(retry) is not bool:
        raise ValueError("Reset selections must be booleans")
    if folder is not None and not isinstance(folder, str):
        raise ValueError("Folder must be text")
    if not grouping and not links:
        raise ValueError("Select folders & groups, document links, or both")
    if mode == "unfiled":
        folder, grouping, links = "", True, True
    elif mode == "links":
        grouping, links = False, True
    if server.STORAGE_ONLY or not os.getenv("TYPESAFE_API_KEY", "").strip():
        raise ValueError(
            "Jev is unavailable. Set TYPESAFE_API_KEY and enable indexing. Existing organization is intact."
        )
    from app.jev import preflight

    # Availability is checked before a durable reset boundary or manual edit is changed.
    with server.write_lock:
        previous = status()
        if previous and previous["status"] in ("queued", "running"):
            raise ValueError("One organization job is already running")
    preflight()
    with server.write_lock, INDEX_LOCK:
        previous = status()
        if previous and previous["status"] in ("queued", "running"):
            raise ValueError("One organization job is already running")
        if retry:
            if not previous or not previous["failures"]:
                raise ValueError("No failed items to retry")
            ids = list(previous["failures"])
            grouping, links, folder = previous["grouping"], previous["links"], previous["folder"]
            mode = previous.get("mode", "reset")
        else:
            table = _table(server.DATA_DIR, "documents")
            where = "true" if folder is None else folder_condition(folder)
            count = table.count_rows(where) if table is not None else 0
            ids = (
                [
                    r["document_id"]
                    for r in table.search()
                    .where(where)
                    .select(["document_id"])
                    .limit(count)
                    .to_list()
                ]
                if count
                else []
            )
            if mode == "unfiled":
                from app.organization_edits import assignment_ids

                manual = assignment_ids(server.DATA_DIR)
                ids = [identity for identity in ids if identity not in manual]
            if mode != "reset" and not ids:
                raise ValueError("No files eligible for this review. Manual placements are kept.")
        # Exclude the selected old taxonomy from replacement choices, including cache.
        vocabulary = {"folders": [], "groups": []}
        table = _table(server.DATA_DIR, "documents")
        if table is not None:
            selected = set(ids)
            for batch in (
                table.search()
                .select(["document_id", "folder", "groups"])
                .limit(max(1, table.count_rows()))
                .to_batches()
            ):
                for row in batch.to_pylist():
                    if mode != "reset" or row["document_id"] not in selected:
                        if row["folder"]:
                            vocabulary["folders"].append(row["folder"])
                        vocabulary["groups"].extend(row["groups"])
        vocabulary = {k: sorted(set(v)) for k, v in vocabulary.items()}
        if retry:
            vocabulary = previous["vocabulary"]
        state = {
            "request_id": previous["request_id"] if retry else str(uuid.uuid4()),
            "mode": mode,
            "status": "queued",
            "folder": folder,
            "grouping": grouping,
            "links": links,
            "document_ids": previous["document_ids"] if retry else ids,
            "completed_ids": previous["completed_ids"] if retry else [],
            "failures": {},
            "skips": previous.get("skips", {}) if retry else {},
            "outcomes": previous.get("outcomes", {}) if retry else {},
            "total": previous["total"] if retry else len(ids),
            "phase": "rebuilding" if retry or mode != "reset" else "clearing",
            "cleared_ids": previous.get("cleared_ids", []) if retry else [],
            "incoming_cleared": retry,
            "vocabulary": vocabulary,
            "taxonomy_ready": not grouping or retry,
            "common_lines": previous.get("common_lines", []) if retry else [],
            "candidate_folders": previous.get("candidate_folders", {}) if retry else {},
            "layout_revision": previous.get("layout_revision", "") if previous else "",
            "layout_scope": previous.get("layout_scope") if previous else None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "activity": "Preparing review",
            "current_filename": "",
        }
        server.organization_attempts.difference_update(
            e for e in list(server.organization_attempts) if e[0] in set(ids)
        )
        if mode == "reset" and grouping and not retry:
            state["layout_revision"] = state["request_id"]
            state["layout_scope"] = folder
        _persist(state)  # Captured IDs precede the durable clear boundary.
        _clear_boundary(state)
        server.wake.set()
        return state


def _clear_boundary(state):
    """Idempotent roll-forward of the captured scope, including unindexable items."""
    if state.get("phase") != "clearing":
        return
    from app.organization_edits import clear

    selected = set(state["document_ids"])
    with server.write_lock, INDEX_LOCK:
        if state["grouping"]:
            clear(server.DATA_DIR, selected, reset=True)
        cleared = set(state.get("cleared_ids", []))
        since_checkpoint = 0
        for identity in state["document_ids"]:
            if identity in cleared:
                continue
            row = get_document_status(server.DATA_DIR, identity)
            if row:
                decision = {
                    **(json.loads(row["organization_json"]) if not state["grouping"] else {}),
                    "status": "reset_pending" if state["grouping"] else row["organization_status"],
                    "origin": "reset"
                    if state["grouping"]
                    else json.loads(row["organization_json"]).get("origin", "jev"),
                    "folder": "" if state["grouping"] else row["folder"],
                    "groups": [] if state["grouping"] else row["groups"],
                    "links": [] if state["links"] else json.loads(row["links_json"]),
                    "reset_generation": state["request_id"],
                }
                save_organization(server.DATA_DIR, identity, row["version"], decision)
            state.setdefault("cleared_ids", []).append(identity)
            cleared.add(identity)
            since_checkpoint += 1
            # Clear is idempotent: after interruption at most 31 items replay.
            # Keep the captured scope durable before the first mutation, then
            # checkpoint batches instead of serializing the whole job per item.
            if since_checkpoint >= 32:
                _persist(state)
                since_checkpoint = 0
        if state["links"] and not state.get("incoming_cleared"):
            table = _table(server.DATA_DIR, "documents")
            if table:
                for batch in table.search().limit(max(1, table.count_rows())).to_batches():
                    for row in batch.to_pylist():
                        if row["document_id"] in selected:
                            continue
                        old = json.loads(row["links_json"])
                        kept = [link for link in old if link["document_id"] not in selected]
                        if kept != old:
                            save_organization(
                                server.DATA_DIR,
                                row["document_id"],
                                row["version"],
                                {
                                    **json.loads(row["organization_json"]),
                                    "status": row["organization_status"],
                                    "folder": row["folder"],
                                    "groups": row["groups"],
                                    "links": kept,
                                },
                            )
            state["incoming_cleared"] = True
        state["phase"] = "rebuilding"
        _organization_names.cache_clear()
        _persist(state)


def _outcome(state, identity, outcome, reason):
    row = get_document_status(server.DATA_DIR, identity)
    if row and state.get("mode", "reset") == "reset":
        save_organization(
            server.DATA_DIR,
            identity,
            row["version"],
            {
                **json.loads(row["organization_json"]),
                "status": "reset_" + outcome if state["grouping"] else row["organization_status"],
                "folder": row["folder"],
                "groups": row["groups"],
                "links": json.loads(row["links_json"]),
                "reason": reason,
            },
        )
    state.setdefault("progress_details", []).append(
        {
            "document_id": identity,
            "filename": state.get("current_filename") or identity,
            "outcome": outcome,
            "reason": reason,
        }
    )
    state["progress_details"] = state["progress_details"][-30:]
    state.setdefault("skips" if outcome == "skipped" else "failures", {})[identity] = reason
    state["cursor"] = state.get("cursor", 0) + 1
    _persist(state)


class DiskProfiles(MutableMapping):
    """Evidence profiles live in job-local scratch, one document read at a time."""

    def __init__(self, root):
        self.root, self.identities = root, {}

    def __getitem__(self, identity):
        return json.loads(self.identities[identity].read_text())

    def __setitem__(self, identity, value):
        import hashlib

        path = self.root / (hashlib.sha256(identity.encode()).hexdigest() + ".json")
        path.write_text(json.dumps(value))
        self.identities[identity] = path

    def __delitem__(self, identity):
        self.identities.pop(identity).unlink(missing_ok=True)

    def __len__(self):
        return len(self.identities)

    def __iter__(self):
        return iter(self.identities)


def process_one():
    """Return after one item so normal indexing gets an opportunity between calls."""
    from app.jev import organize_document

    with server.write_lock:
        state = _active_state()
        if not state or state["status"] not in ("queued", "running"):
            return False
        _clear_boundary(state)
        if "cursor" not in state:
            done = (
                set(state["completed_ids"]) | set(state["failures"]) | set(state.get("skips", {}))
            )
            state["work_ids"] = [i for i in state["document_ids"] if i not in done]
            state["cursor"] = 0
        remaining = state["work_ids"]
        cursor = state["cursor"]
        if cursor >= len(remaining):
            state["status"] = "partial_failure" if state["failures"] else "completed"
            state["phase"] = "complete"
            state["activity"] = "Complete"
            state["current_filename"] = ""
            if (
                state.get("mode", "reset") == "reset"
                and state["grouping"]
                and state["completed_ids"]
            ):
                state["layout_revision"] = state["request_id"]
            _persist(state)
            return False
        doc_id = remaining[cursor]
        state["status"] = "running"
        current = get_document_status(server.DATA_DIR, doc_id)
        state["current_filename"] = current["filename"] if current else ""
        state["activity"] = (
            "Preparing folders" if not state.get("taxonomy_ready") else "Finding related documents"
        )
        _persist(state, progress_only=True)
    metadata = None
    try:
        if not state.get("taxonomy_ready", False):
            from app.organization import (
                shared_vocabulary,
                embedding_candidates,
                common_lines,
                prose_paths,
            )

            import tempfile

            with tempfile.TemporaryDirectory(prefix="symbiknow-profiles-") as temporary:
                profiles = DiskProfiles(Path(temporary))
                for identity in sorted(state["document_ids"]):
                    row = get_document_status(server.DATA_DIR, identity)
                    if row and row["status"] == "indexed":
                        profiles[identity] = document_evidence(
                            server.DATA_DIR, identity, row["version"]
                        )
                common = common_lines(profiles)
                generated = prose_paths(profiles, common)
                state["vocabulary"], state["common_lines"] = shared_vocabulary(
                    profiles,
                    **state["vocabulary"],
                    common=common,
                    generated=generated,
                )
                state["candidate_folders"] = embedding_candidates(
                    server.DATA_DIR,
                    profiles,
                    state["vocabulary"],
                    common,
                    generated=generated,
                )
            state["taxonomy_ready"] = True
            with server.write_lock:
                _persist(state)
        metadata = storage.read_metadata(server.DATA_DIR, doc_id)
        row = get_document_status(server.DATA_DIR, doc_id)
        if state.get("mode") == "unfiled":
            from app.organization_edits import override

            if row and (row["folder"] or override(server.DATA_DIR, doc_id)):
                with server.write_lock:
                    _outcome(
                        state, doc_id, "skipped", "Already filed or manually placed; kept unchanged"
                    )
                return True
        if (
            row
            and row["version"] == metadata["version"]
            and row["status"] in ("empty", "unsupported", "disabled")
        ):
            reasons = {
                "empty": "No content was extracted",
                "unsupported": "Format is not supported for indexing",
                "disabled": "Indexing is disabled",
            }
            with server.write_lock:
                _outcome(state, doc_id, "skipped", reasons[row["status"]])
            return True
        if not row or row["version"] != metadata["version"] or row["status"] != "indexed":
            raise ValueError("Current version is not searchable yet; retry after indexing")
        evidence = document_evidence(server.DATA_DIR, doc_id, metadata["version"], limit=128)
        from app.organization import representative_evidence

        topic_evidence = representative_evidence(evidence, state.get("common_lines", []))
        if not topic_evidence:
            with server.write_lock:
                _outcome(state, doc_id, "skipped", "No text evidence is available for Jev")
            return True
        state["activity"] = "Finding related documents"
        with server.write_lock:
            _persist(state, progress_only=True)
        neighbors = (
            organization_neighbors(
                server.DATA_DIR,
                metadata,
                topic_evidence,
                state.get("common_lines", []),
                folders=state.get("candidate_folders", {}).get(doc_id, [])
                if state["grouping"]
                else None,
            )
            if state["links"]
            else []
        )
        vocabulary = {
            **state["vocabulary"],
            "folders": state["vocabulary"]["folders"],
        }
        state["activity"] = (
            "Reviewing links"
            if not state["grouping"]
            else "Reviewing folders and links"
            if state["links"]
            else "Reviewing folders"
        )
        with server.write_lock:
            _persist(state, progress_only=True)
        decision = organize_document(
            metadata,
            evidence,
            neighbors,
            **vocabulary,
            projects=project_roster(server.DATA_DIR),
            **({"links_only": True} if not state["grouping"] else {}),
        )
        if decision.get("status") != "evaluated":
            raise ValueError(decision.get("error") or "No text evidence available for Jev")
        with server.write_lock, INDEX_LOCK:
            if storage.current_version(server.DATA_DIR, doc_id) != metadata["version"]:
                server._schedule(doc_id)
                return True  # Retry latest head; do not publish stale source evidence.
            for link in decision.get("links", []) if state["links"] else []:
                if storage.current_version(server.DATA_DIR, link["document_id"]) != link["version"]:
                    return True  # Neighbor changed during provider call: recompute.
            latest = get_document_status(server.DATA_DIR, doc_id)
            if state.get("mode") == "unfiled":
                from app.organization_edits import override

                if latest["folder"] or override(server.DATA_DIR, doc_id):
                    _outcome(
                        state, doc_id, "skipped", "Already filed or manually placed; kept unchanged"
                    )
                    return True
            if state.get("mode") in ("unfiled", "links"):
                # Add verified links without erasing accepted relationships that
                # were outside this pass's bounded neighbor shortlist.
                existing = json.loads(latest["links_json"])
                merged = {}
                for link in [*existing, *decision.get("links", [])]:
                    if link.get("source_version") == metadata[
                        "version"
                    ] and storage.current_version(server.DATA_DIR, link["document_id"]) == link.get(
                        "version"
                    ):
                        key = (link["document_id"], link["version"], link["relation"])
                        merged.setdefault(key, link)
                if state["mode"] == "unfiled":
                    decision["groups"] = list(
                        dict.fromkeys([*latest["groups"], *decision.get("groups", [])])
                    )
                decision["links"] = list(merged.values())
            if not state["grouping"]:
                # Applies to additive review AND an explicit links-only reset.
                # Neither operation changes accepted ownership evidence.
                decision = {
                    **json.loads(latest["organization_json"]),
                    "status": latest["organization_status"],
                    "folder": latest["folder"],
                    "groups": latest["groups"],
                    "links": decision.get("links", []),
                    "link_evaluations": decision.get("link_evaluations", []),
                    "links_review": {
                        "status": "evaluated",
                        "model": decision.get("model"),
                        "prompt_version": decision.get("prompt_version"),
                    },
                }
            if not state["links"]:
                decision["links"] = json.loads(latest["links_json"])
                decision["links"] = [
                    link
                    for link in decision["links"]
                    if storage.current_version(server.DATA_DIR, link["document_id"])
                    == link["version"]
                ]
            save_organization(server.DATA_DIR, doc_id, metadata["version"], decision)
            old_links = {
                (link["document_id"], link["version"], link["relation"])
                for link in json.loads(latest["links_json"])
            }
            state.setdefault("outcomes", {})[doc_id] = {
                "folder": decision.get("folder", ""),
                "outcome": ("grouped" if decision.get("folder") else "unfiled")
                if state["grouping"]
                else "links_reviewed",
                "links_added": sum(
                    (link["document_id"], link["version"], link["relation"]) not in old_links
                    for link in decision.get("links", [])
                ),
                "reason": decision.get("organization_reason")
                or (
                    "No project assignment accepted from the available text evidence"
                    if state["grouping"] and not decision.get("folder")
                    else ""
                ),
            }
            _organization_names.cache_clear()
            outcome = state["outcomes"][doc_id]
            state["grouped"] = state.get("grouped", 0) + (outcome["outcome"] == "grouped")
            state["unfiled"] = state.get("unfiled", 0) + (outcome["outcome"] == "unfiled")
            state["links_added"] = state.get("links_added", 0) + outcome["links_added"]
            if outcome["outcome"] == "unfiled":
                state.setdefault("progress_details", []).append(
                    {
                        "document_id": doc_id,
                        "filename": metadata["filename"],
                        "outcome": "unfiled",
                        "reason": outcome["reason"],
                    }
                )
                state["progress_details"] = state["progress_details"][-30:]
            state["completed_ids"].append(doc_id)
            state["cursor"] += 1
            _persist(state)
    except Exception as exc:
        with server.write_lock:
            if metadata and storage.current_version(server.DATA_DIR, doc_id) != metadata["version"]:
                server._schedule(doc_id)
                return True  # A failure about an old head cannot fail the new head.
            # Errors are local, sanitized; never store provider response bodies.
            _outcome(
                state,
                doc_id,
                "failed",
                str(exc) if isinstance(exc, ValueError) else type(exc).__name__,
            )
    return True
