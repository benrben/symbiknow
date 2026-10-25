"""Slow read preparation is optimistic; final source/evidence guards stay authoritative."""
import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.library import service, storage
from symbiknow.search import index


def evidence(root, metadata, text):
    index.put_chunks(root, metadata, [{
        "chunk_id": metadata["document_id"] + ":t0", "text": text, "basis": "text",
        "provenance_json": "{}", "vector": [1., 0., .1],
    }], "fixture")
    index.set_document_status(root, metadata, status="indexed", indexed_version=metadata["version"],
                              chunk_count=1, searchable_text=True)


def test_history_retries_against_new_head_without_mixing_versions(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    old = storage.save_file(tmp_path, b"old", "file.txt")
    index.register_document(tmp_path, old)
    actual = context.originals.history_page
    heads = []

    def history(identity, **options):
        heads.append(options["head"])
        result = actual(identity, **options)
        if len(heads) == 1:
            newest = storage.save_file(tmp_path, b"new", "file.txt", document_id=identity, expected_version="v1")
            index.register_document(tmp_path, newest)
        return result

    monkeypatch.setattr(context.originals, "history_page", history)
    result = context.library.detail(old["document_id"]).to_wire()
    assert heads == ["v1", "v2"]
    assert result["current_version"] == result["document"]["version"] == result["versions_page"]["head"] == "v2"
    assert [row["version"] for row in result["versions"]] == ["v1", "v2"]


@pytest.mark.parametrize("read", ["detail", "card"])
@pytest.mark.parametrize("change", ["replace-evidence", "delete"])
def test_read_revalidates_prepared_evidence(tmp_path, monkeypatch, read, change):
    context = ApplicationContext(tmp_path)
    metadata = storage.save_file(tmp_path, b"original", "file.txt")
    index.register_document(tmp_path, metadata)
    evidence(tmp_path, metadata, "old passage")
    actual = service.document_evidence
    calls = []

    def sample(*args, **kwargs):
        rows = actual(*args, **kwargs)
        calls.append(rows)
        if len(calls) == 1:
            if change == "delete":
                context.library.delete_item("delete-document", {"document_id": metadata["document_id"], "expected_version": "v1"})
            else:
                evidence(tmp_path, metadata, "new passage")
        return rows

    monkeypatch.setattr(service, "document_evidence", sample)
    operation = getattr(context.library, read)
    if change == "delete":
        with pytest.raises(FileNotFoundError):
            operation(metadata["document_id"], "v1")
    else:
        result = operation(metadata["document_id"], "v1").to_wire()
        assert len(calls) == 2
        assert result["evidence"][0]["text"] == "new passage"


def test_csv_card_does_not_return_bytes_deleted_during_preparation(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    metadata = storage.save_file(tmp_path, b"name,value\nprivate,1", "file.csv")
    index.register_document(tmp_path, metadata)
    actual = storage._RangeReader.read

    def read(reader, offset, length):
        value = actual(reader, offset, length)
        context.library.delete_item("delete-document", {"document_id": metadata["document_id"], "expected_version": "v1"})
        return value

    monkeypatch.setattr(storage._RangeReader, "read", read)
    with pytest.raises(FileNotFoundError):
        context.library.card(metadata["document_id"], "v1")


def test_card_guards_evidence_without_resolving_organization(tmp_path, monkeypatch):
    """Many visible cards must not repeatedly validate the relationship graph."""
    from symbiknow.organization import store

    context = ApplicationContext(tmp_path)
    metadata = storage.save_file(tmp_path, b"original", "file.txt")
    index.register_document(tmp_path, metadata)
    evidence(tmp_path, metadata, "current passage")

    def unrelated_overlay(*args, **kwargs):
        pytest.fail("Card evidence must not read organization or its neighbors")

    monkeypatch.setattr(store, "overlay", unrelated_overlay)
    result = context.library.card(metadata["document_id"], "v1").to_wire()
    assert result["evidence"][0]["text"] == "current passage"


@pytest.mark.parametrize("section", ["summary", "full"])
def test_detail_and_connections_share_one_organization_read(tmp_path, monkeypatch, section):
    from symbiknow.organization import store

    context = ApplicationContext(tmp_path)
    metadata = storage.save_file(tmp_path, b"original", "file.txt")
    index.register_document(tmp_path, metadata)
    evidence(tmp_path, metadata, "current passage")
    actual = store.overlay
    reads = []

    def counted(root, rows, **kwargs):
        reads.append([row["document_id"] for row in rows])
        return actual(root, rows, **kwargs)

    monkeypatch.setattr(store, "overlay", counted)
    result = context.library.detail(metadata["document_id"], "v1", section).to_wire()
    assert result["organization"]["document_id"] == metadata["document_id"]
    assert result["connections"] == []
    assert reads == [[metadata["document_id"]]]
