"""Real OCFL/LanceDB UI contracts; provider decisions are deterministic test fixtures."""

import base64
import json
import uuid

import pytest
from starlette.testclient import TestClient

from app import rebuild, search, server, storage, ui
from app.ingest import index_document
from test_search import FixtureEmbedder


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr("app.jev.preflight", lambda: None)
    monkeypatch.setattr(server, "STORAGE_ONLY", True)
    server.stop.clear()
    storage.init_storage(tmp_path)
    monkeypatch.setattr(search, "get_embedder", lambda: FixtureEmbedder())
    return tmp_path, monkeypatch, TestClient(ui.create_app(), base_url="http://127.0.0.1")


def add(root, name="notes.txt", content=b"cat rests", **kwargs):
    meta = storage.save_file(root, content, name, **kwargs)
    search.register_document(root, meta)
    return meta


def indexed(root, **kwargs):
    meta = add(root, **kwargs)
    content, _ = storage.read_file(root, meta["document_id"])
    index_document(root, meta, content, FixtureEmbedder())
    return meta


def mutate(client, action, body, **kwargs):
    return client.post(
        "/api/" + action,
        json=body,
        headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"},
        **kwargs,
    )


def decision(folder="Fresh", groups=None, links=None):
    return {
        "status": "evaluated",
        "folder": folder,
        "groups": groups or ["new"],
        "links": links or [],
    }


def test_listing_pagination_pending_unsupported_recent(context):
    root, _, client = context
    a = add(root)
    b = add(root, "data.bin", b"\x00\xff")
    search.set_document_status(root, b, status="unsupported")
    response = client.get("/api/library?limit=1&recent=true").json()
    assert response["total"] == 2 and response["has_more"]
    assert response["documents"][0]["document_id"] == b["document_id"]
    assert response["documents"][0]["status"] == "unsupported"
    assert "source" not in response["documents"][0]
    remaining = client.get("/api/library?limit=1&offset=1&recent=true").json()
    assert remaining["documents"][0]["document_id"] == a["document_id"]
    assert not remaining["has_more"]
    assert client.get("/api/library?limit=101").status_code == 400


@pytest.mark.parametrize("mode", ["keyword", "semantic", "hybrid"])
def test_search_preserves_saved_version_date_across_ui_and_mcp(context, mode):
    root, monkeypatch, client = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    first = indexed(root, name="dated.txt", content=b"cat first version")
    latest = indexed(
        root, name="dated.txt", content=b"cat current version",
        document_id=first["document_id"], expected_version=first["version"],
    )
    browsed = client.get("/api/library").json()["documents"][0]
    response = mutate(client, "search", {"query": "cat", "mode": mode, "evaluate": False})
    assert response.status_code == 200
    results = [response.json()]
    for detail in ("full", "compact"):
        results.append(server.search("cat", mode=mode, detail=detail))
    for result in results:
        hit = result["matches"][0]
        assert hit["version"] == browsed["version"] == latest["version"] == "v2"
        assert hit["created_at"] == browsed["created_at"] == latest["created_at"]


def test_browser_transfer_replay_update_history_exact_bytes(context):
    root, _, client = context
    request_id = str(uuid.uuid4())
    item = {
        "filename": "original.bin",
        "content_base64": base64.b64encode(b"\x00\xffold").decode(),
        "request_id": request_id,
    }
    old = mutate(client, "upload", {"files": [item]}).json()["files"][0]
    assert old["stored"]
    assert mutate(client, "upload", {"files": [item]}).json()["files"][0]["version"] == "v1"
    new = {
        **item,
        "document_id": old["document_id"],
        "expected_version": "v1",
        "request_id": str(uuid.uuid4()),
        "content_base64": base64.b64encode(b"new\x00").decode(),
    }
    assert mutate(client, "upload", {"files": [new]}).json()["files"][0]["version"] == "v2"
    old_bytes = client.get("/api/download", params={"id": old["document_id"], "version": "v1"})
    assert old_bytes.content == b"\x00\xffold"
    assert "filename*=UTF-8''original.bin" in old_bytes.headers["content-disposition"]
    detail = client.get("/api/document", params={"id": old["document_id"], "version": "v1"}).json()
    assert (
        detail["organization"] is None and detail["evidence"] == [] and detail["connections"] == []
    )
    assert [v["version"] for v in detail["versions"]] == ["v1", "v2"]
    conflict = mutate(
        client, "upload", {"files": [{**new, "request_id": str(uuid.uuid4())}]}
    ).json()["files"][0]
    assert not conflict["stored"] and "Expected v1" in conflict["error"]
    assert storage.read_file(root, old["document_id"])[0] == b"new\x00"


@pytest.mark.parametrize(
    "headers",
    [{}, {"Origin": "http://evil.example", "X-Symbiknow-UI": "1"}, {"Origin": "http://127.0.0.1"}],
)
def test_ui_writes_require_same_origin_and_header(context, headers):
    _, _, client = context
    assert client.post("/api/upload", json={"files": []}, headers=headers).status_code == 403
    assert client.get("/api/library", headers={"Host": "evil.example"}).status_code == 403


def test_active_original_is_attachment(context):
    root, _, client = context
    meta = add(root, "evil.html", b'<script>window.parent.location="https://evil.example"</script>')
    r = client.get("/api/original", params={"id": meta["document_id"], "version": "v1"})
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["content-type"] == "application/octet-stream"
    assert "sandbox" in r.headers["content-security-policy"]


