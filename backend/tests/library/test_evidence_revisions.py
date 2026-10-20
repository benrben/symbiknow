"""Same-head extraction boundaries bind organization and every neighbor dependency."""
import hashlib
import json

import pyarrow as pa
import pytest

from symbiknow.organization import edits as organization_edits
from symbiknow.organization import store as organization_store
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.api import http as ui
from tests.api.test_ui_api import context as context, indexed, decision


def rows(root, document):
    return search._table(root, "chunks").search().where(
        f"document_id = '{document['document_id']}'"
    ).select(["chunk_id", "text", "basis", "provenance_json", "vector"]).limit(100).to_list()


def reextract(root, document, change="text"):
    chunks = rows(root, document)
    if change == "text":
        chunks[0]["text"] = "cat changed extraction under the same committed head"
    elif change == "provenance":
        chunks[0]["provenance_json"] = json.dumps({"page": 77, "headings": ["Changed structure"]})
    model = "changed-processing-model" if change == "model" else "test-only-fixture"
    return search.put_chunks(root, document, chunks, model)


@pytest.mark.parametrize("change", ["text", "provenance", "model"])
def test_same_head_epoch_invalidates_automatic_folder_and_preserves_manual(context, change):
    root, _, _ = context
    doc = indexed(root)
    original, _ = storage.read_file(root, doc["document_id"])
    search.save_organization(root, doc["document_id"], "v1", decision("Automatic"))
    before = search.get_document_status(root, doc["document_id"])["evidence_revision"]
    after = reextract(root, doc, change)
    row = search.get_document_status(root, doc["document_id"])
    assert before and after and before != after and row["evidence_revision"] == after
    assert row["version"] == "v1" and row["folder"] == "" and row["organization_status"] == "pending"
    assert search.browse_documents(root, folder="Automatic")["total"] == 0
    assert not search.find_documents(root, "cat", mode="keyword", folder="Automatic")
    with pytest.raises(ValueError, match="source evidence changed"):
        search.save_organization(root, doc["document_id"], "v1", {**decision("Stale"), "evidence_revision": before})
    organization_edits.edit("move-documents", {"folder": "Manual", "documents": [
        {"document_id": doc["document_id"], "expected_version": "v1"}]})
    reextract(root, doc, "provenance" if change != "provenance" else "text")
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Manual"
    assert storage.read_file(root, doc["document_id"])[0] == original
    assert len(storage.list_versions(root, doc["document_id"])) == 1


@pytest.mark.parametrize("change", ["text", "provenance"])
def test_same_head_target_change_invalidates_connections_search_and_folder_views(context, change):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    source, target = indexed(root), indexed(root, name="target.txt")
    target_epoch = search.get_document_status(root, target["document_id"])["evidence_revision"]
    link = {"document_id": target["document_id"], "version": "v1", "source_version": "v1", "relation": "related",
            "source_chunk_id": f"{source['document_id']}:v1:t0", "target_chunk_id": f"{target['document_id']}:v1:t0"}
    search.save_organization(root, source["document_id"], "v1", decision("Depends on target", links=[link]))
    assert ui.connections(source["document_id"], "v1")
    reextract(root, target, change)
    assert search.get_document_status(root, source["document_id"])["folder"] == ""
    assert search.get_document_status(root, source["document_id"])["organization_status"] == "pending"
    assert not ui.connections(source["document_id"], "v1")
    assert not server.application().library.detail(source["document_id"], "v1").to_wire()["connections"]
    assert search.browse_documents(root, folder="Depends on target")["total"] == 0
    result = server.search_full("cat", mode="keyword")
    assert all(not match["links"] for match in result["matches"])
    # A rejected neighbor can still influence a provider's folder decision.
    with pytest.raises(ValueError, match="supporting evidence changed"):
        search.save_organization(root, source["document_id"], "v1", {
            **decision("Old context"), "dependency_evidence_revisions": {target["document_id"]: target_epoch}})


