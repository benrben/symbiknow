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

from .embeddings import get_embedder

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


def _db(data_dir):
    return lancedb.connect(str(Path(data_dir) / "index"))


def _table(data_dir, name, schema=None):
    db = _db(data_dir)
    try:
        table = db.open_table(name)
        if name == "documents" and "created_at" not in table.schema.names:
            table.add_columns({"created_at": "cast('' as string)"})
        return table
    except (FileNotFoundError, ValueError):
        if schema is None:
            return None
        return db.create_table(name, schema=schema, exist_ok=True)


DOCUMENT_SCHEMA = pa.schema(
    [
        ("document_id", pa.string()),
        ("version", pa.string()),
        ("indexed_version", pa.string()),
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
    return json.loads(path.read_text()) if path.exists() else {"index": "", "organization": ""}


def _bump_revision(data_dir, kind):
    import uuid
    from .organization_edits import atomic

    state = revisions(data_dir)
    state[kind] = str(uuid.uuid4())
    atomic(Path(data_dir) / "temp" / "derived-revisions.json", state)


def project_roster(data_dir):
    path = Path(data_dir) / "temp" / "canonical-projects.json"
    return json.loads(path.read_text()).get("projects", []) if path.exists() else []


def set_document_status(data_dir, metadata, **updates):
    with INDEX_LOCK:
        row = _document_row(metadata, **updates)
        from app.organization_edits import override

        manual = override(data_dir, metadata["document_id"])
        if manual:
            row["folder"] = manual["folder"]
            row["organization_json"] = json.dumps({"origin": "manual", "folder": manual["folder"]})
        table = _table(data_dir, "documents", DOCUMENT_SCHEMA)
        table.merge_insert(
            "document_id"
        ).when_matched_update_all().when_not_matched_insert_all().execute([row])
        _bump_revision(data_dir, "index")
        return row


def get_document_status(data_dir, document_id):
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return None
        rows = table.search().where(f"document_id = {_literal(document_id)}").limit(1).to_list()
        return rows[0] if rows else None


indexed_document = get_document_status


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
        return {
            row["document_id"]: row
            for row in table.search()
            .where(where)
            .select(columns or DOCUMENT_SCHEMA.names)
            .limit(len(identities))
            .to_list()
        }


def mark_pending(data_dir, metadata):
    """Invalidate old representations immediately after the OCFL commit."""
    with INDEX_LOCK:
        table = _table(data_dir, "chunks")
        if table is not None:
            table.update(
                where=f"document_id = {_literal(metadata['document_id'])}", values={"active": False}
            )
        return set_document_status(data_dir, metadata)


def put_chunks(data_dir, metadata, rows, model_id):
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
        table = _table(data_dir, "chunks", schema)
        if table.schema.field("vector").type.list_size != dimension:
            raise ValueError("Index embedding dimensions differ; rebuild the derived index")
        where = f"document_id = {_literal(metadata['document_id'])}"
        table.delete(where)
        for batch in batches:
            batch = pa.Table.from_batches([batch]) if isinstance(batch, pa.RecordBatch) else batch
            values = {
                "document_id": metadata["document_id"],
                "version": str(metadata["version"]),
                "embedding_model": model_id,
                "active": False,
                "folder": "",
                "groups": [],
            }
            for key, value in values.items():
                batch = batch.append_column(
                    key, pa.array([value] * batch.num_rows, type=schema.field(key).type)
                )
            table.add(batch.select(schema.names).cast(schema))
        if not any(index.index_type == "FTS" for index in table.list_indices()):
            from lancedb.index import FTS

            table.create_index("text", config=FTS())
        # All batches are durable before activation. Status publication still gates search.
        table.update(where=where, values={"active": True})


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
            ("folder", pa.string()),
            ("groups", pa.list_(pa.string())),
        ]
    )


EVIDENCE_COLUMNS = ["chunk_id", "document_id", "version", "text", "basis", "provenance_json"]
PUBLIC_DOCUMENT_COLUMNS = [
    name
    for name in DOCUMENT_SCHEMA.names
    if name not in {"source", "links_json", "organization_json", "index_error"}
]