def test_links_direction_evidence_and_stale_endpoints(context):
    root, _, client = context
    source, target = indexed(root), indexed(root, name="other.txt")
    se = search.document_evidence(root, source["document_id"], "v1")[0]
    te = search.document_evidence(root, target["document_id"], "v1")[0]
    link = {
        "document_id": target["document_id"],
        "version": "v1",
        "source_version": "v1",
        "relation": "supports",
        "source_chunk_id": se["evidence_id"],
        "target_chunk_id": te["evidence_id"],
    }
    search.save_organization(root, source["document_id"], "v1", decision(links=[link]))
    assert (
        ui.connections(target["document_id"], "v1")[0]["source_document_id"]
        == source["document_id"]
    )
    evidence = ui.link_evidence(
        source["document_id"],
        "v1",
        target["document_id"],
        "v1",
        se["evidence_id"],
        te["evidence_id"],
    )
    assert evidence["source"][0]["text"] == "cat rests"
    add(root, document_id=target["document_id"], content=b"cat changed")
    assert ui.connections(source["document_id"], "v1") == []
    with pytest.raises(ValueError, match="superseded endpoint"):
        search.save_organization(root, source["document_id"], "v1", decision(links=[link]))


@pytest.mark.parametrize("grouping,links", [(True, False), (False, True), (True, True)])
def test_selective_reset_and_durable_restart(context, grouping, links):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    meta, other = indexed(root), indexed(root, name="outside.txt")
    link = {
        "document_id": other["document_id"],
        "source_chunk_id": f"{meta['document_id']}:v1:t0",
        "target_chunk_id": f"{other['document_id']}:v1:t0",
        "version": "v1",
        "source_version": "v1",
        "relation": "related",
    }
    search.save_organization(root, meta["document_id"], "v1", decision("Old", ["old"], [link]))
    search.save_organization(root, other["document_id"], "v1", decision("Outside"))
    seen = []

    def organize(*args, **kwargs):
        seen.append(kwargs["folders"])
        return decision()

    monkeypatch.setattr("app.jev.organize_document", organize)
    server.organization_attempts.add((meta["document_id"], "v1"))
    queued = rebuild.request(folder="Old", grouping=grouping, links=links)
    assert queued["document_ids"] == [meta["document_id"]]
    assert (meta["document_id"], "v1") not in server.organization_attempts
    # All request state comes from disk; restart needs no in-memory queue.
    assert rebuild.process_one()
    assert not rebuild.process_one()
    row = search.get_document_status(root, meta["document_id"])
    assert row["folder"] == ("Fresh" if grouping else "Old")
    assert row["groups"] == (["new"] if grouping else ["old"])
    assert json.loads(row["links_json"]) == ([] if links else [link])
    assert len(seen) == 1 and "Outside" in seen[0] and "Old" not in seen[0]
    assert len(storage.list_versions(root, meta["document_id"])) == 1
    assert rebuild.status()["status"] == "completed"
    if grouping:
        assert search.browse_documents(root, folder="Fresh")["total"] == 1
        assert search.find_documents(root, "cat", mode="keyword", folder="Fresh")


def test_reset_failure_clears_and_retry_recovers(context):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    meta = indexed(root)
    search.save_organization(root, meta["document_id"], "v1", decision("Old"))
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: {"status": "unavailable"})
    rebuild.request()
    with pytest.raises(ValueError, match="already running"):
        rebuild.request()
    rebuild.process_one()
    rebuild.process_one()
    assert rebuild.status()["status"] == "partial_failure"
    assert search.get_document_status(root, meta["document_id"])["folder"] == ""
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: decision())
    rebuild.request(retry=True)
    rebuild.process_one()
    rebuild.process_one()
    assert search.get_document_status(root, meta["document_id"])["folder"] == "Fresh"
    assert storage.read_file(root, meta["document_id"])[0] == b"cat rests"


@pytest.mark.parametrize("fail_after_update", [False, True])
def test_reset_upload_during_provider_call_retries_latest(context, fail_after_update):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    meta = indexed(root)

    def upload_during_call(*args, **kwargs):
        new = add(root, document_id=meta["document_id"], content=b"cat latest")
        index_document(root, new, b"cat latest", FixtureEmbedder())
        return {"status": "unavailable"} if fail_after_update else decision("stale")

    monkeypatch.setattr("app.jev.organize_document", upload_during_call)
    rebuild.request()
    rebuild.process_one()
    assert rebuild.status()["completed_ids"] == []
    assert rebuild.status()["failures"] == {}
    assert search.get_document_status(root, meta["document_id"])["folder"] != "stale"
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: decision("Latest"))
    rebuild.process_one()
    assert search.get_document_status(root, meta["document_id"])["version"] == "v2"
    assert search.get_document_status(root, meta["document_id"])["folder"] == "Latest"
    assert storage.read_file(root, meta["document_id"], "v1")[0] == b"cat rests"


def test_missing_credentials_and_empty_selection_leave_organization(context):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    meta = indexed(root)
    search.save_organization(root, meta["document_id"], "v1", decision("Old"))
    with pytest.raises(ValueError, match="Jev is unavailable"):
        rebuild.request()
    with pytest.raises(ValueError, match="Select"):
        rebuild.request(grouping=False, links=False)
    assert search.get_document_status(root, meta["document_id"])["folder"] == "Old"


