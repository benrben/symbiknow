import base64
import threading

import pytest

from symbiknow.core.application import ApplicationContext, ApplicationSettings
from symbiknow.api.agents.symbiknow import ProductTools
from symbiknow.organization import edits


@pytest.fixture
def product(tmp_path):
    app = ApplicationContext(tmp_path, settings=ApplicationSettings(storage_only=True))
    return ProductTools(app)


def upload(product, text=b"original"):
    return product.app.transfers.upload(
        [{"filename": "test.txt", "content_base64": base64.b64encode(text).decode()}]
    )["files"][0]


def test_upload_preview_then_commit(product):
    args = {
        "files": [{"filename": "test.txt", "content_base64": base64.b64encode(b"text").decode()}]
    }
    preview = product.preview("upload", args)
    assert preview["changes"][0]["after"]["size"] == 4
    result = product.write("upload", args, preview)
    assert result["files"][0]["stored"] is True


def test_stale_delete_preview_never_deletes_new_version(product):
    doc = upload(product)
    args = {"document_id": doc["document_id"], "expected_version": doc["version"]}
    preview = product.preview("remove_file", args)
    product.app.transfers.upload(
        [{**args, "filename": "test.txt", "content_base64": base64.b64encode(b"updated").decode()}]
    )
    with pytest.raises(ValueError):
        product.write("remove_file", args, preview)
    assert product.app.originals.metadata(doc["document_id"])["version"] == "v2"


def test_product_preview_cannot_be_replaced(product):
    doc = upload(product)
    args = {"document_id": doc["document_id"], "expected_version": doc["version"]}
    preview = product.preview("remove_file", args)
    preview["files"] = []
    with pytest.raises(ValueError):
        product.write("remove_file", args, preview)
    assert product.app.originals.metadata(doc["document_id"])


def test_registry_all_writes_use_approval_and_browser_validates_versions(product):
    tools = {t.name: t for t in product.registry()}
    for name in (
        "upload",
        "upload_folder",
        "remove_file",
        "move_documents",
        "rename_folder",
        "resolve_jev_decision",
        "review_freshness_finding",
        "scan_freshness",
        "cancel_freshness_scan",
    ):
        assert tools[name].kind == "approval" and tools[name].preview
    doc = upload(product)
    with pytest.raises(ValueError):
        product.browser("open_document", {"document_id": doc["document_id"], "version": "v99"})


def test_display_projection_keeps_bytes_out_of_cards_and_preserves_preview():
    from symbiknow.api.agents.symbiknow import display_payload

    original = {
        "args": {"files": [{"content_base64": "abcd"}]},
        "result": {"text": "x" * 9000},
        "preview": {"files": ["unchanged"]},
    }
    projected = display_payload(original)
    assert "base64 characters" in projected["args"]["files"][0]["content_base64"]
    assert projected["result"]["text"].endswith("[truncated in chat]")
    assert projected["preview"] == original["preview"]
    assert original["args"]["files"][0]["content_base64"] == "abcd"


def test_folder_upload_preview_matches_effective_name_and_metadata(product):
    import uuid

    args = {
        "folder": "Project",
        "request_id": str(uuid.uuid4()),
        "files": [
            {
                "relative_path": "Notes/plan.txt",
                "source": "Review notes",
                "content_base64": base64.b64encode(b"new").decode(),
            }
        ],
    }
    preview = product.preview("upload_folder", args)
    after = preview["changes"][0]["after"]
    assert after["filename"] == "plan.txt" and after["folder"] == "Project / Notes"
    assert after["mime_type"] == "text/plain" and after["source"] == "Review notes"
    result = product.write("upload_folder", args, preview)
    saved = result["files"][0]
    assert saved["stored"] and saved["filename"] == after["filename"]
    assert saved["mime_type"] == after["mime_type"] and saved["source"] == after["source"]


def test_ui_actions_are_browser_round_trips_with_bounded_schemas(product):
    from symbiknow.api.agents.bridge.schema import validate

    tools = {tool.name: tool for tool in product.registry()}
    valid = {
        "show_search": {"query": "needle", "mode": "grep"},
        "clear_search": {},
        "navigate": {"scope": "group", "group": "Team"},
        "set_library_view": {"view": "grid", "sort": "date", "descending": True},
        "set_reader_view": {"tab": "versions", "expanded": True},
        "close_document": {},
        "scroll_view": {"target": "reader", "direction": "bottom"},
    }
    for name, args in valid.items():
        assert tools[name].kind == "browser"
        validate(args, tools[name].schema)
        assert product.browser(name, args) == args
    for name, args in {
        "show_search": {"query": "x" * 2001},
        "set_reader_view": {"tab": "console"},
        "set_library_view": {"view": "script"},
        "scroll_view": {"target": "body", "direction": "down"},
        "navigate": {"scope": "all", "javascript": "run()"},
    }.items():
        with pytest.raises(ValueError):
            validate(args, tools[name].schema)


