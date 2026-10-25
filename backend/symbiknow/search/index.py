"""Embedded LanceDB tables and its built-in vector/FTS/hybrid retrieval."""

from __future__ import annotations

import json
import threading
import unicodedata
from functools import lru_cache
from pathlib import Path

import lancedb
from lancedb.rerankers import LinearCombinationReranker, RRFReranker
import pyarrow as pa

from symbiknow.embeddings.runtime import get_embedder
from symbiknow.core.cache import CoalescingCache, dependency_key

INDEX_LOCK = threading.RLock()


def hybrid_reranker(query):
    # Cross-script queries can match only a Latin project name lexically.
    # Prefer meaning in that case, while keeping a lexical contribution.
    # Latin-script queries retain the established rank-fusion behavior.
    cross_script = any(
        char.isalpha() and "LATIN" not in unicodedata.name(char, "") for char in query
    )
    return LinearCombinationReranker(weight=0.7) if cross_script else RRFReranker()


class IndexChangedError(ValueError):
    """A derived snapshot changed before any Jev evaluation began."""


def _literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def folder_condition(folder):
    """A parent scope includes descendants at path boundaries, never name prefixes."""
    exact = f"folder = {_literal(folder)}"
    if not folder:
        return exact
    prefix = folder + " / "
    # Lance supports ordered string comparisons but not arbitrary SQL functions.
    return f"({exact} OR (folder >= {_literal(prefix)} AND folder < {_literal(prefix + chr(0x10FFFF))}))"


@lru_cache(maxsize=8)
def _db(data_dir):
    return lancedb.connect(str(Path(data_dir) / "index"))


def _table(data_dir, name, schema=None):
    db = _db(data_dir)
    try:
        table = db.open_table(name)
    except (FileNotFoundError, ValueError):
        if schema is None:
            return None
        table = db.create_table(name, schema=schema, exist_ok=True)
        from lancedb.index import BTree
        for field in ({"documents": ("document_id", "filename", "sha256"),
                       "chunks": ("document_id", "active", "embedding_model")}.get(name, ())):
            table.create_index(field, config=BTree())
        if name == "chunks" and "scope_keys" in table.schema.names:
            from lancedb.index import LabelList
            table.create_index("scope_keys", config=LabelList())
    if name == "documents":
        missing = {field: "cast('' as string)" for field in ("created_at", "evidence_revision")
                   if field not in table.schema.names}
        if missing:
            table.add_columns(missing)
    if name == "chunks":
        retired = [field for field in ("folder", "groups") if field in table.schema.names]
        if retired:
            for index in table.list_indices():
                if any(field in index.columns for field in retired):
                    table.drop_index(index.name)
            # Lance metadata transaction drops fields without reading or copying vectors.
            table.drop_columns(retired)
            from symbiknow.organization.edits import atomic
            atomic(Path(data_dir) / "index" / "derived-schema.json", {"schema": 2})
        elif not (Path(data_dir) / "index" / "derived-schema.json").exists():
            from symbiknow.organization.edits import atomic
            atomic(Path(data_dir) / "index" / "derived-schema.json", {"schema": 2})
    return table


DOCUMENT_SCHEMA = pa.schema(
    [
        ("document_id", pa.string()),
        ("version", pa.string()),
        ("indexed_version", pa.string()),
        ("evidence_revision", pa.string()),
        ("status", pa.string()),
        ("filename", pa.string()),
        ("mime_type", pa.string()),
        ("source", pa.string()),
        ("sha256", pa.string()),
        ("size", pa.int64()),
        ("index_error", pa.string()),
        ("searchable_text", pa.bool_()),
        ("searchable_visual", pa.bool_()),
        ("chunk_count", pa.int64()),
        ("folder", pa.string()),
        ("groups", pa.list_(pa.string())),
        ("links_json", pa.string()),
        ("organization_status", pa.string()),
        ("organization_json", pa.string()),
        ("created_at", pa.string()),
    ]
)


def _document_row(metadata, **updates):
    row = {
        "document_id": metadata["document_id"],
        "version": str(metadata["version"]),
        "indexed_version": "",
        "evidence_revision": "",
        "status": "pending",
        "filename": metadata["filename"],
        "mime_type": metadata.get("mime_type", "application/octet-stream"),
        "source": metadata.get("source") or "",
        "sha256": metadata.get("sha256", ""),
        "size": metadata.get("size", 0),
        "index_error": "",
        "searchable_text": False,
        "searchable_visual": False,
        "chunk_count": 0,
        "folder": "",
        "groups": [],
        "links_json": "[]",
        "organization_status": "pending",
        "organization_json": "{}",
        "created_at": metadata.get("created_at", ""),
    }
    row.update(updates)
    return {key: row[key] for key in DOCUMENT_SCHEMA.names}


def revisions(data_dir):
    path = Path(data_dir) / "temp" / "derived-revisions.json"
    state = json.loads(path.read_text()) if path.exists() else {"index": "", "organization": ""}
    from symbiknow.organization.store import revision
    generation, manual = revision(data_dir)
    if generation or manual:
        state["organization"] = generation + ":" + manual
    return state


def _bump_revision(data_dir, kind):
    import uuid
    from symbiknow.organization.edits import atomic

    file = Path(data_dir) / "temp" / "derived-revisions.json"
    state = json.loads(file.read_text()) if file.exists() else {"index": "", "organization": ""}
    state[kind] = str(uuid.uuid4())
    atomic(Path(data_dir) / "temp" / "derived-revisions.json", state)


def project_roster(data_dir):
    from symbiknow.organization.store import catalog
    return catalog(data_dir)


def set_document_status(data_dir, metadata, **updates):
    with INDEX_LOCK:
        from symbiknow.library.evidence import receipt
        if updates.get("status") == "indexed":
            completed = receipt(data_dir, metadata["document_id"])
            if completed and completed.get("state") == "preparing":
                raise ValueError("Cannot publish indexed status before chunk completion")
            if completed and completed["version"] == str(metadata["version"]):
                updates["evidence_revision"] = completed["evidence_revision"]
        elif "evidence_revision" not in updates:
            import uuid
            updates["evidence_revision"] = "pending:" + uuid.uuid4().hex
        row = _document_row(metadata, **updates)
        from symbiknow.organization.edits import override

        manual = override(data_dir, metadata["document_id"])
        if manual:
            row["folder"] = manual["folder"]
            row["organization_json"] = json.dumps({"origin": "manual", "folder": manual["folder"]})
        table = _table(data_dir, "documents", DOCUMENT_SCHEMA)
        table.merge_insert(
            "document_id"
        ).when_matched_update_all().when_not_matched_insert_all().execute([row])
        from symbiknow.organization.store import manifest, publish
        if manifest(data_dir):
            # Same-head re-extraction also invalidates automatic decisions.
            publish(data_dir, [row])
        _bump_revision(data_dir, "index")
        from symbiknow.organization import readmodel
        readmodel.refresh(data_dir, [metadata["document_id"]])
        return row


def get_document_status(data_dir, document_id):
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return None
        rows = table.search().where(f"document_id = {_literal(document_id)}").limit(1).to_list()
        from symbiknow.organization.store import overlay
        return overlay(data_dir, rows)[0] if rows else None


def document_read_state(data_dir, document_id):
    """Read only the source/evidence epoch used to guard prepared document reads.

    Organization overlays do not change these fields. Avoid resolving unrelated
    relationship dependencies when a caller needs only an evidence-read guard.
    This is not an authoritative original-head or organization lookup.
    """
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return None
        rows = table.search().where(f"document_id = {_literal(document_id)}").select(
            ["version", "evidence_revision", "status", "indexed_version"]
        ).limit(1).to_list()
        return rows[0] if rows else None


def document_statuses(data_dir, document_ids, columns=None):
    """One bounded metadata read for a retrieved shortlist, preserving row identity."""
    identities = list(dict.fromkeys(document_ids))
    if not identities:
        return {}
    if len(identities) > 800:
        raise ValueError("Metadata shortlist exceeds the retrieval budget")
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return {}
        where = "document_id IN (" + ",".join(_literal(i) for i in identities) + ")"
        from symbiknow.organization.store import overlay
        rows = table.search().where(where).select(DOCUMENT_SCHEMA.names).limit(len(identities)).to_list()
        return {row["document_id"]: ({key: row[key] for key in columns} if columns else row)
                for row in overlay(data_dir, rows)}