def test_version_keyed_thumbnail_is_derived_and_original_bytes_survive(context):
    from io import BytesIO
    from PIL import Image

    root, _, client = context
    buffer = BytesIO()
    Image.new("RGB", (800, 800), "red").save(buffer, "PNG")
    metadata = add(root, "photo.png", buffer.getvalue())
    response = client.get("/api/thumbnail", params={"id": metadata["document_id"], "version": "v1"})
    assert response.headers["content-type"] == "image/jpeg"
    with Image.open(BytesIO(response.content)) as image:
        assert image.width <= 264 and image.height <= 340
    assert storage.read_file(root, metadata["document_id"])[0] == buffer.getvalue()
    assert len(list((root / "temp" / "thumbnails").glob("*.jpg"))) == 1
    assert (
        client.get("/api/thumbnail", params={"id": "../../secret", "version": "v1"}).status_code
        == 400
    )


def test_interrupted_filter_publication_restores_previous_organization(context):
    root, _, _ = context
    metadata = indexed(root)
    search.save_organization(root, metadata["document_id"], "v1", decision("Old", ["old"]))
    # Simulate a process exit after chunks are prepared, before document publish.
    row = search.get_document_status(root, metadata["document_id"])
    search._set_chunk_filters(root, {**row, "folder": "Unpublished", "groups": ["new"]})
    assert not search.find_documents(root, "cat", mode="keyword", folder="Old")
    search.recover_organization_filters(root)
    assert search.find_documents(root, "cat", mode="keyword", folder="Old", group="old")
    assert search.get_document_status(root, metadata["document_id"])["folder"] == "Old"
    assert len(storage.list_versions(root, metadata["document_id"])) == 1


def test_upload_schedules_linked_source_organization_without_losing_listing(context):
    root, monkeypatch, client = context
    source, target = indexed(root), indexed(root, name="target.txt")
    search.save_organization(
        root,
        source["document_id"],
        "v1",
        decision(
            "Old",
            links=[
                {
                    "document_id": target["document_id"],
                    "source_chunk_id": f"{source['document_id']}:v1:t0",
                    "target_chunk_id": f"{target['document_id']}:v1:t0",
                    "version": "v1",
                    "source_version": "v1",
                    "relation": "related",
                }
            ],
        ),
    )
    server.organization_attempts.add((source["document_id"], "v1"))
    result = mutate(
        client,
        "upload",
        {
            "files": [
                {
                    "filename": "target.txt",
                    "document_id": target["document_id"],
                    "expected_version": "v1",
                    "request_id": str(uuid.uuid4()),
                    "content_base64": base64.b64encode(b"cat updated").decode(),
                }
            ]
        },
    ).json()["files"][0]
    assert result["stored"] and result["version"] == "v2"
    assert search.get_document_status(root, target["document_id"])["version"] == "v2"
    assert (
        search.get_document_status(root, source["document_id"])["organization_status"] == "pending"
    )
    assert (source["document_id"], "v1") not in server.organization_attempts


def test_failed_filter_write_restores_previous_valid_fields(context):
    root, monkeypatch, _ = context
    metadata = indexed(root)
    search.save_organization(root, metadata["document_id"], "v1", decision("Old", ["old"]))
    original = search._set_chunk_filters
    attempts = []

    def interrupted(data, row):
        original(data, row)
        attempts.append(row["folder"])
        if len(attempts) == 1:
            raise RuntimeError("Simulated interrupted publication response")

    monkeypatch.setattr(search, "_set_chunk_filters", interrupted)
    with pytest.raises(RuntimeError):
        search.save_organization(root, metadata["document_id"], "v1", decision("Fresh"))
    assert attempts == ["Fresh", "Old"]
    assert search.get_document_status(root, metadata["document_id"])["folder"] == "Old"
    assert search.find_documents(root, "cat", mode="keyword", folder="Old", group="old")


def test_delete_document_removes_all_versions_links_and_index_with_version_guard(context):
    root, _, client = context
    target = indexed(root, name="target.txt", content=b"cat original")
    new = add(root, name="target.txt", content=b"cat latest", document_id=target["document_id"])
    index_document(root, new, b"cat latest", FixtureEmbedder())
    source = indexed(root, name="source.txt")
    search.save_organization(
        root,
        source["document_id"],
        "v1",
        decision(
            "Kept",
            links=[
                {
                    "document_id": target["document_id"],
                    "source_chunk_id": f"{source['document_id']}:v1:t0",
                    "target_chunk_id": f"{target['document_id']}:v2:t0",
                    "source_version": "v1",
                    "version": "v2",
                    "relation": "related",
                }
            ],
        ),
    )
    body = {"document_id": target["document_id"], "expected_version": "v1"}
    assert mutate(client, "delete-document", body).status_code == 400
    assert len(storage.list_versions(root, target["document_id"])) == 2
    body["expected_version"] = "v2"
    assert client.post("/api/delete-document", json=body).status_code == 403
    assert mutate(client, "delete-document", body).status_code == 200
    assert mutate(client, "delete-document", body).status_code == 200  # Lost-response retry.
    for version in ("v1", "v2"):
        assert (
            client.get(
                "/api/download", params={"id": target["document_id"], "version": version}
            ).status_code
            == 404
        )
    assert search.get_document_status(root, target["document_id"]) is None
    assert search.browse_documents(root)["total"] == 1
    assert json.loads(search.get_document_status(root, source["document_id"])["links_json"]) == []
    assert not search._table(root, "chunks").count_rows(f"document_id = '{target['document_id']}'")
    with pytest.raises(storage.VersionConflict, match="deleted"):
        storage.save_file(root, b"cat original", "target.txt", document_id=target["document_id"])
    assert storage.read_file(root, source["document_id"])[0] == b"cat rests"


