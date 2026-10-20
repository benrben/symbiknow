"""Durable selective organization requests, processed by the one ingestion worker."""

from __future__ import annotations

import json
import os
import uuid
import copy
import threading
from collections.abc import MutableMapping
from pathlib import Path
from itertools import islice
from datetime import datetime, timezone

from symbiknow.library import storage
from symbiknow.core.application import current_application
from symbiknow.search.index import INDEX_LOCK, _table, document_evidence, organization_neighbors, get_document_status, publish_organization_generation, save_organization, reset_organization, project_roster


def _path(context=None):
    return (context or current_application()).DATA_DIR / "temp" / "organization-rebuild.json"


_SNAPSHOT = None
_STAMP = None
_ACTIVE_JOB = None
_ACTIVE_STAMP = None
_PERSISTED = None
_SNAPSHOT_LOCK = threading.RLock()


def _stamp(context=None):
    files = [_path(context), _path(context).with_suffix(".jsonl")]
    return tuple(
        (str(f), f.stat().st_ino, f.stat().st_mtime_ns, f.stat().st_size)
        if f.exists()
        else (str(f),)
        for f in files
    )


def _state(context=None):
    with _SNAPSHOT_LOCK:
        return _read_state(context)


def _read_state(context=None):
    """Durable snapshot, reloaded/replayed once per external revision."""
    global _SNAPSHOT, _STAMP
    stamp = _stamp(context)
    if stamp != _STAMP:
        path = _path(context)
        value = json.loads(path.read_text()) if path.exists() else None
        journal = path.with_suffix(".jsonl")
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


def _active_state(context=None):
    global _ACTIVE_JOB, _ACTIVE_STAMP, _PERSISTED
    if context is not None and _ACTIVE_STAMP != _stamp(context):
        # A held library service must not replace the current worker's job.
        return copy.deepcopy(_state(context))
    if _ACTIVE_STAMP != _stamp():
        _ACTIVE_JOB = copy.deepcopy(_state())
        _ACTIVE_STAMP = _stamp()
        _PERSISTED = None
    return _ACTIVE_JOB


def owns(identity, context=None):
    with (context or current_application()).write_lock:
        state = _active_state(context)
        if not state or state["status"] not in {"queued", "running"}:
            return False
        global _OWNED
        identity_key = (str(_path(context)), state["request_id"])
        if _OWNED[0] != identity_key:
            owned = frozenset(state["document_ids"])
            _OWNED = (identity_key, owned)
        else:
            owned = _OWNED[1]
        return identity in owned


_OWNED = (None, frozenset())


def common_context(context=None):
    with (context or current_application()).write_lock:
        return list((_active_state(context) or {}).get("common_lines", []))


def status(context=None):
    with (context or current_application()).write_lock:
        value = copy.deepcopy(_state(context))
        active, active_stamp = _ACTIVE_JOB, _ACTIVE_STAMP
        # Live activity is a compact overlay; durable completion remains checkpointed.
        if (
            value
            and active
            and active_stamp == _stamp(context)
            and active["request_id"] == value["request_id"]
        ):
            for key in ("activity", "current_filename"):
                if key in active:
                    value[key] = active[key]
        return value


