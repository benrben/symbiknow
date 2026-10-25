"""Evidence-pinned corrections, with durable history independent of AI rebuilds.

Corrections never rewrite originals or manual placement. A replacement applies
only to the inspected source/evidence generation; fresh evidence can be reviewed
again. Retractions mask the rejected relation for that same generation even if a
later automatic run chooses a different chunk from it.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid


POLICY = "organization-corrections-v1"


def _path(root):
    return Path(root) / "temp" / "organization-corrections.sqlite3"


@contextmanager
def _db(root):
    path = _path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY, document TEXT NOT NULL, payload TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS correction_document ON corrections(document)")
        with db:
            yield db
    finally:
        db.close()


def revision(root):
    if not _path(root).exists():
        return ""
    with _db(root) as db:
        row = db.execute("SELECT id FROM corrections ORDER BY rowid DESC LIMIT 1").fetchone()
        return row[0] if row else ""


def assignment_ids(root):
    if not _path(root).exists():
        return frozenset()
    with _db(root) as db:
        return frozenset(r[0] for r in db.execute("SELECT DISTINCT document FROM corrections"))


def purge_document(root, identity):
    if not _path(root).exists():
        return
    with _db(root) as db:
        db.execute("PRAGMA secure_delete=ON")
        # History contains exact passages: a source deletion removes both its
        # own records and cross-document records containing its evidence.
        for key, payload in db.execute("SELECT id,payload FROM corrections").fetchall():
            if identity in payload:
                db.execute("DELETE FROM corrections WHERE id=?", (key,))
    with _db(root) as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


# A full reset retires these correction kinds for the documents it resets.
RESET_ACTIONS = {"grouping": ("correct-folder", "replace-topics"),
                 "links": ("retract-link", "supersede-link", "supplement-link")}


def reset(root, identities, *, grouping, links, request_id):
    """Retire earlier corrections for a reset; history stays and later ones apply.

    One marker per corrected document names the retired kinds. The overlay
    ignores records of those kinds that precede it, so corrections made after
    the reset begins remain authoritative. Replays are idempotent.
    """
    retired = [action for scope, on in (("grouping", grouping), ("links", links)) if on
               for action in RESET_ACTIONS[scope]]
    if not retired or not _path(root).exists():
        return []
    selected = set(identities)
    with _db(root) as db:
        corrected = sorted({r[0] for r in db.execute("SELECT DISTINCT document FROM corrections")} & selected)
        timestamp = datetime.now(timezone.utc).isoformat()
        for identity in corrected:
            marker = f"reset:{request_id}:{identity}"
            db.execute("INSERT OR IGNORE INTO corrections VALUES(?,?,?)", (marker, identity, json.dumps(dict(
                id=marker, document_id=identity, action="reset-corrections", retires=retired,
                request_id=request_id, actor="organization-reset", policy=POLICY, timestamp=timestamp,
                reason="Full organization reset; earlier corrections are kept as history only"))))
    if corrected:
        from symbiknow.organization import readmodel
        readmodel.refresh(root, corrected)
    return corrected


def records(root, identities):
    if not _path(root).exists():
        return {}
    result = {}
    identities = list(dict.fromkeys(identities))
    with _db(root) as db:
        for offset in range(0, len(identities), 256):
            batch = identities[offset:offset + 256]
            query = "SELECT document,payload FROM corrections WHERE document IN (" + ",".join("?" for _ in batch) + ") ORDER BY rowid"
            for identity, payload in db.execute(query, batch):
                result.setdefault(identity, []).append(json.loads(payload))
    return result


def _key(link):
    return link.get("document_id"), link.get("version"), link.get("relation")


def _protected(link):
    return bool(link.get("reviewed_by") or link.get("decision_id") or link.get("manual"))


def _targets(root, identities):
    """Raw metadata only: avoid recursive organization overlays."""
    from symbiknow.search.index import _table, _literal
    from symbiknow.library.storage import heads_many
    table = _table(root, "documents")
    result = {}
    identities = list(set(identities))
    if table is None:
        return result
    for offset in range(0, len(identities), 256):
        batch = identities[offset:offset + 256]
        heads = heads_many(root, batch)
        condition = "document_id IN (" + ",".join(_literal(i) for i in batch) + ")"
        for row in table.search().where(condition).select([
                "document_id", "version", "evidence_revision", "status", "indexed_version"]).limit(len(batch)).to_list():
            if row["version"] == heads.get(row["document_id"]):
                result[row["document_id"]] = row
    return result


def overlay(root, rows, columns=None):
    fields = set(columns) if columns is not None else {"folder", "groups", "links_json", "organization_json"}
    saved = records(root, (r["document_id"] for r in rows))
    if not saved:
        return rows
    targets = _targets(root, [r["target"]["document_id"] for values in saved.values() for r in values if r.get("target")])
    result = []
    for original in rows:
        row = dict(original)
        applied = []
        for record in saved.get(row["document_id"], []):
            if record["action"] == "reset-corrections":
                retired = set(record["retires"])
                for field, actions in (("folder", {"correct-folder"}), ("groups", {"replace-topics"}),
                                       ("links_json", set(RESET_ACTIONS["links"]))):
                    if field in fields and field in original and actions & retired:
                        row[field] = original[field]
                applied = [(identity, action) for identity, action in applied if action not in retired]
                continue
            if (record["version"] != row["version"] or record["evidence_revision"] != row.get("evidence_revision", "")):
                continue
            target = record.get("target")
            if target:
                current = targets.get(target["document_id"], {})
                if (current.get("version") != target["version"] or
                        current.get("evidence_revision") != target["evidence_revision"]):
                    continue
            action = record["action"]
            if action == "replace-topics" and "groups" in fields:
                row["groups"] = record["value"]
            elif action == "correct-folder" and "folder" in fields:
                row["folder"] = record["value"]
            elif action in {"retract-link", "supersede-link", "supplement-link"} and "links_json" in fields:
                links = json.loads(row.get("links_json", "[]"))
                key = tuple(record["key"])
                # A subsequent explicit user decision wins over an older correction.
                if any(_key(link) == key and _protected(link) and link.get("correction_id") != record["id"]
                       and not (action == "supplement-link" and link == record["previous"]) for link in links):
                    continue
                links = [link for link in links if _key(link) != key]
                if record.get("value"):
                    value = record["value"]
                    links = [link for link in links if _key(link) != _key(value) or _protected(link)]
                    if not any(_key(link) == _key(value) for link in links):
                        links.append(value)
                row["links_json"] = json.dumps(links)
            applied.append((record["id"], action))
        if "organization_json" in fields and applied:
            decision = json.loads(row.get("organization_json", "{}"))
            decision.update(correction_ids=[identity for identity, _ in applied])
            for field, key in (("folder", "folder"), ("groups", "groups"), ("links_json", "links")):
                if field in row:
                    decision[key] = json.loads(row[field]) if field == "links_json" else row[field]
            row["organization_json"] = json.dumps(decision)
        result.append(row)
    return result


def apply(context, args):
    """One guarded, idempotent correction. The caller supplies the inspected state."""
    from symbiknow.organization import edits, readmodel
    from symbiknow.search import index
    from symbiknow.library import storage
    root = context.DATA_DIR
    identity = args["document_id"]
    action = args["action"]
    if action not in {"replace-topics", "correct-folder", "retract-link", "supersede-link", "supplement-link"}:
        raise ValueError("Unknown correction action")
    reason = args.get("reason", "").strip()
    if not reason or len(reason) > 4000:
        raise ValueError("A correction needs a concise evidence-based reason")
    request_id = args.get("request_id") or str(uuid.uuid4())
    digest = hashlib.sha256(json.dumps(args, sort_keys=True).encode()).hexdigest()
    with context.snapshots.read():
        with _db(root) as db:
            old = db.execute("SELECT payload FROM corrections WHERE id=?", (request_id,)).fetchone()
        if old:
            record = json.loads(old[0])
            if record["request_digest"] != digest:
                raise ValueError("Correction request ID was already used for different changes")
            return record
        row = index.get_document_status(root, identity)
        if (not row or storage.current_version(root, identity) != args["expected_version"] or
                row["version"] != args["expected_version"] or row.get("evidence_revision", "") != args["expected_evidence_revision"]):
            raise ValueError("Source or evidence changed; inspect again before correcting")
        manual = edits.override(root, identity)
        if (manual or {}).get("revision") != args["expected_manual_revision"]:
            raise ValueError("Manual placement changed; inspect again before correcting")
        previous_records = records(root, [identity]).get(identity, [])
        current_revision = previous_records[-1]["id"] if previous_records else None
        if current_revision != args["expected_correction_revision"]:
            raise ValueError("Corrections changed; inspect again before correcting")
        record = dict(id=request_id, request_digest=digest, document_id=identity,
                      version=row["version"], evidence_revision=row.get("evidence_revision", ""),
                      manual_revision=args["expected_manual_revision"], action=action,
                      reason=reason, actor=args.get("actor", "user"), policy=POLICY,
                      timestamp=datetime.now(timezone.utc).isoformat(), evidence=args.get("evidence", []))
        if action == "replace-topics":
            topics = args["value"]
            if not isinstance(topics, list) or len(topics) > 30 or any(not isinstance(t, str) or not t.strip() or len(t) > 100 or "/" in t for t in topics):
                raise ValueError("Use a list of topic names, not folder paths")
            record.update(previous=row["groups"], value=list(dict.fromkeys(topics)))
        elif action == "correct-folder":
            if manual:
                raise ValueError("Manual placement is protected; use an explicit folder move")
            record.update(previous=row["folder"], value=edits.normalize(args["value"], allow_empty=True))
        else:
            expected = args.get("previous")
            links = json.loads(row.get("links_json", "[]"))
            key = _key(expected or args.get("value", {}))
            matches = [link for link in links if _key(link) == key]
            if matches != ([expected] if expected else []):
                raise ValueError("Active relationship changed; inspect again before correcting")
            if any(_protected(link) for link in matches) and action != "supplement-link":
                raise ValueError("User-reviewed relationships are protected")
            target = index.get_document_status(root, key[0])
            if (not target or target["version"] != key[1] or
                    storage.current_version(root, key[0]) != key[1] or
                    target.get("evidence_revision", "") != args["expected_target_evidence_revision"]):
                raise ValueError("Target evidence changed; inspect again before correcting")
            record.update(key=list(key), previous=expected, target={"document_id": key[0], "version": key[1],
                                                           "evidence_revision": target.get("evidence_revision", "")})
            if expected:
                old_refs = [(identity, row["version"], expected.get("source_chunk_id")),
                            (key[0], key[1], expected.get("target_chunk_id"))]
                old_evidence = index.resolve_evidence_many(root, old_refs)
                record["previous_evidence"] = [old_evidence[ref] for ref in old_refs if ref in old_evidence]
            if action == "retract-link":
                if not expected:
                    raise ValueError("Retraction needs an existing automatic relationship")
                record["value"] = None
            else:
                value = dict(args["value"])
                if value["document_id"] != key[0] or value["version"] != key[1] or value["source_version"] != row["version"]:
                    raise ValueError("Replacement must use the inspected endpoints")
                if value.get("relation") not in {"related", "supports", "contradicts", "duplicate"}:
                    raise ValueError("Unknown relationship")
                # Verify anchors and exact submitted spans against current evidence.
                refs = [(identity, row["version"], value["source_chunk_id"]),
                        (key[0], key[1], value["target_chunk_id"])]
                from symbiknow.ai.link_evidence import proof_references
                refs += proof_references(value)
                resolved = index.resolve_evidence_many(root, refs)
                if any(ref[0] not in {identity, key[0]} for ref in refs):
                    raise ValueError("A targeted correction must retain context from its inspected endpoints")
                from symbiknow.ai.link_evidence import validate_link_proof
                try:
                    validate_link_proof(value, identity, resolved, metadata=storage.metadata_many(root, [identity, key[0]]))
                except ValueError as exc:
                    raise ValueError("Replacement needs exact current source and target claim spans: " + str(exc)) from exc
                if target.get("status") != "indexed" or target.get("indexed_version") != key[1]:
                    raise ValueError("Target needs current indexed evidence")
                value.update(correction_id=request_id)
                if action == "supplement-link":
                    if not expected or _key(value) != _key(expected) or value["relation"] != "related":
                        raise ValueError("Supplement only adds evidence to an unchanged related link")
                    # Retain the user's exact relation and original anchors.
                    # Additional evidence is independently validated, not a
                    # replacement of the accepted decision or its provenance.
                    value = dict(expected, correction_id=request_id, additional_evidence=[
                        *expected.get("additional_evidence", []), value])
                record["value"] = value
        with _db(root) as db:
            db.execute("INSERT INTO corrections VALUES(?,?,?)", (request_id, identity, json.dumps(record)))
        readmodel.refresh(root, [identity])
        return record


def inspect(context, identity):
    from symbiknow.organization import edits, projects
    from symbiknow.search import index
    with context.snapshots.read():
        row = index.get_document_status(context.DATA_DIR, identity)
        if not row:
            raise FileNotFoundError(identity)
        history = records(context.DATA_DIR, [identity]).get(identity, [])
        return dict(document=row, manual=edits.override(context.DATA_DIR, identity), history=history,
                    ownership=projects.ownership_overrides(context.DATA_DIR, [identity]).get(identity),
                    ownership_history=projects.history(context.DATA_DIR, identity),
                    correction_revision=history[-1]["id"] if history else None)


class CorrectionService:
    def __init__(self, context):
        self.context = context

    def inspect(self, identity):
        return inspect(self.context, identity)

    def apply(self, args):
        return apply(self.context, args)

    def correct_ownership(self, args):
        from symbiknow.organization.projects import correct_ownership
        with self.context.snapshots.read():
            return correct_ownership(self.context.DATA_DIR, **args)