def test_same_head_change_during_candidate_validation_requires_bounded_refresh(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    original = storage.heads_many
    changed = []
    def racing(root, identities):
        if not changed:
            changed.append(True)
            reextract(root, doc, "provenance")
        return original(root, identities)
    monkeypatch.setattr(storage, "heads_many", racing)
    with pytest.raises(search.IndexChangedError):
        search.find_documents(root, "cat", mode="keyword", folder="Old")
    assert not search.find_documents(root, "cat", mode="keyword", folder="Old")


def test_model_only_target_change_during_provider_rejects_dependent_judgment(context):
    from symbiknow.ai import jev
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    source, target = indexed(root), indexed(root, name="target.txt")
    before = rows(root, target)

    def provider(query, matches, **kwargs):
        target_match = next(match for match in matches if match["document_id"] == target["document_id"])
        passage = target_match["evidence"][0]
        dependency = {"document_id": target["document_id"], "version": "v1",
                      "chunk_id": passage["evidence_id"], "text_start": 0, "text_end": len(passage["text"]),
                      "sha256": hashlib.sha256(passage["text"].encode()).hexdigest()}
        for match in matches:
            ref = match["evidence"][0]["evidence_id"]
            match["jev"] = {"status": "evaluated", "label": "direct", "coverage": "complete",
                            "supporting_chunk_ids": [ref], "verification_dependencies": [dependency]}
        reextract(root, target, "model")
        return {"status": "evaluated", "matches": matches}

    monkeypatch.setattr(jev, "judge_matches", provider)
    refreshed = []
    refresh = server.application().search.refresh
    def record_refresh(*args, **kwargs):
        result = refresh(*args, **kwargs)
        refreshed.extend(result[0])
        return result
    monkeypatch.setattr(server.application().search, "refresh", record_refresh)
    result = server.search_full("cat", mode="keyword", evaluate=True)
    assert not result["matches"]
    retained = next(match for match in refreshed if match["document_id"] == source["document_id"])
    assert retained["jev"] == {"status": "not_evaluated", "reason": "evidence_changed"}
    assert rows(root, target) == before  # Only the processing descriptor changed.


def test_interrupted_same_head_chunk_replacement_revokes_old_completion_receipt(context):
    from symbiknow.library.evidence import receipt
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    original = rows(root, doc)
    schema = pa.schema([search.chunk_schema(3).field(name) for name in
                        ("chunk_id", "text", "basis", "provenance_json", "vector")])

    def interrupted():
        yield pa.RecordBatch.from_pylist([{**original[0], "text": "partially replaced"}], schema=schema)
        raise RuntimeError("interrupted producer")

    reader = pa.RecordBatchReader.from_batches(schema, interrupted())
    with pytest.raises(RuntimeError, match="interrupted producer"):
        search.put_chunks(root, doc, reader, "test-only-fixture")
    assert receipt(root, doc["document_id"])["state"] == "preparing"
    assert search.get_document_status(root, doc["document_id"])["status"] == "pending"
    with pytest.raises(ValueError, match="before chunk completion"):
        search.set_document_status(root, doc, status="indexed", indexed_version="v1")
    assert not search.find_documents(root, "cat", mode="keyword")
    epoch = search.put_chunks(root, doc, original, "test-only-fixture")
    recovered = search.set_document_status(root, doc, status="indexed", indexed_version="v1", chunk_count=1)
    assert recovered["evidence_revision"] == epoch
    assert search.find_documents(root, "cat", mode="keyword")


def test_rejected_neighbor_head_change_before_registration_invalidates_decision_and_filter_cache(context):
    root, _, _ = context
    source, target = indexed(root), indexed(root, name="target.txt")
    epoch = search.get_document_status(root, target["document_id"])["evidence_revision"]
    decision_with_context = {**decision("Neighbor context"),
                             "dependency_evidence_revisions": {target["document_id"]: epoch}}
    search.save_organization(root, source["document_id"], "v1", decision_with_context)
    assert search.browse_documents(root, folder="Neighbor context")["total"] == 1
    storage.save_file(root, b"new target head before derived registration", "target.txt", document_id=target["document_id"])
    assert search.get_document_status(root, source["document_id"])["folder"] == ""
    assert search.browse_documents(root, folder="Neighbor context")["total"] == 0
    assert not search.find_documents(root, "cat", mode="keyword", folder="Neighbor context")
    with pytest.raises(ValueError, match="supporting evidence changed"):
        search.save_organization(root, source["document_id"], "v1", decision_with_context)


def test_streaming_digest_is_independent_of_batch_boundaries(context):
    root, _, _ = context
    doc = indexed(root)
    values = rows(root, doc)
    first = search.put_chunks(root, doc, values, "test-only-fixture")
    schema = pa.schema([search.chunk_schema(3).field(name) for name in
                        ("chunk_id", "text", "basis", "provenance_json", "vector")])
    reader = pa.RecordBatchReader.from_batches(schema, [pa.RecordBatch.from_pylist(values, schema=schema)])
    second = search.put_chunks(root, doc, reader, "test-only-fixture")
    assert first == second
    completed = search.set_document_status(root, doc, status="indexed", indexed_version="v1", chunk_count=len(values))
    assert completed["evidence_revision"] == second


@pytest.mark.parametrize("operation", ["pending", "chunks"])
def test_dependency_invalidation_callback_receives_only_affected_ids(context, operation):
    root, _, _ = context
    source, target = indexed(root), indexed(root, name="target.txt")
    epoch = search.get_document_status(root, target["document_id"])["evidence_revision"]
    search.save_organization(root, source["document_id"], "v1", {
        **decision("Neighbor context"), "dependency_evidence_revisions": {target["document_id"]: epoch}})
    called = []
    if operation == "pending":
        result = search.mark_pending(root, target, on_invalidate=called.append)
        assert result["status"] == "pending"
        search.mark_pending(root, target, on_invalidate=called.append)
    else:
        values = rows(root, target)
        values[0]["text"] = "changed target context"
        result = search.put_chunks(root, target, values, "test-only-fixture", on_invalidate=called.append)
        assert isinstance(result, str)
        search.put_chunks(root, target, values, "test-only-fixture", on_invalidate=called.append)
    assert called == [(source["document_id"],)]


def test_chunk_schema_upgrade_drops_filter_columns_without_copying_vector_files(context):
    from lancedb.index import BTree
    root, _, _ = context
    indexed(root)
    table = search._db(root).open_table("chunks")
    table.add_columns({"folder": "cast('Old' as string)", "groups": "arrow_cast([], 'List(Utf8)')"})
    table.create_index("folder", config=BTree())
    data = root / "index/chunks.lance/data"
    before = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in data.rglob("*") if file.is_file()}
    migrated = search._table(root, "chunks")
    assert not {"folder", "groups"}.intersection(migrated.schema.names)
    assert all("folder" not in index.columns for index in migrated.list_indices())
    assert {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in data.rglob("*") if file.is_file()} == before
    assert before and json.loads((root / "index/derived-schema.json").read_text())["schema"] == 2


def test_legacy_empty_evidence_epoch_only_applies_until_first_reindex(context):
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Legacy"))
    published = organization_store.manifest(root)
    org = search._db(root).open_table(published["table"])
    org.update(values={"evidence_revision": ""})
    docs = search._table(root, "documents")
    docs.update(values={"evidence_revision": ""})
    organization_edits.atomic(root / "temp/organization-published.json", {**published, "version": org.version})
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Legacy"
    reextract(root, doc, "provenance")
    assert search.get_document_status(root, doc["document_id"])["folder"] == ""
