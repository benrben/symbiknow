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
        return row


def get_document_status(data_dir, document_id):
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return None
        rows = table.search().where(f"document_id = {_literal(document_id)}").limit(1).to_list()
        from symbiknow.organization.store import overlay
        return overlay(data_dir, rows)[0] if rows else None


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
    version = str(version)
    manual = override(data_dir, document_id)
    if manual is not None and manual == (reset_assignments or {}).get(document_id):
        manual = None
    if manual:
        decisions = {**decisions, "folder": manual["folder"], "origin": "manual"}
    if heads is None:
        identities = [document_id, *(link["document_id"] for link in decisions.get("links", [])),
                      *decisions.get("dependency_evidence_revisions", {})]
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
    resolved = resolve_evidence_many(data_dir, refs)
    if any(not ref or (doc, ver, ref) not in resolved for doc, ver, ref in refs):
        raise ValueError("Organization evidence does not resolve to its stored endpoint")
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
    from symbiknow.core.application import current_application
    with current_application().snapshots.read():
        if source_revision(data_dir) != source_token or revisions(data_dir) != baseline:
            raise IndexChangedError("Source or index changed while preparing organization publication")
        switch_generation(data_dir, generation, base, candidate)
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
):
    """Metadata-only pagination includes pending, failed and unsupported originals."""
    with INDEX_LOCK:
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
    with INDEX_LOCK:
        folders, groups, _ = _organization_names(str(Path(data_dir).resolve()))
        return {
            "folders": sorted(folders),
            "groups": sorted(groups),
            "projects": project_roster(data_dir),
        }


_NAMES_CACHE = CoalescingCache(max_entries=16, max_bytes=4 * 1024**2, max_inflight=2)


def _organization_names(data_dir):
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
            from symbiknow.organization.store import scope_condition
            conditions.append(scope_condition(data_dir, folder, group))
        if mode == "grep":
            builder = table.search()
        elif mode == "keyword":
            builder = table.search(query, query_type="fts", fts_columns="text")
        else:
            conditions.append(f"embedding_model = {_literal(embedder.model_id)}")
            if mode == "semantic":
                builder = table.search(vector).distance_type("cosine")
            else:
                builder = (
                    table.search(query_type="hybrid")
                    .vector(vector)
                    .text(query)
                    .distance_type("cosine")
                    .rerank(reranker=hybrid_reranker(query))
                )
        if mode == "grep":
            from symbiknow.search.grep import matching_rows, MAX_ROWS
            batches = (builder.where(" AND ".join(conditions)).select(EVIDENCE_COLUMNS)
                       .limit(MAX_ROWS + 1).to_batches(batch_size=128))
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