def test_delete_parent_folder_preserves_bytes_history_links_and_outside_scope(context):
    root, _, client = context
    a, b, outside = (
        indexed(root),
        indexed(root, name="second.txt"),
        indexed(root, name="outside.txt"),
    )
    folders = ["Atlas % _ / Storage", "Atlas % _ / Search", "Atlas % _ extra / Storage"]
    for doc, folder in zip([a, b, outside], folders):
        search.save_organization(root, doc["document_id"], "v1", decision(folder, ["kept"]))
    before = {
        doc["document_id"]: storage.list_versions(root, doc["document_id"])
        for doc in [a, b, outside]
    }
    assert client.get("/api/library", params={"folder": "Atlas % _"}).json()["total"] == 2
    assert search.find_documents(root, "cat", mode="keyword", folder="Atlas % _")
    response = mutate(client, "delete-folder", {"folder": "Atlas % _"})
    assert response.json()["moved_to_unfiled"] == 2
    assert search.organization_catalog(root)["folders"] == [folders[2]]
    assert search.browse_documents(root, folder="")["total"] == 2
    for doc in [a, b, outside]:
        identity = doc["document_id"]
        assert storage.list_versions(root, identity) == before[identity]
        assert storage.read_file(root, identity)[0] == b"cat rests"
        assert search.get_document_status(root, identity)["groups"] == ["kept"]
    assert client.get("/api/library").json()["organization_revision"]
    assert mutate(client, "delete-folder", {"folder": ""}).status_code == 400


def test_delete_during_indexing_cannot_resurrect_document(context):
    from app import ingest

    root, monkeypatch, _ = context
    meta = add(root)

    def extract(*args):
        ui.delete_item(
            "delete-document", {"document_id": meta["document_id"], "expected_version": "v1"}
        )
        return [], [], []

    monkeypatch.setattr(ingest, "extract_units", extract)
    assert (
        ingest.index_document(root, meta, b"cat rests", FixtureEmbedder())["status"] == "superseded"
    )
    assert search.get_document_status(root, meta["document_id"]) is None


def test_interrupted_delete_recovers_without_restoring_old_upload(context):
    root, monkeypatch, _ = context
    meta = indexed(root)
    run = storage._run

    def interrupted(data, *args, **kwargs):
        if args[0] == "purge":
            raise storage.StorageError("Interrupted purge")
        return run(data, *args, **kwargs)

    monkeypatch.setattr(storage, "_run", interrupted)
    with pytest.raises(storage.StorageError):
        storage.delete_document(root, meta["document_id"], "v1")
    monkeypatch.setattr(storage, "_run", run)
    storage.recover_deletions(root)
    search.recover_deleted_index(root)
    assert storage.current_version(root, meta["document_id"]) is None
    assert search.get_document_status(root, meta["document_id"]) is None


def test_reset_shared_taxonomy_skips_and_repeatability_preserve_originals(context):
    root, monkeypatch, client = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    fixtures = [
        ("Atlas / Storage", "Approved policy", "Keep all original versions."),
        ("Atlas / Storage", "Rejected proposal", "Rejected: delete old versions after seven days."),
        ("Atlas / Storage", "Restore runbook", "Retrieve originals by version and verify hashes."),
        ("Atlas / Search", "Retrieval design", "Combine keyword and semantic retrieval."),
        ("Atlas / Search", "Acceptance checks", "Test exact identifiers and paraphrases."),
        ("Cedar Shop / Customer support", "Returns", "Returns within thirty days with a receipt."),
        (
            "Cedar Shop / Customer support",
            "Warranty",
            "Manufacturing defects covered for two years.",
        ),
        ("Greenhouse / Plant care", "Watering", "Water basil when topsoil is dry."),
    ]
    docs, expected = [], {}
    for i, (topic, heading, body) in enumerate(fixtures):
        meta = indexed(
            root,
            name=f"unhelpful-{i}.txt",
            content=(
                "Shared synthetic QA boilerplate used in unrelated subjects.\n\n"
                + topic
                + " / "
                + heading
                + "\n"
                + body
            ).encode(),
        )
        docs.append(meta)
        expected[meta["document_id"]] = topic
        search.save_organization(
            root, meta["document_id"], "v1", decision("Obsolete filename folder")
        )
    for name, content in [("empty.txt", b""), ("unsupported.bin", b"\x00\xff")]:
        docs.append(indexed(root, name=name, content=content))
    originals = {
        m["document_id"]: (
            storage.read_file(root, m["document_id"]),
            storage.list_versions(root, m["document_id"]),
        )
        for m in docs
    }
    seen = []

    def organize(document, evidence, neighbors, **vocabulary):
        folder = expected[document["document_id"]]
        assert folder in vocabulary["folders"]
        assert "Obsolete filename folder" not in vocabulary["folders"]
        assert all("unhelpful" not in f for f in vocabulary["folders"])
        seen.append(folder)
        return decision(folder)

    monkeypatch.setattr("app.jev.organize_document", organize)
    for _ in range(2):
        rebuild.request()
        while rebuild.process_one():
            pass
        state = client.get("/api/rebuild").json()
        assert (state["completed"], state["skipped"], state["failed"]) == (8, 2, 0)
        assert state["status"] == "completed"
        assert len(state["details"]) == 2
        assert search.organization_catalog(root)["folders"] == sorted(set(expected.values()))
        assert search.browse_documents(root, folder="Atlas")["total"] == 5
        with pytest.raises(ValueError, match="No failed"):
            rebuild.request(retry=True)
    assert len(seen) == 16
    for m in docs:
        assert (
            storage.read_file(root, m["document_id"]),
            storage.list_versions(root, m["document_id"]),
        ) == originals[m["document_id"]]