def save_organization(data_dir, document_id, version, decisions):
    with INDEX_LOCK:
        from app.organization_edits import override

        manual = override(data_dir, document_id)
        if manual:
            decisions = {**decisions, "folder": manual["folder"], "origin": "manual"}
        from .storage import current_version

        if current_version(data_dir, document_id) != str(version):
            raise ValueError("Organization refers to a superseded document version")
        for link in decisions.get("links", []):
            if link.get("source_version") != str(version) or current_version(
                data_dir, link["document_id"]
            ) != link.get("version"):
                raise ValueError("Organization link refers to a superseded endpoint")
        row = get_document_status(data_dir, document_id)
        if row is None or row["version"] != str(version):
            raise ValueError("Organization refers to a superseded document version")
        # Every accepted reference must resolve to a stored current-version row.
        for evidence_id in decisions.get("evidence_ids", []):
            if not resolve_evidence(data_dir, document_id, version, evidence_id):
                raise ValueError("Organization evidence does not resolve to the source version")
        for link in decisions.get("links", []):
            if not resolve_evidence(
                data_dir, document_id, version, link.get("source_chunk_id")
            ) or not resolve_evidence(
                data_dir, link["document_id"], link["version"], link.get("target_chunk_id")
            ):
                raise ValueError("Link evidence does not resolve to its stored endpoint")
        project = decisions.get("canonical_project")
        if project:
            from .organization import project_identity
            from .organization_edits import atomic

            roster = project_roster(data_dir)
            canonical = project_identity(project["name"], roster)
            if canonical["id"] != project["id"]:
                raise ValueError("Canonical project identity mismatch")
            if not any(p["id"] == project["id"] for p in roster):
                atomic(
                    Path(data_dir) / "temp" / "canonical-projects.json",
                    {"schema": 1, "projects": [*roster, project]},
                )
        row.update(
            folder=decisions.get("folder") or "",
            groups=decisions.get("groups", []),
            links_json=json.dumps(decisions.get("links", [])),
            organization_status=decisions.get("status", "completed"),
            organization_json=json.dumps(decisions),
        )
        table = _table(data_dir, "documents", DOCUMENT_SCHEMA)
        previous = get_document_status(data_dir, document_id)
        from .organization_edits import atomic

        marker = Path(data_dir) / "temp" / "filter-publications" / (document_id + ".json")
        atomic(marker, {"document_id": document_id})
        try:
            # Readers hold INDEX_LOCK. Chunks are prepared first; the document
            # row is the publication point. Restore filters if publication fails.
            _set_chunk_filters(data_dir, row)
            table.merge_insert("document_id").when_matched_update_all().execute([row])
        except Exception:
            table.merge_insert("document_id").when_matched_update_all().execute([previous])
            _set_chunk_filters(data_dir, previous)
            raise
        _bump_revision(data_dir, "organization")
        marker.unlink(missing_ok=True)
        _organization_names.cache_clear()
        return row


def _set_chunk_filters(data_dir, row):
    chunks = _table(data_dir, "chunks")
    if chunks is not None and row is not None:
        group_sql = (
            "arrow_cast([" + ",".join(_literal(g) for g in row["groups"]) + "], 'List(Utf8)')"
        )
        chunks.update(
            where=f"document_id = {_literal(row['document_id'])} AND version = {_literal(row['version'])}",
            values_sql={"folder": _literal(row["folder"]), "groups": group_sql},
        )


def recover_organization_filters(data_dir, full=False):
    """Replay interrupted publications; one full repair initializes legacy databases."""
    from .organization_edits import atomic

    with INDEX_LOCK:
        root = Path(data_dir) / "temp" / "filter-publications"
        initialized = root / "initialized.json"
        markers = list(root.glob("*.json")) if root.exists() else []
        table = _table(data_dir, "documents")
        if table is None:
            return
        if full or not initialized.exists():
            query = table.search().where("chunk_count > 0")
        else:
            ids = [p.stem for p in markers if p != initialized]
            if not ids:
                return
            query = table.search().where(
                "document_id IN (" + ",".join(_literal(i) for i in ids) + ")"
            )
        for batch in (
            query.select(["document_id", "version", "folder", "groups"])
            .limit(max(1, table.count_rows()))
            .to_batches()
        ):
            for row in batch.to_pylist():
                _set_chunk_filters(data_dir, row)
        _bump_revision(data_dir, "organization")
        atomic(initialized, {"schema": 1})
        for marker in markers:
            if marker != initialized:
                marker.unlink(missing_ok=True)


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
        if folder is not None:
            conditions.append(folder_condition(folder))
        if group is not None:
            conditions.append(f"array_contains(groups, {_literal(group)})")
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
        rows = query.select(PUBLIC_DOCUMENT_COLUMNS).offset(offset).limit(limit).to_list()
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
    """Queue fresh Jev decisions for sources whose versioned relation target changed."""
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is None:
            return []
        pattern = "%" + json.dumps(target_id) + "%"
        candidates = (
            table.search().where(f"links_json LIKE {_literal(pattern)}").limit(100000).to_list()
        )
        changed = []
        for row in candidates:
            links = json.loads(row["links_json"])
            if not any(
                (link.get("document_id") or link.get("target_document_id")) == target_id
                for link in links
            ):
                continue
            row["links_json"] = "[]"
            row["organization_json"] = "{}"
            row["organization_status"] = "pending"
            table.merge_insert("document_id").when_matched_update_all().execute([row])
            changed.append(row["document_id"])
        if changed:
            _bump_revision(data_dir, "organization")
        return changed


def organization_catalog(data_dir):
    with INDEX_LOCK:
        folders, groups, _ = _organization_names(str(Path(data_dir).resolve()))
        return {
            "folders": sorted(folders),
            "groups": sorted(groups),
            "projects": project_roster(data_dir),
        }