def mark_pending(data_dir, metadata, *, on_invalidate=None):
    """Invalidate old representations immediately after the OCFL commit."""
    with INDEX_LOCK:
        from symbiknow.library.evidence import begin
        begin(data_dir, metadata)
        table = _table(data_dir, "chunks")
        if table is not None:
            table.update(
                where=f"document_id = {_literal(metadata['document_id'])}", values={"active": False}
            )
        row = set_document_status(data_dir, metadata)
        invalidated = invalidate_related_organization(data_dir, metadata["document_id"])
        if invalidated and on_invalidate is not None:
            on_invalidate(tuple(invalidated))
        return row


def put_chunks(data_dir, metadata, rows, model_id, *, on_invalidate=None):
    """Idempotent replacement of derived chunks, never a storage version commit."""
    if isinstance(rows, list):
        if not rows:
            return
        dimension = len(rows[0]["vector"])
        schema = chunk_schema(dimension)
        batches = (
            pa.Table.from_pylist(
                rows[start : start + 64], schema=pa.schema(list(schema)[:1] + list(schema)[3:7])
            )
            for start in range(0, len(rows), 64)
        )
    else:
        dimension = rows.schema.field("vector").type.list_size
        schema = chunk_schema(dimension)
        batches = rows
    with INDEX_LOCK:
        from symbiknow.organization.store import initialize
        from symbiknow.library.evidence import EvidenceDigest, receipt, begin
        initialize(data_dir)
        previous_receipt = receipt(data_dir, metadata["document_id"])
        begin(data_dir, metadata)
        documents = _table(data_dir, "documents")
        previous_status = None
        if documents is not None:
            old_rows = documents.search().where(f"document_id = {_literal(metadata['document_id'])}")                .select(["document_id", "version", "status"]).limit(1).to_list()
            if old_rows and old_rows[0]["version"] == str(metadata["version"]):
                previous_status = old_rows[0]["status"]
                if previous_status == "indexed":
                    import uuid
                    documents.update(where=f"document_id = {_literal(metadata['document_id'])}",
                                     values={"status": "pending", "evidence_revision": "preparing:" + uuid.uuid4().hex})
                    _bump_revision(data_dir, "index")
        digest = EvidenceDigest(data_dir, model_id, dimension)
        table = _table(data_dir, "chunks", schema)
        schema = table.schema
        if table.schema.field("vector").type.list_size != dimension:
            raise ValueError("Index embedding dimensions differ; rebuild the derived index")
        where = f"document_id = {_literal(metadata['document_id'])}"
        table.delete(where)
        stream_errors = []

        def prepared_batches():
            # One append transaction consumes bounded batches. Committing each
            # four-row embedding batch creates thousands of tiny table versions.
            try:
                for batch in batches:
                    batch = (
                        pa.Table.from_batches([batch])
                        if isinstance(batch, pa.RecordBatch)
                        else batch
                    )
                    digest.add(batch)
                    values = {
                        "document_id": metadata["document_id"],
                        "version": str(metadata["version"]),
                        "embedding_model": model_id,
                        "active": False,
                    }
                    if "scope_keys" in schema.names:
                        values["scope_keys"] = []
                    for key, value in values.items():
                        batch = batch.append_column(
                            key, pa.array([value] * batch.num_rows, type=schema.field(key).type)
                        )
                    yield from batch.select(schema.names).cast(schema).to_batches()
            except Exception as exc:
                stream_errors.append(exc)
                raise

        try:
            table.add(pa.RecordBatchReader.from_batches(schema, prepared_batches()))
        except Exception:
            # Arrow/native streaming may wrap a producer error. Preserve its
            # original type for ingestion's transient/permanent retry policy.
            if stream_errors:
                raise stream_errors[0]
            raise
        if not any(index.index_type == "FTS" for index in table.list_indices()):
            from lancedb.index import FTS

            table.create_index("text", config=FTS())
        # All batches are durable before activation. Status publication still gates search.
        table.update(where=where, values={"active": True})
        epoch = digest.commit(data_dir, metadata)
        documents = _table(data_dir, "documents")
        if documents is not None:
            values = {"evidence_revision": epoch}
            if previous_status == "indexed":
                values["status"] = "indexed"
            documents.update(where=where + f" AND version = {_literal(str(metadata['version']))}", values=values)
        if not previous_receipt or previous_receipt.get("evidence_revision") != epoch:
            invalidated = invalidate_related_organization(data_dir, metadata["document_id"])
            if invalidated and on_invalidate is not None:
                on_invalidate(tuple(invalidated))
        _bump_revision(data_dir, "index")
        from symbiknow.organization import readmodel
        readmodel.refresh(data_dir, [metadata["document_id"]])
        schedule_maintenance(data_dir)
        return epoch


def chunk_schema(dimension):
    return pa.schema(
        [
            ("chunk_id", pa.string()),
            ("document_id", pa.string()),
            ("version", pa.string()),
            ("text", pa.string()),
            ("basis", pa.string()),
            ("provenance_json", pa.string()),
            ("vector", pa.list_(pa.float32(), dimension)),
            ("embedding_model", pa.string()),
            ("active", pa.bool_()),
            ("scope_keys", pa.list_(pa.string())),
        ]
    )


EVIDENCE_COLUMNS = ["chunk_id", "document_id", "version", "text", "basis", "provenance_json"]
PUBLIC_DOCUMENT_COLUMNS = [
    name
    for name in DOCUMENT_SCHEMA.names
    if name not in {"source", "links_json", "organization_json", "index_error", "evidence_revision"}
]


def _prepare_organization_row(data_dir, document_id, version, decisions, *, heads=None, row=None, projects=None,
                              reset_assignments=None):
    """One validation/precedence policy for singleton and staged publications."""
    from symbiknow.organization.edits import override
    from symbiknow.library.storage import heads_many
    from symbiknow.organization.policy import project_identity
    from symbiknow.ai.link_evidence import proof_references
    proof_links = []
    for link in decisions.get("links", []):
        proof_links.append(link)
        additional = link.get("additional_evidence", [])
        if not isinstance(additional, list) or len(additional) > 32:
            raise ValueError("Additional relationship evidence exceeds its budget")
        for item in additional:
            if (not isinstance(item, dict) or "proof" not in item or
                    any(item.get(key) != link.get(key) for key in ("document_id", "version", "source_version", "relation"))):
                raise ValueError("Additional evidence must preserve the accepted relationship")
            proof_links.append(item)
    proof_refs = [ref for link in proof_links if "proof" in link for ref in proof_references(link)]
    version = str(version)
    manual = override(data_dir, document_id)
    if manual is not None and manual == (reset_assignments or {}).get(document_id):
        manual = None
    if manual:
        decisions = {**decisions, "folder": manual["folder"], "origin": "manual"}
    if heads is None:
        identities = [document_id, *(link["document_id"] for link in decisions.get("links", [])),
                      *decisions.get("dependency_evidence_revisions", {}),
                      *(ref[0] for ref in proof_refs)]
        heads = heads_many(data_dir, identities)
    if heads.get(document_id) != version:
        raise ValueError("Organization refers to a superseded document version")
    links = decisions.get("links", [])
    if any(link.get("source_version") != version or heads.get(link["document_id"]) != link.get("version") for link in links):
        raise ValueError("Organization link refers to a superseded endpoint")
    row = row or get_document_status(data_dir, document_id)
    if row is None or row["version"] != version:
        raise ValueError("Organization refers to a superseded document version")
    if decisions.get("evidence_revision", row["evidence_revision"]) != row["evidence_revision"]:
        raise ValueError("Organization source evidence changed during preparation")
    dependencies = dict(decisions.get("dependency_evidence_revisions", {}))
    dependencies.update({link["document_id"]: dependencies.get(link["document_id"])
                         for link in links if link["document_id"] not in dependencies})
    for ref in proof_refs:
        if ref[0] != document_id:
            dependencies.setdefault(ref[0], None)
    if dependencies:
        identities = list(dependencies)
        targets = {}
        for offset in range(0, len(identities), 800):
            targets.update(document_statuses(data_dir, identities[offset:offset + 800],
                                            columns=["document_id", "version", "indexed_version", "status", "evidence_revision"]))
        for identity, expected in dependencies.items():
            target = targets.get(identity, {})
            current = target.get("evidence_revision")
            if (current is None or (expected is not None and expected != current)
                    or target.get("status") != "indexed" or target.get("indexed_version") != target.get("version")
                    or heads.get(identity) != target.get("version")):
                raise ValueError("Organization supporting evidence changed during preparation")
            dependencies[identity] = current
    refs = [(document_id, version, ref) for ref in decisions.get("evidence_ids", [])]
    refs += [(document_id, version, link.get("source_chunk_id")) for link in links]
    refs += [(link["document_id"], link["version"], link.get("target_chunk_id")) for link in links]
    refs += proof_refs
    resolved = resolve_evidence_many(data_dir, refs)
    if any(not ref or (doc, ver, ref) not in resolved for doc, ver, ref in refs):
        raise ValueError("Organization evidence does not resolve to its stored endpoint")
    if any(link.get("proof") for link in proof_links):
        from symbiknow.ai.link_evidence import validate_link_proof
        from symbiknow.library.storage import metadata_many
        originals = metadata_many(data_dir, list({document_id, *(link["document_id"] for link in links)}))
        for link in proof_links:
            if link.get("proof"):
                validate_link_proof(link, document_id, resolved, metadata=originals)
    project = decisions.get("canonical_project")
    if project:
        roster = projects if projects is not None else project_roster(data_dir)
        if project_identity(project["name"], roster)["id"] != project["id"]:
            raise ValueError("Canonical project identity mismatch")
    return {**row, "folder": decisions.get("folder") or "", "groups": decisions.get("groups", []),
            "links_json": json.dumps(links), "organization_status": decisions.get("status", "completed"),
            "organization_json": json.dumps({key: value for key, value in decisions.items()
                                              if key != "dependency_evidence_revisions"}),
            "evidence_dependencies_json": json.dumps(dependencies)}