@pytest.mark.parametrize("action", ["delete-folder", "delete-document"])
def test_manual_delete_wins_over_inflight_background_decision(context, action):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    meta = indexed(root)
    search.save_organization(
        root, meta["document_id"], "v1", {**decision("Old"), "status": "pending"}
    )

    def organize(*args, **kwargs):
        if action == "delete-folder":
            ui.delete_item(action, {"folder": "Old"})
        else:
            ui.delete_item(action, {"document_id": meta["document_id"], "expected_version": "v1"})
        return decision("Stale provider decision")

    monkeypatch.setattr("app.jev.organize_document", organize)
    server.reconcile_once([meta["document_id"]])
    row = search.get_document_status(root, meta["document_id"])
    if action == "delete-folder":
        assert row["folder"] == ""
        assert storage.read_file(root, meta["document_id"])[0] == b"cat rests"
    else:
        assert row is None
        assert storage.current_version(root, meta["document_id"]) is None
        assert meta["document_id"] not in server.retry_ids


@pytest.mark.parametrize("relation", ["related", "duplicate"])
def test_symmetric_connections_display_once_but_both_stored_passages_remain_valid(
    context, relation
):
    root, _, _ = context
    a, b = indexed(root), indexed(root, name="other.txt")
    ae = search.document_evidence(root, a["document_id"], "v1")[0]["evidence_id"]
    be = search.document_evidence(root, b["document_id"], "v1")[0]["evidence_id"]
    for source, target, se, te in [(a, b, ae, be), (b, a, be, ae)]:
        links = [
            {
                "document_id": target["document_id"],
                "version": "v1",
                "source_version": "v1",
                "relation": kind,
                "source_chunk_id": se,
                "target_chunk_id": te,
            }
            for kind in [relation, "supports", "contradicts"]
        ]
        search.save_organization(root, source["document_id"], "v1", decision(links=links))
    shown = ui.connections(a["document_id"], "v1")
    assert sum(link["relation"] == relation for link in shown) == 1
    assert sum(link["relation"] == "supports" for link in shown) == 2
    assert sum(link["relation"] == "contradicts" for link in shown) == 2
    assert shown == ui.connections(b["document_id"], "v1")
    for source, target, se, te in [(a, b, ae, be), (b, a, be, ae)]:
        assert (
            ui.link_evidence(source["document_id"], "v1", target["document_id"], "v1", se, te)[
                "source"
            ][0]["evidence_id"]
            == se
        )
        assert (
            len(json.loads(search.get_document_status(root, source["document_id"])["links_json"]))
            == 3
        )


def test_scoped_folder_counts_include_descendants_groups_and_all_pages(context):
    root, _, client = context
    for folder, groups in [
        ("Atlas / Storage", ["a"]),
        ("Atlas / Storage", ["b"]),
        ("Atlas / Search", ["b"]),
        ("Cedar / Support", ["a"]),
    ]:
        doc = indexed(root)
        search.save_organization(root, doc["document_id"], "v1", decision(folder, groups))
    all_rows = client.get("/api/library?limit=1").json()
    assert all_rows["total"] == 4 and all_rows["has_more"]
    assert all_rows["scoped_folders"] == all_rows["folders"]
    parent = client.get("/api/library", params={"folder": "Atlas", "limit": 1}).json()
    assert parent["scoped_folders"] == {"Atlas / Storage": 2, "Atlas / Search": 1}
    intersection = client.get("/api/library", params={"folder": "Atlas", "group": "a"}).json()
    assert intersection["total"] == 1 and intersection["scoped_folders"] == {"Atlas / Storage": 1}
    assert intersection["folders"] == all_rows["folders"]  # Navigation remains the global catalog.


def test_canvas_card_skips_boilerplate_and_search_excerpt_uses_supporting_match(context):
    root, monkeypatch, client = context
    doc = indexed(root, content=b"Original bytes remain exact.")
    chunks = [
        {
            "chunk_id": f"{doc['document_id']}:v1:t{i}",
            "text": text,
            "basis": "text",
            "provenance_json": "{}",
            "vector": [0.0, 0.0, 0.1],
        }
        for i, text in enumerate(
            [
                "Synthetic QA fixture. This is a fictional test note.",
                "# Atlas / Search / Design\nHybrid retrieval combines keywords and meaning.",
            ]
        )
    ]
    search.put_chunks(root, doc, chunks, "test-only-fixture")
    preview = client.get("/api/card", params={"id": doc["document_id"], "version": "v1"}).json()
    assert preview["evidence"][0]["evidence_id"].endswith("t1")
    assert "Hybrid retrieval" in preview["evidence"][0]["text"]
    assert "fictional" not in str(preview).lower()
    first = {"evidence_id": "opening", "text": "Opening passage unrelated to this question."}
    support = {
        "evidence_id": "support",
        "text": "This is a fictional test policy. Refunds are accepted within fourteen days.",
    }
    monkeypatch.setattr(
        server,
        "search",
        lambda **args: {
            "matches": [
                {**doc, "evidence": [first, support], "jev": {"supporting_chunk_ids": ["support"]}}
            ]
        },
    )
    result = mutate(client, "search", {"query": "refund window"}).json()
    assert result["matches"][0]["excerpt"] == "Refunds are accepted within fourteen days."
    assert result["matches"][0]["evidence"] == [first, support]
    assert storage.read_file(root, doc["document_id"])[0] == b"Original bytes remain exact."