def extracted_text(product, doc, texts):
    import json
    from symbiknow.search.index import put_chunks, set_document_status

    put_chunks(
        product.app.DATA_DIR,
        product.app.originals.metadata(doc["document_id"]),
        [
            {
                "chunk_id": f"part-{i:03}",
                "text": text,
                "basis": "original",
                "provenance_json": json.dumps({"page": i + 1}),
                "vector": [1.0, 0.0],
            }
            for i, text in enumerate(texts)
        ],
        "fixture",
    )
    set_document_status(
        product.app.DATA_DIR,
        product.app.originals.metadata(doc["document_id"]),
        status="indexed",
        indexed_version=doc["version"],
    )


def test_read_document_pages_actual_text_with_provenance_and_bounded_schema(product):
    from symbiknow.api.agents.bridge.schema import validate

    texts = ["First passage. " * 100, "Second passage. " * 100, "Last passage."]
    doc = upload(product, "\n".join(texts).encode())
    extracted_text(product, doc, texts)
    args = {"document_id": doc["document_id"], "version": doc["version"], "max_characters": 1000}
    schema = next(t.schema for t in product.registry() if t.name == "read_document")
    for bad in ({"max_characters": 25000}, {"max_characters": 0}, {"offset": -1}):
        with pytest.raises(ValueError):
            validate({**args, **bad}, schema)
    content, pages = [], []
    while True:
        validate(args, schema)
        page = product.read_document(args)
        pages.append(page)
        assert page["status"] == "ok" and 0 < page["characters_read"] <= 1000
        assert all(
            e["document_id"] == doc["document_id"]
            and e["version"] == "v1"
            and e["provenance"]["page"] >= 1
            for e in page["evidence"]
        )
        content.extend(e["text"] for e in page["evidence"])
        if not page["has_more"]:
            assert page["next_offset"] is None
            break
        args.update(offset=page["next_offset"], evidence_revision=page["evidence_revision"])
    assert "".join(content) == "".join(texts)
    assert len(pages) > 1


def test_read_document_rejects_changed_original_or_same_version_extraction(product):
    doc = upload(product, b"text" * 500)
    extracted_text(product, doc, ["text" * 500])
    args = {"document_id": doc["document_id"], "version": doc["version"], "max_characters": 1000}
    first = product.read_document(args)
    with pytest.raises(ValueError, match="evidence_revision"):
        product.read_document({**args, "offset": first["next_offset"]})
    extracted_text(product, doc, ["new extraction" * 200])
    with pytest.raises(ValueError, match="Extracted text changed"):
        product.read_document(
            {
                **args,
                "offset": first["next_offset"],
                "evidence_revision": first["evidence_revision"],
            }
        )
    product.app.transfers.upload(
        [
            {
                "document_id": doc["document_id"],
                "expected_version": doc["version"],
                "filename": "test.txt",
                "content_base64": base64.b64encode(b"updated").decode(),
            }
        ]
    )
    with pytest.raises(ValueError, match="Document changed"):
        product.read_document(args)


def test_read_document_does_not_claim_unindexed_text_was_read(product):
    doc = upload(product)
    result = product.read_document({"document_id": doc["document_id"], "version": doc["version"]})
    assert result["status"] == "no_text" and result["evidence"] == []
    assert not result["has_more"] and result["characters_read"] == 0


@pytest.mark.parametrize("operation", ["rename_folder", "move_folder"])
@pytest.mark.parametrize("phase", ["preview", "write"])
def test_folder_approvals_allow_concurrent_freshness_reads(product, monkeypatch, operation, phase):
    app = product.app
    doc = upload(product)
    extracted_text(product, doc, ["Folder document"])
    edits.edit("move-documents", {
        "documents": [{"document_id": doc["document_id"], "expected_version": doc["version"]}],
        "folder": "Atlas",
    }, app)
    app.freshness.start([doc["document_id"]])
    args = {"folder": "Atlas", **(
        {"name": "Renamed"} if operation == "rename_folder" else {"destination": "Archive"}
    )}
    preview = product.preview(operation, args)
    freshness_lock = app.freshness.lock
    freshness_locked, approval_waiting = threading.Event(), threading.Event()
    snapshot_acquired, freshness_reads = [], []

    class ObservedLock:
        def __enter__(self):
            approval_waiting.set()
            freshness_lock.acquire()

        def __exit__(self, *_):
            freshness_lock.release()

    monkeypatch.setattr(app.freshness, "lock", ObservedLock())

    def read_freshness():
        with freshness_lock:
            freshness_locked.set()
            if not approval_waiting.wait(5):
                return
            # Freshness reads take their lock before the application snapshot.
            # A bounded acquisition exposes an inversion without hanging pytest.
            acquired = app.write_lock.acquire(timeout=1)
            snapshot_acquired.append(acquired)
            if acquired:
                try:
                    freshness_reads.append(app.freshness.get())
                finally:
                    app.write_lock.release()

    reader = threading.Thread(target=read_freshness)
    reader.start()
    try:
        assert freshness_locked.wait(5)
        if phase == "preview":
            assert product.preview(operation, args) == preview
        else:
            assert product.write(operation, args, preview)["updated"] == 1
    finally:
        reader.join(5)
    assert not reader.is_alive()
    assert snapshot_acquired == [True], "Folder approval inverted the freshness/snapshot lock order"
    assert len(freshness_reads) == 1 and freshness_reads[0]["scan"] is not None
