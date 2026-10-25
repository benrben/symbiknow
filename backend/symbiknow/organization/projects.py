"""Evidence-backed project identities and explicit ownership corrections.

Folder assignments never enter this ledger. A single SQLite commit preserves the
registry, effective owner and correction history; automatic suggestions live in
the separate organization publication and remain inspectable.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import uuid


def _path(root):
    return Path(root) / "temp" / "project-identities.sqlite3"


@contextmanager
def _database(root):
    file = _path(root)
    file.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(file, timeout=15)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS ownership(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS history(revision TEXT PRIMARY KEY,payload TEXT NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS ownership_history_document ON history(json_extract(payload,'$.document_id'))")
        db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        with db:
            yield db
    finally:
        db.close()


def revision(root):
    if not _path(root).exists():
        return ""
    with _database(root) as db:
        row = db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
    if not row:
        return ""
    from symbiknow.library.storage import source_revision
    from symbiknow.search.index import _table
    documents = _table(root, "documents")
    return ":".join([row[0], str(source_revision(root)), str(documents.version if documents is not None else "")])


def project_registry(root):
    if not _path(root).exists():
        return []
    with _database(root) as db:
        records = [json.loads(row[0]) for row in db.execute("SELECT payload FROM projects ORDER BY id")]
    # Manual effective ownership survives updates; aliases used to infer new
    # owners need inspected evidence that is still current. Only passages from
    # unchanged sources count, and the identity stays while any remains: one
    # appended log must not erase a project proven by a dozen other documents.
    from symbiknow.library.storage import heads_many
    from symbiknow.search.index import _table, _literal
    identities = sorted({e["document_id"] for p in records for e in p.get("identity_evidence", [])})
    documents = _table(root, "documents")
    current = {}
    if documents is not None:
        for offset in range(0, len(identities), 256):
            batch = identities[offset:offset + 256]
            heads = heads_many(root, batch)
            condition = "document_id IN (" + ",".join(_literal(identity) for identity in batch) + ")"
            current.update({r["document_id"]: (r["version"], r["evidence_revision"])
                            for r in documents.search().where(condition)
                            .select(["document_id", "version", "indexed_version", "evidence_revision", "status"])
                            .limit(len(batch)).to_list()
                            if r["status"] == "indexed" and r["version"] == r["indexed_version"] == heads.get(r["document_id"])})
    result = []
    for project in records:
        evidence = [e for e in project.get("identity_evidence", [])
                    if current.get(e["document_id"]) == (e["version"], e["evidence_revision"])]
        if evidence:
            result.append({**project, "identity_evidence": evidence})
    return result


def catalog_projects(root, automatic):
    """A registered family supersedes old automatically invented identities.

    Even an invalidated registry record masks its old published aliases: stale
    evidence must not reappear through a historical catalog snapshot.
    """
    if not _path(root).exists():
        return list(automatic)
    with _database(root) as db:
        registered = [json.loads(r[0]) for r in db.execute("SELECT payload FROM projects")]
    ids = {p["id"] for p in registered}
    names = {n.casefold() for p in registered for n in [p["name"], *p.get("aliases", []), *p.get("features", [])]}
    records = {p["id"]: p for p in automatic if p["id"] not in ids and p["name"].casefold() not in names}
    records.update({p["id"]: p for p in project_registry(root)})
    return list(records.values())


def ownership_overrides(root, identities):
    if not _path(root).exists():
        return {}
    from itertools import islice
    result = {}
    iterator = iter(dict.fromkeys(identities))
    with _database(root) as db:
        while batch := list(islice(iterator, 256)):
            result.update((row[0], json.loads(row[1])) for row in db.execute(
                "SELECT id,payload FROM ownership WHERE id IN (" + ",".join("?" for _ in batch) + ")", batch))
    return result


def history(root, document_id):
    if not _path(root).exists():
        return []
    with _database(root) as db:
        return [record for row in db.execute("SELECT payload FROM history ORDER BY rowid")
                if (record := json.loads(row[0])).get("document_id") == document_id]


def purge_document(root, document_id):
    """Erase retained passages on source deletion, including registry provenance.

    Losing the evidence for an alias removes that registry record. Other manual
    owners retain their chosen identity, without deleted passage content.
    """
    if not _path(root).exists():
        return
    with _database(root) as db:
        db.execute("PRAGMA secure_delete=ON")
        db.execute("DELETE FROM ownership WHERE id=?", (document_id,))
        for table, key in (("history", "revision"), ("ownership", "id")):
            for identity, payload in db.execute(f"SELECT {key},payload FROM {table}").fetchall():
                record = json.loads(payload)
                if record.get("document_id") == document_id:
                    db.execute(f"DELETE FROM {table} WHERE {key}=?", (identity,))
                    continue
                def scrub(value):
                    if isinstance(value, dict):
                        return {k: scrub(v) for k, v in value.items()}
                    if isinstance(value, list):
                        return [scrub(v) for v in value if not isinstance(v, dict) or v.get("document_id") != document_id]
                    return value
                db.execute(f"UPDATE {table} SET payload=? WHERE {key}=?", (json.dumps(scrub(record)), identity))
        for identity, payload in db.execute("SELECT id,payload FROM projects").fetchall():
            record = json.loads(payload)
            if any(e.get("document_id") == document_id for e in record.get("identity_evidence", [])):
                # Keep an evidence-free tombstone to mask aliases copied into
                # earlier automatic catalog generations, without retained text.
                tombstone = {k: record[k] for k in ("id", "name", "aliases", "features") if k in record}
                tombstone.update(identity_evidence=[], invalidated=True)
                db.execute("UPDATE projects SET payload=? WHERE id=?", (json.dumps(tombstone), identity))
        db.execute("INSERT OR REPLACE INTO metadata VALUES('revision',?)", (str(uuid.uuid4()),))
    with _database(root) as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise ValueError("Provide a project identity of 1–100 characters")
    if any(ord(char) < 32 for char in value) or "/" in value or "\\" in value:
        raise ValueError("A project identity is a name, not a folder path")
    return value.strip()


def _contains(text, name):
    return bool(re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", text, re.I))


def _validated_evidence(root, evidence):
    from symbiknow.library.storage import heads_many
    from symbiknow.search.index import _table, _literal
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 32:
        raise ValueError("Provide 1–32 current evidence passages for the ownership correction")
    if any(not isinstance(item, dict) or any(not isinstance(item.get(key), str) or not item[key]
                                           for key in ("document_id", "version", "evidence_revision", "quote"))
           or not isinstance(item.get("evidence_id", item.get("chunk_id")), str) for item in evidence):
        raise ValueError("Each ownership passage needs document/version/evidence identities and an exact quote")
    documents, chunks = _table(root, "documents"), _table(root, "chunks")
    if documents is None or chunks is None:
        raise ValueError("Current indexed evidence is required")
    heads = heads_many(root, [item.get("document_id", "") for item in evidence])
    verified = []
    for item in evidence:
        identity, version = item.get("document_id"), item.get("version")
        rows = documents.search().where(f"document_id = {_literal(identity)}").limit(1).to_list()
        if (not rows or heads.get(identity) != version or rows[0]["version"] != version
                or rows[0].get("indexed_version") != version or rows[0]["status"] != "indexed"
                or not item.get("evidence_revision")
                or rows[0]["evidence_revision"] != item["evidence_revision"]):
            raise ValueError("Project evidence changed; inspect the current version before correcting ownership")
        evidence_id = item.get("evidence_id", item.get("chunk_id"))
        rows = chunks.search().where(
            f"document_id = {_literal(identity)} AND version = {_literal(version)} "
            f"AND chunk_id = {_literal(evidence_id)} AND active = true"
        ).select(["text", "basis", "provenance_json"]).limit(1).to_list()
        quote = item.get("quote", "")
        if not rows or not quote.strip() or quote not in rows[0]["text"]:
            raise ValueError("Project evidence must quote an exact current indexed passage")
        verified.append({"document_id": identity, "version": version,
                         "evidence_revision": item["evidence_revision"], "evidence_id": evidence_id,
                         "quote": quote, "start": rows[0]["text"].index(quote),
                         "end": rows[0]["text"].index(quote) + len(quote),
                         "basis": rows[0]["basis"], "provenance": json.loads(rows[0]["provenance_json"])})
    return verified


def _project(project, evidence, existing):
    if project is None:
        return None
    if not isinstance(project, dict):
        raise ValueError("Provide a project identity object or null for no owning project")
    from symbiknow.organization.policy import identity_statements, project_identity
    name = _name(project.get("name"))
    known = next((p for p in existing if p["name"].casefold() == name.casefold()), None)
    identity = (known or project_identity(name))["id"]
    if project.get("id", identity) != identity:
        raise ValueError("Project ID does not match its registered identity")
    aliases = list(dict.fromkeys(_name(a) for a in project.get("aliases", [])))
    features = list(dict.fromkeys(_name(a) for a in project.get("features", [])))
    if len(aliases) + len(features) > 32:
        raise ValueError("Register at most 32 project aliases and features")
    texts = [item["quote"] for item in evidence]
    if not any(_contains(text, name) for text in texts) and not known:
        raise ValueError("The project identity needs a cited content or source-path occurrence")
    if known and not any(_contains(text, member) for text in texts
                         for member in [name, *known.get("aliases", []), *known.get("features", [])]):
        raise ValueError("The ownership correction needs a passage naming the registered project family")
    connections = identity_statements([{"text": text} for text in texts])
    family = {name.casefold(), *(a.casefold() for a in (known or {}).get("aliases", []))}
    # A source repository path corroborates the named app/engine in the same
    # cited passage; arbitrary co-occurrence does not create a global alias.
    for text in texts:
        if re.search(r"(?:/Projects/|repository\s*[:=]\s*)" + re.escape(name) + r"(?:/|\b)", text, re.I):
            local_names = {claim[side].casefold() for claim in identity_statements([{"text": text}])
                           for side in ("left", "right")}
            for alias in aliases:
                described = re.search(r"(?<!\w)" + re.escape(alias) +
                                      r"\s+is\s+(?:an?|our|the)\s+(?:[\w-]+\s+){0,3}(?:app|engine|project|product)\b", text, re.I)
                if alias.casefold() in local_names or described:
                    family.add(alias.casefold())
    for _ in range(len(connections) + 1):
        for relation in connections:
            if relation["left"].casefold() in family or relation["right"].casefold() in family:
                family.update([relation["left"].casefold(), relation["right"].casefold()])
    for alias in aliases:
        if alias.casefold() not in family:
            raise ValueError("An alias needs an explicit identity statement or corroborating repository passage")
    for feature in features:
        if not any(_contains(text, feature) and any(_contains(text, n) for n in [name, *aliases])
                   for text in texts):
            raise ValueError("A feature needs cited context within the registered project family")
    for record in existing:
        if record["id"] != identity and ({name.casefold(), *(a.casefold() for a in aliases)} &
                {record["name"].casefold(), *(a.casefold() for a in record.get("aliases", []))}):
            raise ValueError("An identity or alias is already registered to another project")
    combined_evidence = {json.dumps(e, sort_keys=True): e
                         for e in [*(known or {}).get("identity_evidence", []), *evidence]}
    return {**(known or {}), "id": identity, "name": name,
            "aliases": sorted(set([*(known or {}).get("aliases", []), *aliases])),
            "features": sorted(set([*(known or {}).get("features", []), *features])),
            "identity_evidence": list(combined_evidence.values())}


def reset_ownership(root, identities, *, request_id):
    """A full grouping reset retires active owner corrections into history.

    The prior correction stays in history beside a reset entry; a correction
    made after the reset begins is a new active record. Replays are idempotent.
    """
    if not _path(root).exists():
        return []
    from itertools import islice
    from symbiknow.organization import readmodel
    retired, iterator = [], iter(dict.fromkeys(identities))
    timestamp = datetime.now(timezone.utc).isoformat()
    with _database(root) as db:
        db.execute("BEGIN IMMEDIATE")
        while batch := list(islice(iterator, 256)):
            for identity, payload in db.execute(
                    "SELECT id,payload FROM ownership WHERE id IN (" + ",".join("?" for _ in batch) + ")", batch).fetchall():
                previous = json.loads(payload)
                token = f"reset:{request_id}:{identity}"
                db.execute("INSERT OR IGNORE INTO history VALUES(?,?)", (token, json.dumps({
                    "document_id": identity, "action": "reset-ownership", "revision": token,
                    "actor": "organization-reset", "created_at": timestamp, "request_id": request_id,
                    "reason": "Full organization reset; the owner correction is kept as history only",
                    "previous_revision": previous.get("revision"), "previous": previous})))
                db.execute("DELETE FROM ownership WHERE id=?", (identity,))
                retired.append(identity)
        if retired:
            db.execute("INSERT OR REPLACE INTO metadata VALUES('revision',?)", (str(uuid.uuid4()),))
    if retired:
        readmodel.refresh(root, retired)
    return retired


def correct_ownership(root, document_id, project, *, expected_version,
                      expected_evidence_revision, expected_manual_revision,
                      reason, evidence, actor="user", expected_ownership_revision=None):
    """Explicit correction with original, evidence and per-document manual guards.

    Callers holding an application write lock retain it through this operation.
    Alias registration and effective ownership commit together, without moving a
    folder or replacing the automatic owner's historical suggestion.
    """
    from symbiknow.search.index import INDEX_LOCK, _table, _literal, get_document_status
    from symbiknow.library.storage import heads_many
    from symbiknow.organization import edits, readmodel
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("A correction reason is required")
    with INDEX_LOCK:
        table = _table(root, "documents")
        rows = table.search().where(f"document_id = {_literal(document_id)}").limit(1).to_list() if table else []
        if (not rows or rows[0]["version"] != expected_version
                or heads_many(root, [document_id]).get(document_id) != expected_version):
            raise ValueError("The original changed; refresh before correcting ownership")
        if not expected_evidence_revision or rows[0].get("evidence_revision") != expected_evidence_revision:
            raise ValueError("The evidence changed; refresh before correcting ownership")
        manual = edits.override(root, document_id)
        if (manual or {}).get("revision") != expected_manual_revision:
            raise ValueError("The manual placement changed; refresh before correcting ownership")
        verified = _validated_evidence(root, evidence)
        published = get_document_status(root, document_id)
        decision = json.loads((published or {}).get("organization_json") or "{}")
        automatic_suggestion = decision.get("automatic_owner_suggestion", decision.get("canonical_project"))
        with _database(root) as db:
            db.execute("BEGIN IMMEDIATE")
            previous_row = db.execute("SELECT payload FROM ownership WHERE id=?", (document_id,)).fetchone()
            previous = json.loads(previous_row[0]) if previous_row else None
            if (previous or {}).get("revision") != expected_ownership_revision:
                raise ValueError("The project correction changed; refresh before correcting ownership")
            existing = [json.loads(r[0]) for r in db.execute("SELECT payload FROM projects")]
            chosen = _project(project, verified, existing)
            token = str(uuid.uuid4())
            record = {"document_id": document_id, "version": expected_version,
                      "evidence_revision": expected_evidence_revision,
                      "manual_revision": expected_manual_revision,
                      "revision": token, "effective_owner": chosen, "actor": actor,
                      "automatic_owner_suggestion": (previous or {}).get("automatic_owner_suggestion", automatic_suggestion),
                      "reason": reason.strip(), "evidence": verified,
                      "previous_revision": (previous or {}).get("revision"),
                      "created_at": datetime.now(timezone.utc).isoformat()}
            if chosen:
                db.execute("INSERT OR REPLACE INTO projects VALUES(?,?)", (chosen["id"], json.dumps(chosen)))
            db.execute("INSERT OR REPLACE INTO ownership VALUES(?,?)", (document_id, json.dumps(record)))
            db.execute("INSERT INTO history VALUES(?,?)", (token, json.dumps({**record, "previous": previous})))
            db.execute("INSERT OR REPLACE INTO metadata VALUES('revision',?)", (token,))
        readmodel.refresh(root, [document_id])
        return record


def overlay(root, rows):
    from symbiknow.organization.policy import project_identity
    overrides = ownership_overrides(root, (row["document_id"] for row in rows))
    for row in rows:
        if "organization_json" not in row:
            continue
        decision = json.loads(row.get("organization_json") or "{}")
        automatic = decision.get("automatic_owner_suggestion", decision.get("canonical_project"))
        decision["automatic_owner_suggestion"] = automatic
        correction = overrides.get(row["document_id"])
        if correction and "automatic_owner_suggestion" in correction:
            automatic = correction["automatic_owner_suggestion"]
            decision["automatic_owner_suggestion"] = automatic
        effective = correction["effective_owner"] if correction else automatic
        if effective:
            effective = project_identity(effective["name"], [effective])
        decision.update(effective_owner=effective, canonical_project=effective,
                        manual_folder_override=decision.get("manual_folder_override"))
        if correction:
            decision["ownership_correction"] = correction
            provenance = decision.setdefault("correction_provenance", [])
            if not any(p.get("revision") == correction["revision"] for p in provenance):
                provenance.append(correction)
        row["organization_json"] = json.dumps(decision)
    return rows