@pytest.mark.parametrize("fresh", [False, True])
def test_full_reset_ordinary_prose_uses_shared_topics_and_preserves_versions(context, fresh):
    from pathlib import Path
    from test_jev import sdk_client

    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    docs = [
        indexed(root, name=path.name, content=path.read_bytes())
        for path in sorted((Path(__file__).parent / "fixtures" / "ordinary-prose").glob("*.txt"))
    ]
    if fresh:
        docs.extend(
            indexed(root, name=path.name, content=path.read_bytes())
            for path in sorted((Path(__file__).parent / "fixtures" / "review-4").glob("*.txt"))
        )
    for doc in docs:
        search.save_organization(
            root, doc["document_id"], "v1", decision("Obsolete policy", ["Fictional Test"])
        )
    before = {doc["document_id"]: storage.list_versions(root, doc["document_id"]) for doc in docs}

    def local_call(state, questions, client=None):
        if "project_owner" in questions:
            names = questions["project_owner"].criteria
            preferred = next(key for key, name in names.items() if name == state["project_hypothesis"])
            choices = {"project_owner": preferred}
            nouls = {"project_presence": 0.95}
        elif "folder" in questions:
            folders = questions["folder"].criteria
            preferred = next(iter(folders))
            choices = {"folder": preferred}
            nouls = {key: 0.0 for key, q in questions.items() if q.type == "noul"}
        else:
            choices = {key: "none" for key in questions if key.startswith("pair_")}
            nouls = {key: 0.0 for key, q in questions.items() if q.type == "noul"}
        with sdk_client(choices, nouls) as sdk:
            return sdk.system_one(state=state, questions=questions)

    monkeypatch.setattr("app.jev._call", local_call)
    expected = (
        ["Vela Labs / Billing"] * 2
        + ["Vela Labs / Employee access"] * 2
        + ["Oak Garden / Rosemary"] * 2
        + (
            ["Nacre / Commerce"] * 2
            + ["Nacre / Employee access"] * 2
            + ["Beacon Studio / Commerce"] * 2
            if fresh
            else []
        )
    )
    for _ in range(2):
        rebuild.request()
        while rebuild.process_one():
            pass
        assert not rebuild.status()["failures"]
        assert [
            search.get_document_status(root, doc["document_id"])["folder"] for doc in docs
        ] == expected
        for doc in docs:
            row = search.get_document_status(root, doc["document_id"])
            assert "Fictional Test" not in row["groups"]
            assert storage.list_versions(root, doc["document_id"]) == before[doc["document_id"]]
            assert storage.read_file(root, doc["document_id"])[1]["sha256"] == doc["sha256"]


def test_manual_subtree_rename_move_update_and_restart_preserve_originals(context):
    from app.organization_edits import read, recover

    root, _, client = context
    a, b, other = (
        indexed(root, name="API-NOTES.md"),
        indexed(root, name="עברית.md"),
        indexed(root, name="outside.txt"),
    )
    for doc, folder in [
        (a, "Project / Billing"),
        (b, "Project / Billing / Invoices"),
        (other, "Other"),
    ]:
        search.save_organization(root, doc["document_id"], "v1", decision(folder))
    before = {
        d["document_id"]: storage.list_versions(root, d["document_id"]) for d in [a, b, other]
    }
    renamed = mutate(client, "rename-folder", {"folder": "Project / Billing", "name": "חיוב"})
    assert renamed.status_code == 200, renamed.text
    assert search.get_document_status(root, a["document_id"])["folder"] == "Project / חיוב"
    assert (
        search.get_document_status(root, b["document_id"])["folder"] == "Project / חיוב / Invoices"
    )
    assert (
        mutate(
            client, "move-folder", {"folder": "Project", "destination": "Project / חיוב"}
        ).status_code
        == 400
    )
    assert (
        mutate(client, "rename-folder", {"folder": "Project", "name": "Other"}).status_code == 400
    )
    assert (
        mutate(
            client,
            "move-documents",
            {
                "folder": "New / Subject",
                "documents": [
                    {"document_id": a["document_id"], "expected_version": "v1"},
                    {"document_id": b["document_id"], "expected_version": "v0"},
                ],
            },
        ).status_code
        == 400
    )
    assert search.get_document_status(root, a["document_id"])["folder"] == "Project / חיוב"
    assert (
        mutate(
            client, "move-folder", {"folder": "Project / חיוב", "destination": "Archive"}
        ).status_code
        == 200
    )
    recover(root)
    for identity, versions in before.items():
        assert storage.list_versions(root, identity) == versions
    new = add(root, document_id=a["document_id"], content=b"cat changed")
    index_document(root, new, b"cat changed", FixtureEmbedder())
    search.save_organization(root, a["document_id"], "v2", decision("Automatic wrong"))
    assert search.get_document_status(root, a["document_id"])["folder"] == "Archive / חיוב"
    assert read(root)["assignments"][a["document_id"]]["folder"] == "Archive / חיוב"
    assert storage.read_file(root, a["document_id"], "v1")[0] == b"cat rests"