@lru_cache(maxsize=8)
def _organization_names(data_dir):
    # An existing naming vocabulary, loaded once per daemon rather than scanning
    # the full corpus before every Jev call. Unused names may remain until restart.
    table = _table(data_dir, "documents")
    rows = (
        [] if table is None else table.search().select(["folder", "groups"]).limit(100000).to_list()
    )
    from .organization import ProjectNames

    folders = {r["folder"] for r in rows if r["folder"]}
    return (
        folders,
        {g for r in rows for g in r["groups"]},
        ProjectNames(name.split(" / ")[0] for name in folders if " / " in name),
    )


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
        for name in ("document_id", "active", "folder", "embedding_model"):
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
    from .search_metrics import add

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
    if mode not in {"semantic", "hybrid", "keyword"}:
        raise ValueError("mode must be semantic, hybrid, or keyword")
    if not query.strip() or not 1 <= limit <= 100:
        raise ValueError("Provide a nonempty query and limit between 1 and 100")
    from .search_metrics import add, stage, timed_lock

    with timed_lock(INDEX_LOCK, "initial_index_lock"):
        if _table(data_dir, "chunks") is None:
            return []
    vector = None
    if mode != "keyword":
        with stage("embedding_model_load"):
            embedder = embedder or get_embedder()
        if embedder.model_id == "google/embeddinggemma-2":
            from .embeddings import validate_index

            validate_index(data_dir)
        with stage("embedding"):
            vector = embedder.embed_query(query)

    with timed_lock(INDEX_LOCK, "candidate_index_lock"):
        revision = revisions(data_dir)
        table = _table(data_dir, "chunks")
        conditions = ["active = true"]
        if folder is not None:
            conditions.append(folder_condition(folder))
        if group is not None:
            conditions.append(f"array_contains(groups, {_literal(group)})")
        if mode == "keyword":
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
                    "filename": state["filename"],
                    "sha256": state["sha256"],
                    "mime_type": state["mime_type"],
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
                    "relevance_explanation": f"Retrieved by LanceDB {mode} search; evidence basis is {row['basis']}.",
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

    def head_version(identity, role):
        from .storage import current_version

        if identity not in heads:
            add(role + "_head_checks", 1)
            with stage(role + "_heads"):
                heads[identity] = current_version(data_dir, identity)
        return heads[identity]

    for match in sorted(matches.values(), key=ordering):
        if head_version(match["document_id"], "candidate") != match["version"]:
            continue
        if not defer_links:
            match["links"] = [
                link
                for link in match["links"]
                if head_version(link["document_id"], "relationship") == link["version"]
            ]
        output.append(match)
        if len(output) == limit:
            break
    with timed_lock(INDEX_LOCK, "context_index_lock"):
        if revisions(data_dir) != revision:
            # Caller may retry, but never spin or publish a mixed index snapshot.
            raise IndexChangedError("Index changed during retrieval; restart search")
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
            # candidate depth and the six-window provider budget stay unchanged.
            introductions[match["document_id"]] = introduction
            if introduction:
                refs.insert(0, introduction)
            neighbors[match["document_id"]] = refs
            requested.extend((match["document_id"], match["version"], ref) for ref in refs)
        with stage("context_evidence"):
            records = resolve_evidence_many(data_dir, requested)
        for rank, match in enumerate(output, 1):
            match["retrieval"]["rank"] = rank
            selected = match["evidence"][:3]
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
            match["evidence"] = [*selected, *context][:6]
        return output


def organization_neighbors(data_dir, document, evidence, common_lines=(), *, folders=None):
    """Reserve three topic candidates within the project and two global neighbors.

    FTS provides a bounded content-based pool even when old folder metadata is wrong.
    Jev still decides every semantic link; retrieval never asserts a relationship.
    """
    from .organization import representative_evidence, project_scope, _tokens, ProjectNames
    from .storage import current_version

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
        for row in peers:
            if (
                row["document_id"] != document["document_id"]
                and current_version(data_dir, row["document_id"]) == row["version"]
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


def remove_document(data_dir, document_id):
    """Remove derived rows and incoming links after the original object is purged."""
    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is not None:
            for row in (
                table.search()
                .select(["document_id", "links_json"])
                .limit(max(1, table.count_rows()))
                .to_list()
            ):
                links = json.loads(row["links_json"])
                kept = [link for link in links if link.get("document_id") != document_id]
                if kept != links:
                    # Clear cached decision payload as well as the public links.
                    table.update(
                        where=f"document_id = {_literal(row['document_id'])}",
                        values={"links_json": json.dumps(kept), "organization_json": "{}"},
                    )
            table.delete(f"document_id = {_literal(document_id)}")
        chunks = _table(data_dir, "chunks")
        if chunks is not None:
            chunks.delete(f"document_id = {_literal(document_id)}")
        _organization_names.cache_clear()
        _bump_revision(data_dir, "index")
        _bump_revision(data_dir, "organization")


def recover_deleted_index(data_dir):
    from .storage import current_version

    with INDEX_LOCK:
        table = _table(data_dir, "documents")
        if table is not None:
            ids = table.search().select(["document_id"]).limit(max(1, table.count_rows())).to_list()
            for row in ids:
                if current_version(data_dir, row["document_id"]) is None:
                    remove_document(data_dir, row["document_id"])