def organization_neighbors(data_dir, document, evidence, common_lines=(), *, folders=None):
    """Reserve three topic candidates within the project and two global neighbors.

    FTS provides a bounded content-based pool even when old folder metadata is wrong.
    Jev still decides every semantic link; retrieval never asserts a relationship.
    """
    from symbiknow.organization.policy import representative_evidence, project_scope, _tokens, ProjectNames
    from symbiknow.library.storage import heads_many

    rows = representative_evidence(evidence, common_lines)
    text = "\n".join(r["text"] for r in rows)
    neighbors = find_documents(data_dir, text[:3000], mode="semantic", limit=16) if text else []
    with INDEX_LOCK:
        known = (
            _organization_names(str(Path(data_dir).resolve()))[2]
            if folders is None
            else ProjectNames(name.split(" / ")[0] for name in folders if " / " in name)
        )
    scope = project_scope(rows, known)
    topical = set(_tokens(text)) - set(_tokens(scope))
    lexical = (
        find_documents(
            data_dir, f"{scope} {' '.join(sorted(topical)[:24])}", mode="keyword", limit=32
        )
        if scope
        else []
    )
    same_project = {}
    for item in [*lexical, *neighbors]:
        if item["document_id"] == document["document_id"]:
            continue
        other_rows = representative_evidence(item.get("evidence", []), common_lines)
        if scope and project_scope(other_rows, known).casefold() == scope.casefold():
            other = set(_tokens(" ".join(row["text"] for row in other_rows))) - set(_tokens(scope))
            overlap = len(topical & other) / max(1, (len(topical) * len(other)) ** 0.5)
            if overlap >= 0.12:
                same_project[item["document_id"]] = (overlap, item)
    preferred = [
        item
        for _, item in sorted(
            same_project.values(), key=lambda value: (-value[0], value[1]["document_id"])
        )[:3]
    ]
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        peers = (
            table.search()
            .where(f"sha256 = {_literal(document['sha256'])} AND status = 'indexed'")
            .limit(100000)
            .to_list()
            if table is not None and document.get("sha256")
            else []
        )
        exact = []
        heads = {}
        for offset in range(0, len(peers), 800):
            heads.update(heads_many(data_dir, [row["document_id"] for row in peers[offset:offset + 800]]))
        for row in peers:
            if (
                row["document_id"] != document["document_id"]
                and heads.get(row["document_id"]) == row["version"]
            ):
                exact.append(
                    {
                        **row,
                        "evidence": document_evidence(data_dir, row["document_id"], row["version"]),
                    }
                )
    result = {}
    for neighbor in [*exact, *preferred, *neighbors]:
        if neighbor["document_id"] != document["document_id"]:
            result.setdefault(
                neighbor["document_id"],
                {
                    **neighbor,
                    "evidence": representative_evidence(neighbor.get("evidence", []), common_lines),
                },
            )
    return list(result.values())


def metadata_batches(data_dir, columns=None, batch_size=512):
    """Bounded shared metadata iteration; never materialize source text/vectors."""
    from symbiknow.organization.store import overlay
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return
        selected = list(dict.fromkeys(["document_id", "version", "evidence_revision", *columns])) if columns is not None else DOCUMENT_SCHEMA.names
        for batch in table.search().select(selected).limit(
            max(1, table.count_rows())
        ).to_batches(batch_size=batch_size):
            rows = overlay(data_dir, batch.to_pylist(), columns=columns)
            yield [{key: row[key] for key in columns} for row in rows] if columns is not None else rows


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
        table = published_table(data_dir) or _table(data_dir, "documents")
        if table is None:
            return {}
        pattern = "%" + json.dumps(document_id) + "%"
        candidates = table.search().where(
            f"document_id = {_literal(document_id)} OR links_json LIKE {_literal(pattern)}"
        ).limit(100).select(["document_id"]).to_list()
        return document_statuses(data_dir, [row["document_id"] for row in candidates])


def remove_document(data_dir, document_id):
    """Remove derived rows and incoming links after the original object is purged."""
    with INDEX_LOCK:
        from symbiknow.freshness.store import FreshnessStore
        FreshnessStore(data_dir).remove_document(document_id)
        table = _table(data_dir, "documents")
        if table is not None:
            from symbiknow.organization.store import overlay, publish
            changed = []
            for batch in table.search().limit(max(1, table.count_rows())).to_batches(batch_size=512):
                for row in overlay(data_dir, batch.to_pylist()):
                    links = json.loads(row["links_json"])
                    kept = [link for link in links if link.get("document_id") != document_id]
                    if kept != links:
                        row.update(links_json=json.dumps(kept), organization_json="{}")
                        changed.append(row)
            publish(data_dir, changed, remove=[document_id])
            table.delete(f"document_id = {_literal(document_id)}")
        chunks = _table(data_dir, "chunks")
        if chunks is not None:
            chunks.delete(f"document_id = {_literal(document_id)}")
        from symbiknow.library.evidence import receipt_path
        receipt_path(data_dir, document_id).unlink(missing_ok=True)
        _bump_revision(data_dir, "index")
        _bump_revision(data_dir, "organization")


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