def test_reset_preflight_failure_is_atomic_and_full_reset_clears_skips_and_incoming(context):
    from app.organization_edits import read

    root, monkeypatch, client = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    source, outside = indexed(root), indexed(root, name="outside.md")
    empty = add(root, name="empty.txt", content=b"")
    search.set_document_status(root, empty, status="empty")
    for doc in [source, empty]:
        search.save_organization(root, doc["document_id"], "v1", decision("Old / Child"))
    mutate(
        client,
        "move-documents",
        {
            "folder": "Old / Child",
            "documents": [{"document_id": source["document_id"], "expected_version": "v1"}],
        },
    )
    search.save_organization(
        root,
        outside["document_id"],
        "v1",
        decision(
            "Outside",
            links=[
                {
                    "document_id": source["document_id"],
                    "source_chunk_id": f"{outside['document_id']}:v1:t0",
                    "target_chunk_id": f"{source['document_id']}:v1:t0",
                    "version": "v1",
                    "source_version": "v1",
                    "relation": "related",
                }
            ],
        ),
    )
    before = [storage.list_versions(root, d["document_id"]) for d in [source, empty, outside]]

    def unavailable():
        raise ValueError("Jev preflight failed")

    monkeypatch.setattr("app.jev.preflight", unavailable)
    with pytest.raises(ValueError, match="preflight"):
        rebuild.request(folder="Old")
    assert rebuild.status() is None
    assert read(root)["assignments"]
    assert search.get_document_status(root, source["document_id"])["folder"] == "Old / Child"
    monkeypatch.setattr("app.jev.preflight", lambda: None)
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: {"status": "unavailable"})
    job = rebuild.request(folder="Old")
    assert job["phase"] == "rebuilding" and len(job["document_ids"]) == 2
    assert not read(root)["assignments"]
    for doc in [source, empty]:
        row = search.get_document_status(root, doc["document_id"])
        assert row["folder"] == "" and row["groups"] == [] and json.loads(row["links_json"]) == []
    row = search.get_document_status(root, outside["document_id"])
    assert row["folder"] == "Outside" and json.loads(row["links_json"]) == []
    while rebuild.process_one():
        pass
    state = rebuild.status()
    assert (
        len(state["completed_ids"]) + len(state["failures"]) + len(state["skips"]) == state["total"]
    )
    assert state["phase"] == "complete"
    for doc in [source, empty]:
        assert search.get_document_status(root, doc["document_id"])["folder"] == ""
    assert [
        storage.list_versions(root, d["document_id"]) for d in [source, empty, outside]
    ] == before
    original_generation = state["request_id"]
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: decision())
    assert rebuild.request(retry=True)["request_id"] == original_generation
    while rebuild.process_one():
        pass
    assert len(rebuild.status()["completed_ids"]) == 1 and len(rebuild.status()["skips"]) == 1