def save_organization(data_dir, document_id, version, decisions, *, prepared=None):
    from symbiknow.organization.store import publish
    from symbiknow.library.storage import read_snapshot
    with INDEX_LOCK, read_snapshot(data_dir):
        row = (validate_prepared_organization(data_dir, prepared) if prepared is not None
               else _prepare_organization_row(data_dir, document_id, version, decisions))
        publish(data_dir, [row])
        return row


def reset_organization(data_dir, identities, *, grouping, links, assignments, request_id):
    """Publish one explicit reset boundary through the normal organization owner.

    The caller holds the protected application snapshot. Only captured manual
    assignment revisions can be removed; later edits remain authoritative.
    """
    from symbiknow.organization.store import publish, overlay, manifest, recover
    from symbiknow.library.storage import heads_many
    recover(data_dir)
    if (manifest(data_dir) or {}).get("reset_request") == request_id:
        return  # Manifest switched before the rebuild checkpoint was persisted.
    selected = set(identities)
    source = _table(data_dir, "documents")
    reset = {"request_id": request_id, "assignments": assignments if grouping else {},
             "catalog_reset": grouping, "projects": {}}

    def rows():
        if source is None:
            return
        roster = project_roster(data_dir)
        for batch in source.search().limit(max(1, source.count_rows())).to_batches(batch_size=128):
            visible = overlay(data_dir, batch.to_pylist())
            wanted = {row["document_id"] for row in visible}
            wanted.update(link["document_id"] for row in visible for link in json.loads(row["links_json"]))
            wanted.update(identity for row in visible for identity in json.loads(row.get("evidence_dependencies_json", "{}")))
            heads = {}
            ordered = sorted(wanted)
            for offset in range(0, len(ordered), 800):
                heads.update(heads_many(data_dir, ordered[offset:offset + 800]))
            for row in visible:
                identity = row["document_id"]
                old = json.loads(row["organization_json"])
                if grouping and identity not in selected and old.get("canonical_project"):
                    project = old["canonical_project"]
                    reset["projects"][project["id"]] = project
                existing = json.loads(row["links_json"])
                kept = [link for link in existing if heads.get(link["document_id"]) == link["version"]]
                if links:
                    kept = [] if identity in selected else [link for link in kept if link["document_id"] not in selected]
                if identity not in selected and kept == existing:
                    continue
                if heads.get(identity) != row["version"]:
                    continue
                decision = ({"status": "reset_pending", "folder": "New", "groups": [],
                             "reason": "Awaiting organization review"}
                            if grouping and identity in selected else {
                                **old, "status": row["organization_status"], "folder": row["folder"], "groups": row["groups"]})
                if links:
                    decision.pop("link_evaluations", None)
                    decision.pop("links_review", None)
                decision.update(links=kept, evidence_revision=row.get("evidence_revision", ""))
                if not (grouping and identity in selected):
                    decision["dependency_evidence_revisions"] = json.loads(row.get("evidence_dependencies_json", "{}"))
                yield _prepare_organization_row(data_dir, identity, row["version"], decision,
                                                row=row, heads=heads, projects=roster,
                                                reset_assignments=reset["assignments"])
    # Lance consumes Arrow generators on native threads. Resolve all database
    # work on this protected caller thread, then stream only prepared IPC bytes.
    import tempfile
    from symbiknow.organization.store import SCHEMA, FIELDS
    with tempfile.TemporaryFile() as prepared:
        with pa.ipc.new_stream(prepared, SCHEMA) as writer:
            from itertools import islice
            iterator = iter(rows())
            while batch := list(islice(iterator, 128)):
                writer.write_batch(pa.RecordBatch.from_pylist(
                    [{field: row[field] for field in FIELDS} for row in batch], schema=SCHEMA))
        prepared.seek(0)
        publish(data_dir, (row for batch in pa.ipc.open_stream(prepared) for row in batch.to_pylist()), reset=reset)


def validate_prepared_organization(data_dir, item, *, heads=None, row=None, projects=None):
    """One exact source/dependency validation for staged and progressive review."""
    identity, version, decision = item["document_id"], item["version"], item["decision"]
    dependencies = item.get("dependencies", [])
    if heads is None:
        from symbiknow.library.storage import heads_many
        identities = sorted({identity, *(dep["document_id"] for dep in dependencies),
                             *decision.get("dependency_evidence_revisions", {}),
                             *(link["document_id"] for link in decision.get("links", []))})
        heads = {}
        for offset in range(0, len(identities), 800):
            heads.update(heads_many(data_dir, identities[offset:offset + 800]))
    row = row or get_document_status(data_dir, identity)
    if not row or heads.get(identity) != version or row["version"] != version:
        raise ValueError("Source changed during organization preparation")
    requested = [(dep["document_id"], dep["version"], evidence.get("evidence_id"))
                 for dep in dependencies for evidence in dep.get("evidence", [])]
    actual = resolve_evidence_many(data_dir, requested)
    if any(heads.get(dep["document_id"]) != dep["version"] for dep in dependencies):
        raise ValueError("Supporting source changed during organization preparation")
    if any(actual.get((dep["document_id"], dep["version"], evidence.get("evidence_id"))) !=
           {key: evidence.get(key, {} if key == "provenance" else "")
            for key in ("evidence_id", "text", "basis", "provenance")}
           for dep in dependencies for evidence in dep.get("evidence", [])):
        raise ValueError("Evidence changed during organization preparation")
    return _prepare_organization_row(data_dir, identity, version, decision, heads=heads, row=row, projects=projects)


def publish_organization_generation(data_dir, generation, *, invalidated=None):
    """Stream one validated generation into one atomic Lance merge transaction."""
    from itertools import islice
    from symbiknow.organization.store import staged, prepare_generation, switch_generation, manifest, initialize
    from symbiknow.library.storage import heads_many, source_revision, read_snapshot
    with INDEX_LOCK, read_snapshot(data_dir):
        initialize(data_dir)
        baseline = revisions(data_dir)
        capture = capture_metadata(data_dir)
        source_token = source_revision(data_dir)
        base = manifest(data_dir)
        from symbiknow.organization.store import catalog
        catalog_lease = catalog(data_dir, base)
    count = 0
    invalidated = invalidated if invalidated is not None else {}

    def reject(identity, reason):
        invalidated[identity] = reason

    def validated_rows():
        nonlocal count
        entries = iter(staged(data_dir, generation))
        while batch := list(islice(entries, 128)):
            identities = {item["document_id"] for item in batch}
            identities.update(link["document_id"] for item in batch for link in item["decision"].get("links", []))
            identities.update(dep["document_id"] for item in batch for dep in item.get("dependencies", []))
            ordered, heads = sorted(identities), {}
            for offset in range(0, len(ordered), 800):
                heads.update(heads_many(data_dir, ordered[offset:offset + 800]))
            states = document_statuses(data_dir, [item["document_id"] for item in batch])
            for item in batch:
                identity = item["document_id"]
                row = states.get(identity)
                try:
                    row = validate_prepared_organization(data_dir, item, heads=heads, row=row, projects=catalog_lease)
                except ValueError as exc:
                    reject(identity, str(exc))
                    continue
                count += 1
                yield row
    # Consume database-dependent validation before handing Arrow to Lance's
    # native worker threads. The final transaction streams an on-disk IPC file.
    import tempfile
    from symbiknow.organization.store import SCHEMA, FIELDS
    with tempfile.TemporaryFile() as prepared:
        with pa.ipc.new_stream(prepared, SCHEMA) as writer:
            iterator = iter(validated_rows())
            while True:
                with INDEX_LOCK:
                    batch = list(islice(iterator, 256))
                if not batch:
                    break
                writer.write_batch(pa.RecordBatch.from_pylist(
                    [{field: row.get(field, "{}" if field == "evidence_dependencies_json" else "") for field in FIELDS} for row in batch], schema=SCHEMA))
        prepared.seek(0)
        candidate = prepare_generation(data_dir, generation, pa.ipc.open_stream(prepared), base)
    from symbiknow.organization import readmodel
    projection = None
    try:
        if readmodel.ready(data_dir):
            projection = readmodel.prepare_generation(data_dir, candidate, capture)
            candidate["read_projection"] = projection
        with INDEX_LOCK, read_snapshot(data_dir):
            if source_revision(data_dir) != source_token or revisions(data_dir) != baseline:
                raise IndexChangedError("Source or index changed while preparing organization publication")
            switch_generation(data_dir, generation, base, candidate)
    finally:
        if projection:
            readmodel.release_generation(data_dir, projection)
        readmodel.prune(data_dir)
    from symbiknow.organization.store import prune
    prune(data_dir)
    return count