def progress(context=None):
    with (context or current_application()).write_lock:
        state = _active_state(context)
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
    from symbiknow.organization.edits import atomic

    if progress_only:
        _ACTIVE_JOB = state
        return
    previous = _PERSISTED
    full = (
        previous is None
        or previous["request_id"] != state["request_id"]
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
            "publication_attempts",
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
    if current_application().STORAGE_ONLY or not os.getenv("TYPESAFE_API_KEY", "").strip():
        raise ValueError(
            "Jev is unavailable. Set TYPESAFE_API_KEY and enable indexing. Existing organization is intact."
        )
    from symbiknow.ai.jev import preflight

    # Availability is checked before a durable reset boundary or manual edit is changed.
    with current_application().write_lock:
        previous = status()
        if previous and previous["status"] in ("queued", "running"):
            raise ValueError("One organization job is already running")
    preflight()
    with current_application().write_lock, INDEX_LOCK:
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
            table = _table(current_application().DATA_DIR, "documents")
            from symbiknow.organization.store import scope_condition
            where = "true" if folder is None else scope_condition(current_application().DATA_DIR, folder)
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
                from symbiknow.organization.edits import assignment_ids

                manual = assignment_ids(current_application().DATA_DIR)
                ids = [identity for identity in ids if identity not in manual]
            if mode != "reset" and not ids:
                raise ValueError("No files eligible for this review. Manual placements are kept.")
        # Exclude the selected old taxonomy from replacement choices, including cache.
        vocabulary = {"folders": [], "groups": []}
        table = _table(current_application().DATA_DIR, "documents")
        if table is not None:
            selected = set(ids)
            for batch in (
                table.search()
                .select(["document_id", "version", "evidence_revision", "folder", "groups", "links_json", "organization_status", "organization_json"])
                .limit(max(1, table.count_rows()))
                .to_batches()
            ):
                from symbiknow.organization.store import overlay
                for row in overlay(current_application().DATA_DIR, batch.to_pylist()):
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
            "phase": "clearing" if mode == "reset" and not retry else "preparing",
            "reset_progressive": mode == "reset",
            "reset_assignments": previous.get("reset_assignments", {}) if retry else {},
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
        current_application().organization_attempts.difference_update(
            e for e in list(current_application().organization_attempts) if e[0] in set(ids)
        )
        if mode == "reset" and not retry and grouping:
            from symbiknow.organization.edits import overrides
            state["reset_assignments"] = overrides(current_application().DATA_DIR, ids)
        if retry:
            state["reset_started"] = previous.get("reset_started", True)
        _persist(state)  # Captured IDs precede the durable clear boundary.
        if previous and previous["request_id"] != state["request_id"]:
            # A fresh request explicitly supersedes retryable paid receipts from
            # the prior terminal job; only Retry retains those dependencies.
            from symbiknow.organization.store import cleanup_staging
            cleanup_staging(current_application().DATA_DIR, previous["request_id"])
    try:
        if mode == "reset" and not state.get("reset_started"):
            state = _start_reset(state)
    finally:
        current_application().wake.set()
    return state


def _start_reset(state):
    """A durable clear is visible before taxonomy scanning or provider work."""
    with current_application().snapshots.read():
        latest = _active_state()
        if latest and (latest["request_id"] != state["request_id"] or latest.get("reset_started")):
            return latest
        if not state.get("reset_progressive"):
            # A queued schema-1 job's completed IDs represented unpublished
            # preparation, not reviewed visible files. Restart that reset's work
            # through the same progressive path under the new explicit policy.
            from symbiknow.organization.store import cleanup_staging
            # Older jobs did not capture assignment revisions. Treat inherited
            # assignments as later edits, rather than guessing which may be erased.
            state.update(reset_progressive=True, reset_assignments={},
                         completed_ids=[], failures={}, skips={}, outcomes={}, cursor=0,
                         work_ids=list(state["document_ids"]), taxonomy_ready=not state["grouping"],
                         common_lines=[], candidate_folders={}, phase="clearing")
            _persist(state)
            cleanup_staging(current_application().DATA_DIR, state["request_id"])
        reset_organization(current_application().DATA_DIR, state["document_ids"],
                           grouping=state["grouping"], links=state["links"],
                           assignments=state.get("reset_assignments", {}), request_id=state["request_id"])
        state["reset_started"] = True
        state["phase"] = "preparing"
        state["activity"] = "Preparing folders" if state["grouping"] else "Reviewing links"
        if state["grouping"]:
            state["layout_revision"] = state["request_id"]
            state["layout_scope"] = state.get("folder")
        _persist(state)
        return state



def _outcome(state, identity, outcome, reason):
    if state.get("mode", "reset") == "reset" and state["grouping"] and outcome == "skipped":
        row = get_document_status(current_application().DATA_DIR, identity)
        if row:
            try:
                save_organization(current_application().DATA_DIR, identity, row["version"], {
                    "status": "reset_skipped", "folder": "", "groups": [],
                    "links": json.loads(row["links_json"]), "reason": reason,
                    "evidence_revision": row.get("evidence_revision", ""),
                    "dependency_evidence_revisions": json.loads(row.get("evidence_dependencies_json", "{}")),
                })
            except ValueError:
                current_application().schedule(identity)
                return  # A current source/evidence race is retried, not skipped.
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


def _complete_generation(state):
    """Finalize staged review, or validate already published progressive items."""
    from symbiknow.search.index import IndexChangedError
    invalidated = {}
    if state.get("mode", "reset") == "reset":
        from symbiknow.search.index import document_statuses, validate_prepared_organization
        from symbiknow.organization.store import staged_document
        with current_application().snapshots.read() as snapshot:
            identities = list(state["completed_ids"])
            for offset in range(0, len(identities), 800):
                batch = identities[offset:offset + 800]
                heads = snapshot.heads_many(batch)
                rows = document_statuses(current_application().DATA_DIR, batch)
                for identity in batch:
                    outcome = state.get("outcomes", {}).get(identity, {})
                    row = rows.get(identity, {})
                    if (heads.get(identity) != outcome.get("source_version")
                            or row.get("evidence_revision") != outcome.get("evidence_revision")
                            or row.get("organization_status") != outcome.get("organization_status")):
                        invalidated[identity] = "Source or supporting evidence changed after review; retry current version"
                    else:
                        prepared = staged_document(current_application().DATA_DIR, state["request_id"], identity)
                        if prepared:
                            try:
                                validate_prepared_organization(current_application().DATA_DIR, prepared)
                            except ValueError as exc:
                                invalidated[identity] = str(exc)
            for identity, reason in invalidated.items():
                row = get_document_status(current_application().DATA_DIR, identity)
                if row:
                    try:
                        save_organization(current_application().DATA_DIR, identity, row["version"], {
                            "status": "reset_failed" if state["grouping"] else row["organization_status"],
                            "folder": "New" if state["grouping"] else row["folder"],
                            "groups": [] if state["grouping"] else row["groups"],
                            "links": [] if state["links"] else json.loads(row["links_json"]),
                            "evidence_revision": row.get("evidence_revision", ""), "reason": reason,
                        })
                    except ValueError:
                        # A superseded index row cannot authorize any new
                        # organization. Normal source invalidation owns it.
                        current_application().schedule(identity)
    try:
        if state.get("mode", "reset") != "reset":
            publish_organization_generation(current_application().DATA_DIR, state["request_id"], invalidated=invalidated)
    except IndexChangedError:
        with current_application().write_lock:
            state["publication_attempts"] = state.get("publication_attempts", 0) + 1
            if state["publication_attempts"] < 3:
                state["activity"] = "Source changed; preparing publication again"
                _persist(state)
                return True
            invalidated.update({identity: "Library changed repeatedly during organization publication; retry review"
                                for identity in state["completed_ids"]})
    with current_application().write_lock:
        for identity, reason in invalidated.items():
            if identity in state["completed_ids"]:
                state["completed_ids"].remove(identity)
            state["failures"][identity] = reason
            state.setdefault("outcomes", {}).pop(identity, None)
        outcomes = state.get("outcomes", {}).values()
        state["grouped"] = sum(item["outcome"] == "grouped" for item in outcomes)
        state["unfiled"] = sum(item["outcome"] == "unfiled" for item in state.get("outcomes", {}).values())
        state["links_added"] = sum(item.get("links_added", 0) for item in state.get("outcomes", {}).values())
        state["status"] = "partial_failure" if state["failures"] else "completed"
        state["phase"] = "complete"
        state["activity"] = "Complete"
        state["current_filename"] = ""
        if state.get("mode", "reset") == "reset" and state["grouping"] and state["completed_ids"]:
            state["layout_revision"] = state["request_id"]
            state["layout_scope"] = state.get("folder")
        _persist(state)
    from symbiknow.organization.store import cleanup_staging
    if state.get("mode", "reset") != "reset" or not state["failures"]:
        cleanup_staging(current_application().DATA_DIR, state["request_id"])
    else:
        from symbiknow.organization.store import discard_staged_document
        for identity in state["completed_ids"]:
            discard_staged_document(current_application().DATA_DIR, state["request_id"], identity)
    return False


def process_one():
    """Return after one item so normal indexing gets an opportunity between calls."""
    from symbiknow.ai.jev import organize_document

    with current_application().write_lock:
        pending = _active_state()
        needs_clear = (pending and pending["status"] in {"queued", "running"}
                       and pending.get("mode", "reset") == "reset" and not pending.get("reset_started"))
    if needs_clear:
        _start_reset(pending)
        return True

    with current_application().write_lock:
        state = _active_state()
        if not state or state["status"] not in ("queued", "running"):
            return False
        if "cursor" not in state:
            done = (
                set(state["completed_ids"]) | set(state["failures"]) | set(state.get("skips", {}))
            )
            state["work_ids"] = [i for i in state["document_ids"] if i not in done]
            state["cursor"] = 0
        remaining = state["work_ids"]
        cursor = state["cursor"]
        finished = cursor >= len(remaining)
        if finished:
            state["phase"] = "finishing" if state.get("mode", "reset") == "reset" else "publishing"
            state["status"] = "running"
            _persist(state)
        else:
            doc_id = remaining[cursor]
            state["status"] = "running"
            current = get_document_status(current_application().DATA_DIR, doc_id)
            state["current_filename"] = current["filename"] if current else ""
            state["activity"] = (
                "Preparing folders" if not state.get("taxonomy_ready") else "Finding related documents"
            )
            _persist(state, progress_only=True)
    if finished:
        return _complete_generation(state)
    metadata = None
    try:
        if not state.get("taxonomy_ready", False):
            from symbiknow.organization.policy import shared_vocabulary, embedding_candidates, common_lines, prose_paths

            import tempfile

            with tempfile.TemporaryDirectory(prefix="symbiknow-profiles-") as temporary:
                profiles = DiskProfiles(Path(temporary))
                for identity in sorted(state["document_ids"]):
                    row = get_document_status(current_application().DATA_DIR, identity)
                    if row and row["status"] == "indexed":
                        profiles[identity] = document_evidence(
                            current_application().DATA_DIR, identity, row["version"]
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
                    current_application().DATA_DIR,
                    profiles,
                    state["vocabulary"],
                    common,
                    generated=generated,
                )
            state["taxonomy_ready"] = True
            with current_application().write_lock:
                _persist(state)
        with current_application().write_lock:
            state["phase"] = "reviewing"
            _persist(state)
        metadata = storage.read_metadata(current_application().DATA_DIR, doc_id)
        row = get_document_status(current_application().DATA_DIR, doc_id)
        if state.get("mode") == "unfiled":
            from symbiknow.organization.edits import override

            if row and (row["folder"] or override(current_application().DATA_DIR, doc_id)):
                with current_application().write_lock:
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
            with current_application().write_lock:
                _outcome(state, doc_id, "skipped", reasons[row["status"]])
            return True
        if not row or row["version"] != metadata["version"] or row["status"] != "indexed":
            raise ValueError("Current version is not searchable yet; retry after indexing")
        evidence = document_evidence(current_application().DATA_DIR, doc_id, metadata["version"], limit=128)
        from symbiknow.organization.policy import representative_evidence

        topic_evidence = representative_evidence(evidence, state.get("common_lines", []))
        if not topic_evidence:
            with current_application().write_lock:
                _outcome(state, doc_id, "skipped", "No text evidence is available for Jev")
            return True
        state["activity"] = "Finding related documents"
        with current_application().write_lock:
            _persist(state, progress_only=True)
        neighbors = (
            organization_neighbors(
                current_application().DATA_DIR,
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
        # Preserve the exact stored passages before provider latency; neighbor
        # ranking may use cleaned excerpts but freshness compares original text.
        from symbiknow.search.index import resolve_evidence_many
        references = [(neighbor["document_id"], neighbor["version"], passage["evidence_id"])
                      for neighbor in neighbors for passage in neighbor.get("evidence", [])]
        originals = resolve_evidence_many(current_application().DATA_DIR, references)
        neighbor_dependencies = [
            {**neighbor, "evidence": [originals[(neighbor["document_id"], neighbor["version"], passage["evidence_id"])]
                                      for passage in neighbor.get("evidence", [])
                                      if (neighbor["document_id"], neighbor["version"], passage["evidence_id"]) in originals]}
            for neighbor in neighbors
        ]
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
        with current_application().write_lock:
            _persist(state, progress_only=True)
        from symbiknow.organization.store import staged_document, discard_staged_document
        prepared = (staged_document(current_application().DATA_DIR, state["request_id"], doc_id)
                    if state.get("mode", "reset") == "reset" else None)
        if prepared and (prepared["version"] != metadata["version"]
                         or prepared["decision"].get("evidence_revision") != row.get("evidence_revision", "")):
            discard_staged_document(current_application().DATA_DIR, state["request_id"], doc_id)
            prepared = None
        if prepared:
            decision = copy.deepcopy(prepared["decision"])
        else:
            decision = organize_document(
                metadata, evidence, neighbors, **vocabulary,
                projects=project_roster(current_application().DATA_DIR),
                cache_namespace=str(current_application().DATA_DIR.resolve()),
                **({"links_only": True} if not state["grouping"] else {}),
            )
            decision["evidence_revision"] = row.get("evidence_revision", "")
            decision["dependency_evidence_revisions"] = {
                neighbor["document_id"]: neighbor.get("evidence_revision", "") for neighbor in neighbors
            }
        if decision.get("status") != "evaluated":
            raise ValueError(decision.get("error") or "No text evidence available for Jev")
        with current_application().write_lock, INDEX_LOCK:
            if storage.current_version(current_application().DATA_DIR, doc_id) != metadata["version"]:
                current_application().schedule(doc_id)
                return True  # Retry latest head; do not publish stale source evidence.
            for link in decision.get("links", []) if state["links"] else []:
                if storage.current_version(current_application().DATA_DIR, link["document_id"]) != link["version"]:
                    if prepared:
                        discard_staged_document(current_application().DATA_DIR, state["request_id"], doc_id)
                    return True  # Neighbor changed during provider call: recompute.
            latest = get_document_status(current_application().DATA_DIR, doc_id)
            if state.get("mode") == "unfiled":
                from symbiknow.organization.edits import override

                if latest["folder"] or override(current_application().DATA_DIR, doc_id):
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
                    ] and storage.current_version(current_application().DATA_DIR, link["document_id"]) == link.get(
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
                    "evidence_revision": decision["evidence_revision"],
                    "dependency_evidence_revisions": {
                        **json.loads(latest.get("evidence_dependencies_json", "{}")),
                        **decision.get("dependency_evidence_revisions", {}),
                    },
                }
            if not state["links"]:
                decision["links"] = json.loads(latest["links_json"])
                decision["links"] = [
                    link
                    for link in decision["links"]
                    if storage.current_version(current_application().DATA_DIR, link["document_id"])
                    == link["version"]
                ]
                prior_dependencies = json.loads(latest.get("evidence_dependencies_json", "{}"))
                decision["dependency_evidence_revisions"].update({
                    link["document_id"]: prior_dependencies[link["document_id"]]
                    for link in decision["links"] if link["document_id"] in prior_dependencies})
            old_links = {
                (link["document_id"], link["version"], link["relation"])
                for link in json.loads(latest["links_json"])
            }
            outcome = {
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
                "source_version": metadata["version"],
                "evidence_revision": decision.get("evidence_revision", ""),
            }
            from symbiknow.organization.store import stage
            if prepared and prepared.get("outcome"):
                outcome = prepared["outcome"]
            if not prepared:
                stage(current_application().DATA_DIR, state["request_id"], doc_id, metadata["version"], decision,
                      evidence=evidence, neighbors=neighbor_dependencies, outcome=outcome)
            if state.get("mode", "reset") == "reset":
                try:
                    receipt = staged_document(current_application().DATA_DIR, state["request_id"], doc_id)
                    published = save_organization(current_application().DATA_DIR, doc_id, metadata["version"], decision,
                                                  prepared=receipt)
                except ValueError:
                    if prepared:
                        # A recovered paid decision has stale dependencies. Drop
                        # only that receipt and review the current evidence next.
                        discard_staged_document(current_application().DATA_DIR, state["request_id"], doc_id)
                        return True
                    raise
                outcome["folder"] = published["folder"]
                outcome["organization_status"] = published["organization_status"]
                if state["grouping"]:
                    outcome["outcome"] = "grouped" if published["folder"] else "unfiled"
            state.setdefault("outcomes", {})[doc_id] = outcome
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
        with current_application().write_lock:
            if metadata and storage.current_version(current_application().DATA_DIR, doc_id) != metadata["version"]:
                current_application().schedule(doc_id)
                return True  # A failure about an old head cannot fail the new head.
            # Errors are local, sanitized; never store provider response bodies.
            _outcome(
                state,
                doc_id,
                "failed",
                str(exc) if isinstance(exc, ValueError) else type(exc).__name__,
            )
    return True