def test_reset_clearing_phase_recovers_after_interruption(context):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-only")
    a, b = indexed(root), indexed(root, name="b.txt")
    for doc in [a, b]:
        search.save_organization(root, doc["document_id"], "v1", decision("Old / Stale"))
    real = rebuild.save_organization
    calls = 0

    def interrupted(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("simulated process interruption")
        return real(*args)

    monkeypatch.setattr(rebuild, "save_organization", interrupted)
    with pytest.raises(RuntimeError):
        rebuild.request()
    assert rebuild.status()["phase"] == "clearing"
    monkeypatch.setattr(rebuild, "save_organization", real)
    monkeypatch.setattr("app.jev.organize_document", lambda *a, **k: {"status": "unavailable"})
    while rebuild.process_one():
        pass
    assert rebuild.status()["phase"] == "complete"
    assert all(search.get_document_status(root, d["document_id"])["folder"] == "" for d in [a, b])


def test_bulk_download_exact_versions_collisions_and_all_or_report_failures(context):
    from io import BytesIO
    import zipfile

    root, _, client = context
    a = add(root, "same.txt", b"old original")
    add(root, "same.txt", b"new original", document_id=a["document_id"])
    b = add(root, "same.txt", b"second identity")
    items = [{"document_id": d["document_id"], "version": "v1"} for d in [a, b]]
    r = mutate(client, "bulk-download", {"documents": items})
    assert r.status_code == 200 and r.headers["x-symbiknow-file-count"] == "2"
    with zipfile.ZipFile(BytesIO(r.content)) as archive:
        assert archive.namelist() == ["same.txt", "same (2).txt"]
        assert (
            archive.read("same.txt") == b"old original"
            and archive.read("same (2).txt") == b"second identity"
        )
    failed = mutate(
        client,
        "bulk-download",
        {"documents": [*items, {"document_id": a["document_id"], "version": "v99"}]},
    )
    assert failed.status_code == 400 and len(failed.json()["failures"]) == 1


def test_metadata_sorting_covers_scope_before_pagination(context):
    root, _, client = context
    for name in ["z.txt", "a.txt", "m.txt"]:
        add(root, name)
    first = client.get("/api/library?sort=filename&limit=1").json()
    second = client.get("/api/library?sort=filename&limit=1&offset=1").json()
    assert first["documents"][0]["filename"] == "a.txt"
    assert second["documents"][0]["filename"] == "m.txt"
    assert (
        client.get("/api/library?sort=filename&descending=true&limit=1").json()["documents"][0][
            "filename"
        ]
        == "z.txt"
    )
    assert client.get("/api/library?sort=bad").status_code == 400


def test_pdf_first_page_thumbnail_uses_existing_renderer_without_changing_bytes(context):
    from io import BytesIO
    import pypdfium2 as pdfium
    from PIL import Image

    root, _, client = context
    document = pdfium.PdfDocument.new()
    page = document.new_page(600, 800)
    buffer = BytesIO()
    document.save(buffer)
    page.close()
    document.close()
    original = buffer.getvalue()
    metadata = add(root, "first-page.pdf", original, mime_type="application/pdf")
    r = client.get("/api/thumbnail", params={"id": metadata["document_id"], "version": "v1"})
    assert r.status_code == 200
    with Image.open(BytesIO(r.content)) as image:
        assert image.width <= 264 and image.height <= 340
    assert (
        client.get("/api/download", params={"id": metadata["document_id"], "version": "v1"}).content
        == original
    )


def test_pdf_reader_pages_are_bounded_version_pinned_and_cacheable(context):
    from io import BytesIO
    import pypdfium2 as pdfium
    from PIL import Image

    root, _, client = context
    with pdfium.PdfDocument.new() as document:
        document.new_page(600, 800).close()
        document.new_page(800, 600).close()
        buffer = BytesIO()
        document.save(buffer)
    original = buffer.getvalue()
    metadata = add(root, "two-pages.pdf", original, mime_type="application/pdf")
    params = {"id": metadata["document_id"], "version": "v1", "page": "2"}
    response = client.get("/api/pdf-page", params=params)
    assert response.status_code == 200
    assert response.headers["x-pdf-page-count"] == "2"
    with Image.open(BytesIO(response.content)) as image:
        assert image.width > image.height and max(image.size) <= 1400
    assert client.get("/api/pdf-page", params=params).content == response.content
    for invalid in ("0", "-1", "3", "10001", "oops"):
        assert client.get("/api/pdf-page", params={**params, "page": invalid}).status_code == 400
    assert client.get("/api/pdf-page", params={**params, "version": ""}).status_code == 400
    assert client.get("/api/download", params=params).content == original
    other = add(root, "plain.txt", b"not a PDF")
    assert client.get("/api/pdf-page", params={**params, "id": other["document_id"]}).status_code == 400
    new = storage.save_file(root, b"new bytes", "two-pages.txt", document_id=metadata["document_id"], expected_version="v1")
    search.register_document(root, new)
    assert client.get("/api/pdf-page", params=params).content == response.content


def test_csv_card_returns_bounded_literal_cells_for_the_requested_version(context):
    root, _, client = context
    original = b'Name,Value\n"Quoted, name",=1+1\n' + b'item,value\n' * 20
    metadata = add(root, "manifest.csv", original, mime_type="text/csv")
    params = {"id": metadata["document_id"], "version": "v1"}
    result = client.get("/api/card", params=params).json()
    assert len(result["table"]) == 9
    assert result["table"][1] == ["Quoted, name", "=1+1"]
    new = storage.save_file(root, b"Name,Value\nNew,2", "manifest.csv", document_id=metadata["document_id"], expected_version="v1", mime_type="text/csv")
    search.register_document(root, new)
    historical = client.get("/api/card", params=params).json()
    assert historical["table"] == result["table"]
    assert historical["evidence"] == []
    assert client.get("/api/download", params=params).content == original


def test_batched_reset_checkpoint_replays_only_uncheckpointed_clear_work(context, monkeypatch):
    root, _, _ = context
    identities = [f"fixture-{i}" for i in range(37)]
    state = {
        "document_ids": identities,
        "cleared_ids": [],
        "phase": "clearing",
        "grouping": False,
        "links": True,
        "request_id": "batch-reset",
        "incoming_cleared": True,
    }
    rebuild._persist(state)
    applied = {}
    calls = []
    monkeypatch.setattr(
        rebuild,
        "get_document_status",
        lambda *args: {
            "version": "v1",
            "folder": "Retained",
            "groups": ["Retained"],
            "links_json": "[]",
            "organization_status": "evaluated",
            "organization_json": "{}",
        },
    )

    def clear(*args):
        identity, decision = args[1], args[3]
        calls.append(identity)
        if len(calls) == 35:
            raise RuntimeError("interrupted after a checkpoint")
        applied[identity] = decision

    monkeypatch.setattr(rebuild, "save_organization", clear)
    with pytest.raises(RuntimeError):
        rebuild._clear_boundary(state)
    durable = rebuild.status()
    assert durable["phase"] == "clearing" and durable["cleared_ids"] == identities[:32]
    rebuild._clear_boundary(durable)
    assert rebuild.status()["phase"] == "rebuilding"
    assert rebuild.status()["cleared_ids"] == identities
    assert calls[35:] == identities[32:]
    assert all(
        value["folder"] == "Retained" and value["groups"] == ["Retained"] and value["links"] == []
        for value in applied.values()
    )


def test_all_metadata_sorts_and_recent_order_cover_both_directions_and_pages(context):
    root, _, client = context
    documents = [add(root, name) for name in ("z.md", "a.txt", "m.html")]
    fields = {"filename": "filename", "type": "mime_type", "date": "created_at"}
    for field, key in fields.items():
        for descending in (False, True):
            pages = [
                client.get(
                    f"/api/library?sort={field}&descending={str(descending).lower()}&limit=1&offset={i}"
                ).json()["documents"][0]
                for i in range(3)
            ]
            values = [row[key] for row in pages]
            assert values == sorted(values, reverse=descending)
    recent = [
        client.get(f"/api/library?recent=true&sort=filename&limit=1&offset={i}").json()[
            "documents"
        ][0]["document_id"]
        for i in range(3)
    ]
    assert recent == [doc["document_id"] for doc in reversed(documents)]