def browse_documents(
    data_dir,
    offset=0,
    limit=60,
    folder=None,
    group=None,
    recent=False,
    sort="filename",
    descending=False,
    cursor=None,
):
    """Metadata-only pagination includes pending, failed and unsupported originals."""
    with INDEX_LOCK:
        from symbiknow.organization import readmodel
        if readmodel.ready(data_dir):
            result = readmodel.browse(data_dir, limit, folder, group, recent, sort, descending, cursor, offset)
            # Bounded authoritative organization/evidence validation remains in
            # the shared snapshot; the projection never grants evidence validity.
            from symbiknow.organization.store import overlay
            result["documents"] = overlay(data_dir, result["documents"], columns=PUBLIC_DOCUMENT_COLUMNS)
            return result
        table = _table(data_dir, "documents")
        if table is None:
            return {"documents": [], "total": 0, "offset": offset, "has_more": False}
        conditions = []
        if folder is not None or group is not None:
            from symbiknow.organization.store import scope_condition
            conditions.append(scope_condition(data_dir, folder, group))
        where = " AND ".join(conditions) or "true"
        total = table.count_rows(where)
        query = table.search().where(where)
        columns = {"filename": "filename", "type": "mime_type", "date": "created_at"}
        if sort not in columns:
            raise ValueError("Sort by filename, type, or date")
        query = query.order_by(
            [
                lancedb.query.ColumnOrdering(
                    column_name="created_at" if recent else columns[sort],
                    ascending=not (recent or descending),
                ),
                lancedb.query.ColumnOrdering(column_name="document_id", ascending=True),
            ]
        )
        rows = query.select([*PUBLIC_DOCUMENT_COLUMNS, "evidence_revision"]).offset(offset).limit(limit).to_list()
        from symbiknow.organization.store import overlay
        rows = [{key: row[key] for key in PUBLIC_DOCUMENT_COLUMNS} for row in overlay(data_dir, rows, columns=PUBLIC_DOCUMENT_COLUMNS)]
        return {
            "documents": rows,
            "total": total,
            "offset": offset,
            "has_more": offset + len(rows) < total,
        }


def register_document(data_dir, metadata, disabled=False):
    """Populate listing at commit/startup without resetting an existing valid index."""
    with INDEX_LOCK:
        row = get_document_status(data_dir, metadata["document_id"])
        if row is None or row["version"] != metadata["version"]:
            return (
                mark_pending(data_dir, metadata)
                if not disabled
                else set_document_status(data_dir, metadata, status="disabled")
            )
        if row.get("created_at") != metadata.get("created_at", ""):
            row["created_at"] = metadata.get("created_at", "")
            _table(data_dir, "documents").merge_insert(
                "document_id"
            ).when_matched_update_all().execute([row])
        return row


def invalidate_related_organization(data_dir, target_id):
    """Invalidate relationship decisions through the sole organization publisher."""
    from symbiknow.organization.store import published_table, publish
    with INDEX_LOCK:
        table = published_table(data_dir) or _table(data_dir, "documents")
        if table is None:
            return []
        from symbiknow.organization import readmodel
        if readmodel.ready(data_dir):
            identities = set()
            for dependencies in (False, True):
                after = ""
                while page := readmodel.related(data_dir, target_id, dependencies=dependencies, after=after, limit=256):
                    identities.update(page)
                    after = page[-1]
            # Check membership on the published rows themselves. The validating
            # overlay has already hidden a decision whose dependency moved, so
            # reading through it found no dependents and none was ever reviewed again.
            ordered, candidates = sorted(identities), []
            for offset in range(0, len(ordered), 800):
                batch = ordered[offset:offset + 800]
                candidates += table.search().where(
                    "document_id IN (" + ",".join(_literal(identity) for identity in batch) + ")"
                ).limit(len(batch)).to_list()
        else:
            pattern = "%" + json.dumps(target_id) + "%"
            condition = f"links_json LIKE {_literal(pattern)}"
            if "evidence_dependencies_json" in table.schema.names:
                condition += f" OR evidence_dependencies_json LIKE {_literal(pattern)}"
            candidates = table.search().where(condition).limit(max(1, table.count_rows())).to_list()
        rows = []
        for candidate in candidates:
            row = get_document_status(data_dir, candidate["document_id"])
            if not row or not (target_id in json.loads(candidate.get("evidence_dependencies_json", "{}"))
                               or any((link.get("document_id") or link.get("target_document_id")) == target_id
                                      for link in json.loads(candidate["links_json"]))):
                continue
            row.update(folder="", groups=[], links_json="[]", organization_json="{}", organization_status="pending")
            rows.append(row)
        if rows:
            publish(data_dir, rows)
        return [row["document_id"] for row in rows]


def organization_catalog(data_dir):
    # Background organization consumes the whole vocabulary in bounded pages.
    # Request-side hints read a single projection page instead.
    folders, groups, _ = _organization_names(str(Path(data_dir).resolve()))
    return {
        "folders": sorted(folders),
        "groups": sorted(groups),
        "projects": project_roster(data_dir),
    }


_NAMES_CACHE = CoalescingCache(max_entries=16, max_bytes=4 * 1024**2, max_inflight=2)


def _organization_names(data_dir):
    from symbiknow.organization import readmodel
    if readmodel.ready(data_dir):
        from symbiknow.organization.policy import ProjectNames
        folders, groups, cursor = set(), set(), ""
        while True:
            with INDEX_LOCK:
                names = readmodel.aggregates(data_dir, after=cursor)
            folders.update(names["folders"])
            groups.update(names["groups"])
            if not names["taxonomy_has_more"]:
                break
            cursor = names["taxonomy_next_after"]
        return frozenset(folders), frozenset(groups), ProjectNames(name.split(" / ")[0] for name in folders if " / " in name)
    from symbiknow.library.storage import source_revision
    key = dependency_key("organization-names", library=str(Path(data_dir).resolve()), revision=revisions(data_dir),
                         source_revision=source_revision(data_dir))
    def collect():
        from symbiknow.organization.store import overlay
        from symbiknow.organization.policy import ProjectNames
        table = _table(data_dir, "documents")
        folders, groups = set(), set()
        if table is not None:
            for batch in table.search().select(["document_id", "version", "evidence_revision", "folder", "groups"]).limit(max(1, table.count_rows())).to_batches(batch_size=512):
                for row in overlay(data_dir, batch.to_pylist(), columns=["folder", "groups"]):
                    if row["folder"]:
                        folders.add(row["folder"])
                    groups.update(row["groups"])
        return (frozenset(folders), frozenset(groups),
                ProjectNames(name.split(" / ")[0] for name in folders if " / " in name))
    return _NAMES_CACHE.get_or_compute(key, collect)


def maintain_index(data_dir):
    """Run while the daemon is stopped; delegate ANN/compaction to LanceDB."""
    with INDEX_LOCK:
        chunks = _table(data_dir, "chunks")
        documents = _table(data_dir, "documents")
        if documents is not None:
            documents.create_scalar_index("document_id", index_type="BTREE", replace=True)
            documents.optimize()
        if chunks is None:
            return {"chunks": 0, "vector_index": False}
        count = chunks.count_rows()
        for name in ("document_id", "active", "embedding_model"):
            chunks.create_scalar_index(name, index_type="BTREE", replace=True)
        # SQ keeps the footprint small and avoids bespoke vector compression. Small
        # corpora remain exact scans, avoiding low-sample quantizer training.
        if count >= 1024:
            chunks.create_index(
                metric="cosine",
                index_type="IVF_SQ",
                num_partitions=max(1, min(256, int(count**0.5))),
            )
        chunks.optimize()
        return {"chunks": count, "vector_index": count >= 1024}


def scope_tokens(folder=None, group=None):
    """Stable posting keys; taxonomy labels/authority remain in organization."""
    import hashlib
    return [kind + hashlib.sha256(value.encode()).hexdigest() for kind, value in
            (("f:", folder), ("g:", group)) if value is not None]


def publish_scope_postings(data_dir, rows, *, additional=()):
    """Update narrow scalar postings without reading/copying evidence or vectors."""
    table = _table(data_dir, "chunks")
    if table is None or "scope_keys" not in table.schema.names or not rows:
        return
    values = {}
    for row in [*rows, *additional]:
        parts = row.get("folder", "").split(" / ")
        keys = [scope_tokens(" / ".join(parts[:i]))[0] for i in range(1, len(parts) + 1)]
        keys += [scope_tokens(group=group)[0] for group in row.get("groups", [])]
        values.setdefault(row["document_id"], set()).update(keys)
    schema = pa.schema([("document_id", pa.string()), ("scope_keys", pa.list_(pa.string()))])
    table.merge_insert("document_id").when_matched_update_all().execute(pa.Table.from_pylist([{"document_id": key, "scope_keys": sorted(keys)} for key, keys in values.items()], schema=schema))


def initialize_scope_postings(data_dir, force=False):
    """One streaming migration at boot, before serving requests."""
    from symbiknow.organization import readmodel
    from lancedb.index import BTree, LabelList
    chunks = _table(data_dir, "chunks")
    if chunks is None:
        return
    if "scope_keys" not in chunks.schema.names:
        chunks.add_columns(pa.field("scope_keys", pa.list_(pa.string())))
        force = True
    with readmodel.connection(data_dir) as db:
        migrated = db.execute("SELECT value FROM meta WHERE key='scope_postings'").fetchone()
        if force or not migrated:
            cursor = db.execute("SELECT payload FROM documents ORDER BY id")
            for batch in iter(lambda: cursor.fetchmany(512), []):
                publish_scope_postings(data_dir, [readmodel.decode(row[0]) for row in batch])
            db.execute("INSERT OR REPLACE INTO meta VALUES('scope_postings','1')")
    existing = {i.columns[0] for i in chunks.list_indices()}
    for name in ("document_id", "active", "embedding_model"):
        if name not in existing:
            chunks.create_index(name, config=BTree())
    if "scope_keys" not in existing:
        chunks.create_index("scope_keys", config=LabelList())


def schedule_maintenance(data_dir):
    from symbiknow.search.maintenance import notify
    notify(data_dir)


def maintain_online(data_dir):
    """Native index construction runs outside interactive publication locks."""
    from lancedb.index import BTree
    with INDEX_LOCK:
        chunks = _table(data_dir, "chunks")
        documents = _table(data_dir, "documents")
    for table, fields in ((documents, ("document_id", "filename", "sha256")),
                          (chunks, ("document_id", "active", "embedding_model"))):
        if table is None:
            continue
        existing = {i.columns[0] for i in table.list_indices()}
        for field in fields:
            if field not in existing:
                table.create_index(field, config=BTree())
    if chunks is not None:
        count = chunks.count_rows()
        if count >= 1024 and not any("vector" in i.columns for i in chunks.list_indices()):
            chunks.create_index(metric="cosine", index_type="IVF_SQ",
                                num_partitions=max(1, min(256, int(count**.5))))
        chunks.optimize()


def resolve_evidence(data_dir, document_id, version, evidence_id):
    table = _table(data_dir, "chunks")
    if table is None or not evidence_id:
        return None
    rows = (
        table.search()
        .where(
            f"document_id = {_literal(document_id)} AND version = {_literal(version)} AND chunk_id = {_literal(evidence_id)} AND active = true"
        )
        .select(EVIDENCE_COLUMNS)
        .limit(1)
        .to_list()
    )
    if not rows:
        return None
    row = rows[0]
    return {
        "evidence_id": row["chunk_id"],
        "text": row["text"],
        "basis": row["basis"],
        "provenance": json.loads(row["provenance_json"]),
    }


def resolve_evidence_many(data_dir, references):
    """One bounded Lance read of exact identity/version/passage tuples.

    Caller holds INDEX_LOCK for snapshot consistency. OCFL heads remain a
    separate authoritative check; this is not a storage-head cache.
    """
    requested = set((d, str(v), ref) for d, v, ref in references if ref)
    if len(requested) > 2000:
        raise ValueError("Evidence validation exceeds bounded search window")
    if not requested:
        return {}
    table = _table(data_dir, "chunks")
    if table is None:
        return {}
    grouped = {}
    for d, v, ref in requested:
        grouped.setdefault((d, v), set()).add(ref)
    conditions = [
        f"(document_id = {_literal(d)} AND version = {_literal(v)} AND chunk_id IN ("
        + ",".join(_literal(ref) for ref in sorted(refs))
        + "))"
        for (d, v), refs in sorted(grouped.items())
    ]
    rows = (
        table.search()
        .where("active = true AND (" + " OR ".join(conditions) + ")")
        .select(EVIDENCE_COLUMNS)
        .limit(len(requested))
        .to_list()
    )
    from symbiknow.search.metrics import add

    add("evidence_batch_reads", 1)
    add("evidence_batch_references", len(requested))
    return {
        (row["document_id"], row["version"], row["chunk_id"]): {
            "evidence_id": row["chunk_id"],
            "text": row["text"],
            "basis": row["basis"],
            "provenance": json.loads(row["provenance_json"]),
        }
        for row in rows
    }


def document_evidence(data_dir, document_id, version, limit=12):
    with INDEX_LOCK:
        table = _table(data_dir, "chunks")
        if table is None:
            return []
        table.checkout(table.version)
    # The native count/order/scan can traverse a large document. The immutable
    # handle survives concurrent index publication; callers revalidate evidence.
    where = f"document_id = {_literal(document_id)} AND version = {_literal(version)} AND active = true"
    count = table.count_rows(where)
    offsets = (
        set(sorted({int(i * (count - 1) / max(1, limit - 1)) for i in range(limit)}))
        if limit and count > limit
        else None
    )
    # One ordered Arrow scan: skip unsampled rows without expanding vectors or text into Python.
    rows = []
    index = 0
    batches = (
        table.search()
        .where(where)
        .select(EVIDENCE_COLUMNS)
        .order_by([lancedb.query.ColumnOrdering(column_name="chunk_id", ascending=True)])
        .limit(max(1, count))
        .to_batches(batch_size=128)
    )
    for batch in batches:
        if offsets is None:
            rows.extend(batch.to_pylist())
        else:
            chosen = [i - index for i in sorted(offsets) if index <= i < index + batch.num_rows]
            if chosen:
                rows.extend(batch.take(pa.array(chosen)).to_pylist())
        index += batch.num_rows
    return [
        {
            "evidence_id": row["chunk_id"],
            "text": row["text"],
            "basis": row["basis"],
            "provenance": json.loads(row["provenance_json"]),
            "document_id": document_id,
            "version": str(version),
        }
        for row in rows
    ]


def evidence_batches(data_dir, document_id, version, batch_size=32):
    """Full ordered evidence traversal; no sampling and no vector materialization.

    Capture a pinned Arrow reader under the index lock, then release the lock
    before yielding. Consumers must validate heads and evidence revisions again.
    """
    with INDEX_LOCK:
        table = _table(data_dir, "chunks")
        if table is None:
            return
        where = f"document_id = {_literal(document_id)} AND version = {_literal(version)} AND active = true"
        count = table.count_rows(where)
        batches = (table.search().where(where).select(EVIDENCE_COLUMNS)
                   .order_by([lancedb.query.ColumnOrdering(column_name="chunk_id", ascending=True)])
                   .limit(max(1, count)).to_batches(batch_size=batch_size))
    for batch in batches:
        yield [{
            "evidence_id": row["chunk_id"], "text": row["text"], "basis": row["basis"],
            "provenance": json.loads(row["provenance_json"]),
        } for row in batch.to_pylist()]


get_document_evidence = document_evidence


def find_documents(
    data_dir,
    query,
    mode="hybrid",
    limit=10,
    folder=None,
    group=None,
    embedder=None,
    *,
    defer_links=False,
):
    if mode not in {"semantic", "hybrid", "keyword", "grep"}:
        raise ValueError("mode must be semantic, grep, hybrid, or keyword")
    if not query.strip() or not 1 <= limit <= 100:
        raise ValueError("Provide a nonempty query and limit between 1 and 100")
    from symbiknow.search.metrics import add, stage, timed_lock

    if mode == "grep":
        from symbiknow.search.grep import parse_command
        parse_command(query)
    with timed_lock(INDEX_LOCK, "initial_index_lock"):
        if _table(data_dir, "chunks") is None:
            return []
    vector = None
    if mode not in {"keyword", "grep"}:
        with stage("embedding_model_load"):
            embedder = embedder or get_embedder()
        if embedder.model_id == "google/embeddinggemma-2":
            from symbiknow.embeddings.runtime import validate_index

            validate_index(data_dir)
        with stage("embedding"):
            vector = embedder.embed_query(query)

    with timed_lock(INDEX_LOCK, "candidate_index_lock"):
        revision = revisions(data_dir)
        table = _table(data_dir, "chunks")
        conditions = ["active = true"]
        if folder is not None or group is not None:
            from symbiknow.organization import readmodel
            if "scope_keys" in table.schema.names and readmodel.ready(data_dir):
                conditions.extend(f"array_contains(scope_keys, {_literal(key)})" for key in scope_tokens(folder, group))
            else:
                from symbiknow.organization.store import scope_condition
                conditions.append(scope_condition(data_dir, folder, group))
        if mode == "grep":
            builder = table.search()
        elif mode == "keyword":
            builder = table.search(query, query_type="fts", fts_columns="text")
        else:
            conditions.append(f"embedding_model = {_literal(embedder.model_id)}")
            if mode == "semantic":
                builder = table.search(vector).distance_type("cosine").nprobes(32).refine_factor(10)
            else:
                builder = (
                    table.search(query_type="hybrid")
                    .vector(vector)
                    .text(query)
                    .distance_type("cosine")
                    .nprobes(32).refine_factor(10)
                    .rerank(reranker=hybrid_reranker(query))
                )
    if mode == "grep":
        from symbiknow.search.grep import matching_rows
        batches = (builder.where(" AND ".join(conditions)).select(EVIDENCE_COLUMNS)
                   .limit(max(1, table.count_rows())).to_batches(batch_size=128))
        rows = matching_rows(query, batches, limit)
    else:
        rows = (
            builder.where(" AND ".join(conditions), prefilter=True)
            .select(
                EVIDENCE_COLUMNS
                + (["_score"] if mode == "keyword" else ["_distance"] if mode == "semantic" else [])
            )
            .limit(min(limit * 8, 800))
            .to_list()
        )
    with timed_lock(INDEX_LOCK, "candidate_validation_lock"):
        matches = {}
        states = document_statuses(data_dir, (row["document_id"] for row in rows))
        for row in rows:
            key = row["document_id"]
            state = states.get(key)
            if (
                state is None
                or state["status"] != "indexed"
                or (
                    state["indexed_version"] != row["version"] or state["version"] != row["version"]
                )
            ):
                continue
            if key not in matches:
                score_key = next(
                    (k for k in ("_relevance_score", "_score", "_distance") if k in row), None
                )
                matches[key] = {
                    "document_id": key,
                    "version": row["version"],
                    "evidence_revision": state["evidence_revision"],
                    "filename": state["filename"],
                    "sha256": state["sha256"],
                    "mime_type": state["mime_type"],
                    "created_at": state.get("created_at", ""),
                    "source": state["source"],
                    "folder": state["folder"],
                    "groups": state["groups"],
                    "organization_status": state["organization_status"],
                    "links": [] if defer_links else json.loads(state["links_json"]),
                    "evidence": [],
                    "retrieval": {
                        "mode": mode,
                        "score": row.get(score_key),
                        "score_kind": score_key,
                    },
                    "relevance_explanation": (f"Matched by grep over extracted text; evidence basis is {row['basis']}." if mode == "grep" else f"Retrieved by LanceDB {mode} search; evidence basis is {row['basis']}."),
                }
            if len(matches[key]["evidence"]) >= 8:
                continue
            matches[key]["evidence"].append(
                {
                    "evidence_id": row["chunk_id"],
                    "text": row["text"],
                    "basis": row["basis"],
                    "provenance": json.loads(row["provenance_json"]),
                }
            )

    # OCFL subprocess reads do not hold INDEX_LOCK. Only candidates that can
    # enter the requested window need a head check; group passages first.
    # Ties use document identity, so equal-score retrieval has a stable order.
    def ordering(match):
        r = match["retrieval"]
        score = r["score"] or 0
        return (score if r["score_kind"] == "_distance" else -score, match["document_id"])

    output, heads = [], {}
    ordered = sorted(matches.values(), key=ordering)
    from symbiknow.library.storage import heads_many

    # Validate a bounded candidate round in one native operation. Stale rows
    # may require another round; do not validate an unbounded corpus eagerly.
    cursor = 0

    def head_version(identity, role):
        add(role + "_head_checks", 1)
        return heads[identity]

    while len(output) < limit and cursor < len(ordered):
        candidates = ordered[cursor:cursor + max(1, limit - len(output))]
        cursor += len(candidates)
        identities = {match["document_id"] for match in candidates}
        if not defer_links:
            identities.update(link["document_id"] for match in candidates for link in match["links"])
        with stage("candidate_heads"):
            heads.update(heads_many(data_dir, list(identities - heads.keys())))
        for match in candidates:
            if head_version(match["document_id"], "candidate") != match["version"]:
                continue
            if not defer_links:
                match["links"] = [link for link in match["links"] if
                    head_version(link["document_id"], "relationship") == link["version"]]
            output.append(match)
    with timed_lock(INDEX_LOCK, "context_index_lock"):
        if revisions(data_dir) != revision:
            # Caller may retry, but never spin or publish a mixed index snapshot.
            raise IndexChangedError("Index changed during retrieval; restart search")
        if mode == "grep":
            for rank, match in enumerate(output, 1):
                match["retrieval"]["rank"] = rank
            return output
        # Assemble adjacent context in one bounded read instead of per-window queries.
        import re

        requested = []
        neighbors = {}
        introductions = {}
        for match in output:
            refs = []
            introduction = None
            for passage in match["evidence"][:3]:
                chunk = re.match(r"^(.*:t)(\d+)$", passage["evidence_id"])
                if chunk:
                    if introduction is None and passage.get("text"):
                        introduction = chunk[1] + "0"
                    refs.extend(chunk[1] + str(int(chunk[2]) + offset) for offset in (-1, 1))
            # One structural context slot preserves the document introduction
            # and subject when top-ranked passages lie deep in the document.
            # Resolve it in the existing bounded exact-tuple batch; rankings,
            # candidate depth stays unchanged; up to twelve provider windows retain all eight retrieved passages.
            introductions[match["document_id"]] = introduction
            if introduction:
                refs.insert(0, introduction)
            neighbors[match["document_id"]] = refs
            requested.extend((match["document_id"], match["version"], ref) for ref in refs)
        with stage("context_evidence"):
            records = resolve_evidence_many(data_dir, requested)
        for rank, match in enumerate(output, 1):
            match["retrieval"]["rank"] = rank
            selected = match["evidence"][:8]
            context = []
            for ref in neighbors[match["document_id"]]:
                neighbor = records.get((match["document_id"], match["version"], ref))
                if ref == introductions[match["document_id"]] and (
                    not neighbor
                    or not neighbor.get("text")
                    or neighbor.get("basis") in {"image", "visual", "native_image"}
                ):
                    continue
                if neighbor and ref not in {e["evidence_id"] for e in [*selected, *context]}:
                    context.append(neighbor)
            match["evidence"] = [*selected, *context][:12]
        return output


class OrganizationNeighbors(list):
    """Evaluable current neighbors plus complete explicit-reference diagnostics."""

    def __init__(self, values=(), *, references=(), source_evidence=()):
        super().__init__(values)
        self.references = list(references)
        self.source_evidence = list(source_evidence)


_REFERENCE_BATCH = 64


def _organization_references(evidence):
    """Read identity hints from complete original passages, retaining exact spans."""
    import re
    from urllib.parse import parse_qs, unquote, urlsplit

    uuid = r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}"
    identity = r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}"
    version = re.compile(r"(?:[:/]\s*|\bversion[`\"']?\s*[=:]?\s*[`\"']?)(v[1-9][0-9]*)\b", re.I)
    for row in evidence:
        text = row.get("text", "")
        found = []
        for match in re.finditer(rf"(?<![\w-])({uuid})(?![\w-])|\bdocument_id[`\"']?\s*[=:]\s*[`\"']?({identity})(?![\w-])", text):
            found.append((match.start(), match.end(), {"document_id": match[1] or match[2]}))
        for match in re.finditer(r"\[[^]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|(?:symbiknow|https?)://[^\s<>`]+", text):
            link = (match[1] if match[1] else match[0]).rstrip(".,;")
            parsed = urlsplit(link)
            query = parse_qs(parsed.query)
            target = None
            local = not parsed.scheme or parsed.scheme == "symbiknow" or parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            if local:
                if parsed.scheme == "symbiknow" or re.search(r"/(?:api/)?(?:document|documents|original|download)(?:/|$)", parsed.path):
                    value = (query.get("document_id") or query.get("id") or [None])[0]
                    if value is None:
                        value = parsed.path.rstrip("/").split("/")[-1]
                    if value and re.fullmatch(identity, value):
                        target = {"document_id": value}
                elif not parsed.scheme and parsed.path and re.search(r"\.[A-Za-z0-9]{1,12}$", parsed.path):
                    target = {"filename": unquote(parsed.path).replace("\\", "/").split("/")[-1]}
            if target:
                explicit_version = (query.get("version") or [None])[0]
                if explicit_version and re.fullmatch(r"v[1-9][0-9]*", explicit_version):
                    target["requested_version"] = explicit_version
                found.append((match.start(), match.end(), target))
        found.sort(key=lambda item: (item[0], item[1]))
        for index, (start, end, target) in enumerate(found):
            following = min((item[0] for item in found[index + 1:] if item[0] >= end and "document_id" in item[2]), default=len(text))
            # A table/manifest row supplies its own version; never borrow the next
            # named target's version or silently substitute the current head.
            tail = text[end:min(following, end + 512)].split("\n", 1)[0]
            requested = version.search(tail)
            if requested and "requested_version" not in target:
                target["requested_version"] = requested[1].lower()
            yield {**target, "source_evidence_id": row.get("evidence_id", ""),
                   "start": start, "end": end, "reference_text": text[start:end]}


def _organization_reference_source(data_dir, document):
    """Scan one current source in bounded batches, retaining only reference anchors."""
    from symbiknow.library.storage import current_version

    identity, version = document["document_id"], str(document["version"])
    before = get_document_status(data_dir, identity)
    if (not before or before.get("status") != "indexed"
            or before.get("version") != version or before.get("indexed_version") != version
            or current_version(data_dir, identity) != version):
        raise ValueError("Reference source is not the current indexed version")
    references, anchors = [], []
    for batch in evidence_batches(data_dir, identity, version, batch_size=32):
        for passage in batch:
            found = list(_organization_references([passage]))
            if found:
                references.extend(found)
                anchors.append({**passage, "document_id": identity, "version": version})
    after = get_document_status(data_dir, identity)
    if (not after or after.get("status") != "indexed"
            or after.get("version") != version or after.get("indexed_version") != version
            or after.get("evidence_revision") != before.get("evidence_revision")
            or current_version(data_dir, identity) != version):
        raise ValueError("Reference source changed during discovery; retry current evidence")
    return references, anchors


def _explicit_organization_neighbors(data_dir, document, references):
    from symbiknow.library import storage

    names = list(dict.fromkeys(ref["filename"] for ref in references if "filename" in ref))
    named = {}
    for offset in range(0, len(names), _REFERENCE_BATCH):
        with INDEX_LOCK:
            table = _table(data_dir, "documents")
            if table is None:
                break
            values = names[offset:offset + _REFERENCE_BATCH]
            where = "filename IN (" + ",".join(_literal(name) for name in values) + ")"
            batches = table.search().where(where).select(["document_id", "filename"]).limit(max(1, table.count_rows(where))).to_batches(batch_size=_REFERENCE_BATCH)
        for batch in batches:
            for row in batch.to_pylist():
                named.setdefault(row["filename"], []).append(row["document_id"])
    identities = list(dict.fromkeys([ref["document_id"] for ref in references if "document_id" in ref]
                                   + [identity for values in named.values() for identity in values]))
    metadata, statuses = {}, {}
    for offset in range(0, len(identities), _REFERENCE_BATCH):
        batch = identities[offset:offset + _REFERENCE_BATCH]
        metadata.update(storage.metadata_many(data_dir, batch))
        statuses.update(document_statuses(data_dir, batch))
    resolutions = {}
    for ref in references:
        identity = ref.get("document_id")
        if identity is None:
            matches = [identity for identity in named.get(ref["filename"], [])
                       if metadata.get(identity) and metadata[identity]["filename"] == ref["filename"]]
            if len(matches) == 1:
                identity = matches[0]
            else:
                key = ("filename", ref["filename"], ref.get("requested_version"))
                resolution = resolutions.setdefault(key, {"filename": ref["filename"],
                    "requested_version": ref.get("requested_version"),
                    "status": "ambiguous" if matches else "missing", "candidate_document_ids": matches, "references": []})
                resolution["references"].append(ref)
                continue
        if identity == document["document_id"]:
            continue
        current, indexed = metadata.get(identity), statuses.get(identity)
        requested = ref.get("requested_version")
        status = "missing" if current is None else "historical" if requested and requested != current["version"] else "pending"
        if current and status != "historical" and indexed and indexed.get("status") == "indexed" and indexed.get("indexed_version") == current["version"] == indexed.get("version"):
            status = "resolved"
        key = (identity, requested or (current or {}).get("version"))
        resolution = resolutions.setdefault(key, {"document_id": identity, "requested_version": requested,
            "current_version": current["version"] if current else None,
            "filename": current["filename"] if current else ref.get("filename"),
            "status": status, "references": []})
        resolution["references"].append(ref)
    # Historical pins are checked as historical identities, never promoted to the
    # current graph. Missing old versions are distinct from stored old originals.
    historical = [value for value in resolutions.values() if value["status"] == "historical"]
    for offset in range(0, len(historical), _REFERENCE_BATCH):
        batch = historical[offset:offset + _REFERENCE_BATCH]
        values = storage._read_metadata_many(data_dir, [(row["document_id"], row["requested_version"]) for row in batch])
        for row in batch:
            row["status"] = "historical" if values[(row["document_id"], row["requested_version"])] else "missing_version"
    candidates = {}
    for value in resolutions.values():
        if value["status"] != "resolved":
            continue
        identity = value["document_id"]
        if identity not in candidates:
            row = statuses[identity]
            passages = document_evidence(data_dir, identity, row["version"])
            if not passages:
                value["status"] = "pending"
                continue
            candidates[identity] = {**row, "evidence": passages,
                                    "candidate_source": "explicit_reference", "references": []}
        candidates[identity]["references"].extend(value["references"])
    return list(candidates.values()), list(resolutions.values())


def _organization_similarity(source, peers, common_lines):
    """Rank subjects with template frequency as a weight, preserving all evidence."""
    import math
    import re
    from collections import Counter
    from symbiknow.organization.policy import _tokens, GENERIC

    stop = GENERIC | {"the", "and", "for", "with", "this", "that", "from", "are", "was", "were", "has", "have", "its", "their", "our", "but", "not", "can", "will", "into"}
    def sentences(rows):
        return [part.strip().casefold() for row in rows for part in re.split(r"\n+|(?<=[.!?])\s+", row.get("text", "")) if part.strip()]
    texts = [sentences(source), *(sentences(peer.get("evidence", [])) for peer in peers)]
    repeated = Counter(part for parts in texts for part in set(parts))
    common = {line.strip().casefold() for line in common_lines}
    def weights(parts):
        result, signal = {}, set()
        for part in parts:
            template = part in common or repeated[part] >= max(2, len(texts) // 2)
            for token in set(_tokens(part)) - stop:
                result[token] = max(result.get(token, 0), .05 if template else 1)
                if not template:
                    signal.add(token)
        return result, signal
    weights_by_doc = [weights(parts) for parts in texts]
    frequencies = Counter(token for values, _ in weights_by_doc for token in values)
    def entities(rows):
        return set(re.findall(r"\b[A-Z][A-Z0-9]{1,10}:\s*([A-Z][A-Z0-9.-]{0,12})\b", "\n".join(row.get("text", "") for row in rows)))
    source_entities = entities(source)
    source_weights, source_signal = weights_by_doc[0]
    def weighted(values):
        return {token: value * (1 + math.log((len(texts) + 1) / (frequencies[token] + 1))) for token, value in values.items()}
    left = weighted(source_weights)
    scores = {}
    for peer, (values, signal) in zip(peers, weights_by_doc[1:]):
        other_entities = entities(peer.get("evidence", []))
        if source_entities and other_entities and source_entities.isdisjoint(other_entities) and len(source_signal & signal) < 3:
            continue
        right = weighted(values)
        overlap = sum(min(left[token], right[token]) for token in left.keys() & right.keys())
        score = overlap / max(1, (sum(left.values()) * sum(right.values())) ** .5)
        if source_entities and other_entities and source_entities.isdisjoint(other_entities):
            score *= .3
        if score >= .12:
            scores[peer["document_id"]] = score
    return scores


def organization_neighbors(data_dir, document, evidence, common_lines=(), *, folders=None):
    """Complete explicit reference discovery, plus at most five semantic neighbors.

    References are identity hints, not accepted relationships. Missing, ambiguous,
    unindexed and historical targets remain visible diagnostics for the caller.
    """
    from symbiknow.organization.policy import representative_evidence, project_scope, _tokens, ProjectNames
    from symbiknow.library.storage import heads_many

    source_references, source_evidence = _organization_reference_source(data_dir, document)
    explicit, references = _explicit_organization_neighbors(data_dir, document, source_references)
    rows = representative_evidence(evidence, common_lines)
    text = "\n".join(row["text"] for row in rows)
    neighbors = find_documents(data_dir, text[:3000], mode="semantic", limit=16) if text else []
    known = (_organization_names(str(Path(data_dir).resolve()))[2] if folders is None
             else ProjectNames(name.split(" / ")[0] for name in folders if " / " in name))
    scope = project_scope(rows, known)
    topical = set(_tokens(text)) - set(_tokens(scope))
    lexical = find_documents(data_dir, f"{scope} {' '.join(sorted(topical)[:24])}", mode="keyword", limit=32) if scope else []
    pool = {item["document_id"]: item for item in [*lexical, *neighbors]
            if item["document_id"] != document["document_id"]}
    scores = _organization_similarity(evidence, list(pool.values()), common_lines)
    ranked = sorted((item for identity, item in pool.items() if identity in scores), key=lambda item: (
        -bool(scope and project_scope(representative_evidence(item.get("evidence", []), common_lines), known).casefold() == scope.casefold()),
        -scores[item["document_id"]], item["document_id"]))
    exact = []
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        where = f"sha256 = {_literal(document['sha256'])} AND status = 'indexed'" if document.get("sha256") else None
        batches = table.search().where(where).limit(max(1, table.count_rows(where))).to_batches(batch_size=_REFERENCE_BATCH) if table is not None and where else []
    for batch in batches:
        peers = batch.to_pylist()
        heads = heads_many(data_dir, [row["document_id"] for row in peers])
        for row in peers:
            if row["document_id"] != document["document_id"] and heads.get(row["document_id"]) == row["version"]:
                exact.append({**row, "evidence": document_evidence(data_dir, row["document_id"], row["version"]), "candidate_source": "duplicate"})
    result = {}
    for item in [*explicit, *exact]:
        result.setdefault(item["document_id"], item)
    # Explicit targets and exact-byte duplicates never spend semantic slots.
    for item in ranked:
        if item["document_id"] not in result:
            result[item["document_id"]] = {**item, "candidate_source": "semantic"}
            if sum(row.get("candidate_source") == "semantic" for row in result.values()) == 5:
                break
    return OrganizationNeighbors(result.values(), references=references, source_evidence=source_evidence)


def metadata_batches(data_dir, columns=None, batch_size=512):
    """Pinned source iteration, acquiring the publication lock for one batch only."""
    from symbiknow.organization.store import overlay
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return
        table.checkout(table.version)
        selected = list(dict.fromkeys(["document_id", "version", "evidence_revision", *columns])) if columns is not None else DOCUMENT_SCHEMA.names
        batches = table.search().select(selected).limit(max(1, table.count_rows())).to_batches(batch_size=batch_size)
    for batch in batches:
        with INDEX_LOCK:
            rows = overlay(data_dir, batch.to_pylist(), columns=columns)
        yield [{key: row[key] for key in columns} for row in rows] if columns is not None else rows


def capture_metadata(data_dir):
    """Pin the immutable index version in constant time for a durable job."""
    table = _table(data_dir, "documents")
    return {"version": table.version if table is not None else None,
            "count": table.count_rows() if table is not None else 0}


def captured_metadata_page(data_dir, capture, after="", limit=128):
    if not 1 <= limit <= 500:
        raise ValueError("Capture page limit must be 1–500")
    if capture["version"] is None:
        return []
    table = _table(data_dir, "documents")
    table.checkout(capture["version"])
    return (table.search().where(f"document_id > {_literal(after)}")
            .order_by([lancedb.query.ColumnOrdering(column_name="document_id", ascending=True)])
            .limit(limit).to_list())


def possible_duplicates(data_dir, saved):
    """Bounded advisory lookup; duplicates retain independent source identity."""
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return []
        return table.search().where(
            f"document_id != {_literal(saved['document_id'])} AND "
            f"(filename = {_literal(saved['filename'])} OR sha256 = {_literal(saved['sha256'])})"
        ).select(["document_id", "version", "filename", "sha256"]).limit(5).to_list()


def relationship_rows(data_dir, document_id):
    """Bounded current organization candidates for shared relationship reads."""
    from symbiknow.organization.store import published_table
    with INDEX_LOCK:
        from symbiknow.organization import readmodel
        if readmodel.ready(data_dir):
            return document_statuses(data_dir, [document_id, *readmodel.related(data_dir, document_id, limit=99)])
        table = published_table(data_dir) or _table(data_dir, "documents")
        if table is None:
            return {}
        pattern = "%" + json.dumps(document_id) + "%"
        candidates = table.search().where(
            f"document_id != {_literal(document_id)} AND links_json LIKE {_literal(pattern)}"
        ).limit(99).select(["document_id"]).to_list()
        from symbiknow.organization.corrections import assignment_ids
        # Corrections can add incoming edges absent from the old publication.
        return document_statuses(data_dir, list(dict.fromkeys([
            document_id, *(row["document_id"] for row in candidates), *assignment_ids(data_dir)])))


def remove_document(data_dir, document_id):
    """Remove derived rows and incoming links after the original object is purged."""
    with INDEX_LOCK:
        from symbiknow.freshness.store import FreshnessStore
        FreshnessStore(data_dir).remove_document(document_id)
        table = _table(data_dir, "documents")
        if table is not None:
            from symbiknow.organization.store import overlay, publish
            from symbiknow.organization import readmodel
            def incoming():
                if readmodel.ready(data_dir):
                    after = ""
                    while page := readmodel.related(data_dir, document_id, after=after, limit=256):
                        yield list(document_statuses(data_dir, page).values())
                        after = page[-1]
                else:
                    for batch in table.search().limit(max(1, table.count_rows())).to_batches(batch_size=256):
                        yield overlay(data_dir, batch.to_pylist())
            # Arrow may consume generators on another native thread. Resolve
            # each bounded batch before publication, while this thread owns the lock.
            for batch in incoming():
                changed = []
                for row in batch:
                    links = json.loads(row["links_json"])
                    kept = [link for link in links if link.get("document_id") != document_id]
                    if kept != links:
                        row.update(links_json=json.dumps(kept), organization_json="{}")
                        changed.append(row)
                if changed:
                    publish(data_dir, changed)
            publish(data_dir, [], remove=[document_id])
            table.delete(f"document_id = {_literal(document_id)}")
        chunks = _table(data_dir, "chunks")
        if chunks is not None:
            chunks.delete(f"document_id = {_literal(document_id)}")
        from symbiknow.library.evidence import receipt_path
        receipt_path(data_dir, document_id).unlink(missing_ok=True)
        _bump_revision(data_dir, "index")
        _bump_revision(data_dir, "organization")
        from symbiknow.organization import readmodel
        readmodel.refresh(data_dir, [document_id])
        receipt = Path(data_dir) / "temp" / "deleted-documents" / (document_id + ".json")
        if receipt.exists():
            from symbiknow.organization.edits import atomic
            atomic(receipt, {**json.loads(receipt.read_text()), "derived_removed": True})


def recover_deleted_index(data_dir):
    from symbiknow.library.storage import heads_many

    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is not None:
            ids = table.search().select(["document_id"]).limit(max(1, table.count_rows())).to_list()
            for offset in range(0, len(ids), 800):
                heads = heads_many(data_dir, [row["document_id"] for row in ids[offset:offset + 800]])
                for identity, head in heads.items():
                    if head is None:
                        remove_document(data_dir, identity)
