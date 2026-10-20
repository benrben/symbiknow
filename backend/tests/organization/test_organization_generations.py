"""Real Lance version pinning, durable publication and manual precedence."""
import json

import pytest

from symbiknow.organization import policy as organization
from symbiknow.organization import edits as organization_edits
from symbiknow.organization import store as organization_store
from symbiknow.organization import rebuild
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from tests.api.test_ui_api import context as context, indexed, decision


def test_held_library_context_reads_its_own_rebuild_after_root_switch(context):
    from symbiknow.organization.edits import atomic
    root, monkeypatch, _ = context
    original = server.application()
    second_root = root / "second-library"
    monkeypatch.setattr(server, "DATA_DIR", second_root)
    current = server.application()
    for application, identity in ((original, "A"), (current, "B")):
        atomic(rebuild._path(application), {"request_id": identity, "status": "running",
            "document_ids": [identity], "completed_ids": [], "failures": {}, "skips": {}})
    assert rebuild.progress(current)["request_id"] == "B"
    assert rebuild.status(original)["request_id"] == "A"
    assert rebuild.progress(original)["request_id"] == "A"
    assert rebuild.owns("A", original) and not rebuild.owns("B", original)
    assert rebuild.status(current)["request_id"] == "B"
    assert rebuild.owns("B", current) and not rebuild.owns("A", current)


def test_overlay_reads_one_current_manual_ledger_snapshot_per_bounded_batch(context, monkeypatch):
    root, _, _ = context
    rows = [{"document_id": str(index), "version": "v1", "folder": "Automatic"} for index in range(512)]
    path = organization_edits.path(root)
    organization_edits.atomic(path, {"schema": 1, "assignments": {"1": {"folder": "Manual"}}})
    calls = []
    state = organization_edits._state
    def measured(root):
        calls.append(root)
        return state(root)
    monkeypatch.setattr(organization_edits, "_state", measured)
    monkeypatch.setattr(organization_store, "published_table", lambda root: None)
    result = organization_store.overlay(root, rows, columns=["folder"])
    assert result[1]["folder"] == "Manual" and result[2]["folder"] == "Automatic"
    assert len(calls) == 1 and rows[1]["folder"] == "Automatic"
    organization_edits.atomic(path, {"schema": 1, "assignments": {"1": {"folder": "Changed"}}})
    assert organization_store.overlay(root, rows, columns=["folder"])[1]["folder"] == "Changed"
    assert len(calls) == 2


def test_pinned_readers_and_single_manifest_cover_all_organization_fields(context):
    root, _, _ = context
    doc = indexed(root)
    chunks = search._table(root, "chunks")
    source_version = chunks.version
    search.save_organization(root, doc["document_id"], "v1", decision("Old", ["old"]))
    pinned = organization_store.published_table(root)
    old_version = pinned.version
    search.save_organization(root, doc["document_id"], "v1", decision("New", ["new"]))
    assert pinned.version == old_version
    assert pinned.to_arrow().to_pylist()[0]["folder"] == "Old"
    assert organization_store.published_table(root).to_arrow().to_pylist()[0]["folder"] == "New"
    assert search._table(root, "chunks").version == source_version
    assert search.browse_documents(root, folder="New", group="new")["total"] == 1
    assert search.find_documents(root, "cat", mode="keyword", folder="New", group="new")
    assert search.browse_documents(root, folder="Old")["total"] == 0


def test_failed_manifest_never_exposes_unpublished_lance_commit(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Published"))
    original = organization_edits.atomic

    def fail_manifest(path, value):
        if path.name == "organization-published.json":
            raise OSError("interrupted manifest switch")
        return original(path, value)

    monkeypatch.setattr(organization_edits, "atomic", fail_manifest)
    with pytest.raises(OSError):
        search.save_organization(root, doc["document_id"], "v1", decision("Unpublished"))
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Published"
    monkeypatch.setattr(organization_edits, "atomic", original)
    organization_store.recover(root)
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Published"
    search.save_organization(root, doc["document_id"], "v1", decision("Recovered"))
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Recovered"


def test_preparation_preserves_revisions_and_manual_edit_wins_at_publication(context):
    root, monkeypatch, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    before = search.revisions(root)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *args, **kwargs: decision("Automatic"))
    rebuild.request(mode="links")
    assert rebuild.process_one()
    assert search.revisions(root) == before
    for _ in range(3):
        assert search.find_documents(root, "cat", mode="keyword", folder="Old")
    organization_edits.edit("move-documents", {"folder": "Manual", "documents": [
        {"document_id": doc["document_id"], "expected_version": "v1"}]})
    assert not rebuild.process_one()
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Manual"
    assert search.find_documents(root, "cat", mode="keyword", folder="Manual")
    assert search.browse_documents(root, folder="Automatic")["total"] == 0


def test_analysis_reuse_and_corpus_scope_dependency(monkeypatch):
    organization._ANALYSIS.values.clear()
    row = {"evidence_id": "d:v1:t0", "text": "Atlas / Search / Design", "basis": "text"}
    before = organization._ANALYSIS.stats()["computations"]
    assert organization.topic_paths([row]) == ["Atlas / Search"]
    assert organization.topic_paths([row]) == ["Atlas / Search"]
    assert organization._ANALYSIS.stats()["computations"] == before + 1
    assert organization.topic_paths([{**row, "text": "Atlas / Storage / Design"}]) == ["Atlas / Storage"]
    # Public results are copies, so mutation cannot corrupt reusable features.
    result = organization.topic_paths([row])
    result.clear()
    assert organization.topic_paths([row]) == ["Atlas / Search"]


def test_generation_build_allows_search_and_manual_race_without_repeating_provider(context, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    root, _, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Published"))
    calls = []
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *args, **kwargs:
                        (calls.append(1) or decision("Automatic")))
    original = organization_store.prepare_generation
    raced = []

    def prepare(*args, **kwargs):
        # A background build must not hold the publication/read lock.
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(search.find_documents, root, "cat", "keyword", 1).result(timeout=5)
        result = original(*args, **kwargs)
        if not raced:
            raced.append(True)
            organization_edits.edit("move-documents", {"folder": "Manual", "documents": [
                {"document_id": doc["document_id"], "expected_version": "v1"}]})
        return result

    monkeypatch.setattr(organization_store, "prepare_generation", prepare)
    rebuild.request(mode="links")
    assert rebuild.process_one()
    assert rebuild.process_one()  # Changed manual revision rejects first prepared table.
    assert not rebuild.process_one()
    assert calls == [1]
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Manual"
    assert rebuild.status()["status"] == "completed"


def test_same_head_evidence_change_is_accounted_as_invalidated(context, monkeypatch):
    root, _, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")
    doc = indexed(root)
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *args, **kwargs: decision("Stale"))
    rebuild.request(mode="links")
    assert rebuild.process_one()
    search._table(root, "chunks").update(values={"text": "Changed re-extraction of the same source"})
    search._bump_revision(root, "index")
    assert not rebuild.process_one()
    state = rebuild.status()
    assert state["status"] == "partial_failure"
    assert doc["document_id"] not in state["completed_ids"]
    assert "Evidence changed" in state["failures"][doc["document_id"]]
    assert search.get_document_status(root, doc["document_id"])["folder"] != "Stale"


def test_prepared_generation_recovery_discards_unpublished_table(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Published"))
    project = organization.project_identity("Unpublished project")
    organization_store.stage(root, "interrupted", doc["document_id"], "v1", {
        **decision("Prepared"), "canonical_project": project})
    def interrupted(*args, **kwargs):
        raise RuntimeError("interrupted before switch")
    monkeypatch.setattr(organization_store, "switch_generation", interrupted)
    with pytest.raises(RuntimeError):
        search.publish_organization_generation(root, "interrupted")
    journal = root / "temp/organization-staging/interrupted/publication.json"
    prepared_name = json.loads(journal.read_text())["prepared"]["table"]
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Published"
    assert search.project_roster(root) == []
    organization_store.recover(root)
    assert not journal.exists()
    with pytest.raises((FileNotFoundError, ValueError)):
        search._db(root).open_table(prepared_name)


def test_generation_retention_respects_live_pinned_reader(context):
    import gc
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    old = organization_store.published_table(root)
    organization_store.stage(root, "replacement", doc["document_id"], "v1", decision("New"))
    search.publish_organization_generation(root, "replacement")
    organization_store._pinned.cache_clear()
    organization_store.prune(root)
    assert old.to_arrow().to_pylist()[0]["folder"] == "Old"
    assert search._db(root).open_table("organization")
    del old
    gc.collect()
    organization_store.prune(root)
    with pytest.raises((FileNotFoundError, ValueError)):
        search._db(root).open_table("organization")
    assert search.get_document_status(root, doc["document_id"])["folder"] == "New"


def test_one_hundred_overlapping_searches_keep_published_generation(context, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    root, _, _ = context
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Published"))
    original = organization_store.prepare_generation
    ready, release = threading.Event(), threading.Event()
    def preparing(*args, **kwargs):
        ready.set()
        assert release.wait(15)
        return original(*args, **kwargs)
    monkeypatch.setattr(organization_store, "prepare_generation", preparing)
    successes = 0
    with ThreadPoolExecutor(max_workers=1) as pool:
        for iteration in range(2):
            folder = search.get_document_status(root, doc["document_id"])["folder"]
            monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *args, **kwargs: decision("New"))
            rebuild.request(mode="links")
            assert rebuild.process_one()
            before = search.revisions(root)
            ready.clear()
            release.clear()
            future = pool.submit(rebuild.process_one)
            assert ready.wait(10)
            try:
                for _ in range(50):
                    matches = search.find_documents(root, "cat", mode="keyword", folder=folder)
                    assert [match["document_id"] for match in matches] == [doc["document_id"]]
                    assert matches[0]["folder"] == folder
                    assert search.revisions(root) == before
                    successes += 1
            finally:
                release.set()
            assert future.result(timeout=15) is False
    assert successes == 100
    assert not (root / "temp/organization-staging" / rebuild.status()["request_id"]).exists()


def test_generation_recovery_completes_manifest_switched_before_journal_cleanup(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    search.save_organization(root, doc["document_id"], "v1", decision("Old"))
    organization_store.stage(root, "switched", doc["document_id"], "v1", decision("New"))
    original = organization_edits.atomic
    def interrupted(path, value):
        original(path, value)
        if path.name == "organization-published.json" and value.get("table", "").startswith("organization_"):
            raise RuntimeError("interrupted after manifest switch")
    monkeypatch.setattr(organization_edits, "atomic", interrupted)
    with pytest.raises(RuntimeError):
        search.publish_organization_generation(root, "switched")
    assert search.get_document_status(root, doc["document_id"])["folder"] == "New"
    monkeypatch.setattr(organization_edits, "atomic", original)
    organization_store.recover(root)
    assert not (root / "temp/organization-staging/switched/publication.json").exists()
    assert search.find_documents(root, "cat", mode="keyword", folder="New")


def test_generation_uses_same_canonical_project_validation_as_singleton(context):
    root, _, _ = context
    doc = indexed(root)
    project = organization.project_identity("Atlas")
    organization_store.stage(root, "canonical", doc["document_id"], "v1", {
        **decision("Atlas"), "canonical_project": project})
    search.publish_organization_generation(root, "canonical")
    assert search.project_roster(root) == [project]
    organization_store.stage(root, "invalid", doc["document_id"], "v1", {
        **decision("Wrong"), "canonical_project": {**project, "id": "invalid"}})
    invalidated = {}
    search.publish_organization_generation(root, "invalid", invalidated=invalidated)
    assert "Canonical project" in invalidated[doc["document_id"]]
    assert search.get_document_status(root, doc["document_id"])["folder"] == "Atlas"


def test_catalog_pointer_reuses_immutable_indexes_without_rewriting_roster(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    project = organization.project_identity("Atlas")
    search.save_organization(root, doc["document_id"], "v1", {**decision("Atlas"), "canonical_project": project})
    before = organization_store.manifest(root)
    assert "projects" not in before and before["catalog"].endswith(".json")
    catalog = search.project_roster(root)
    assert catalog is search.project_roster(root)
    with pytest.raises(TypeError):
        catalog[0]["name"] = "Corrupted"
    search.save_organization(root, doc["document_id"], "v1", decision("Moved"))
    assert organization_store.manifest(root)["catalog"] == before["catalog"]
    def no_scan(self):
        raise AssertionError("project identity validation scanned the roster")
    monkeypatch.setattr(organization_store.ProjectCatalog, "__iter__", no_scan)
    assert organization.project_identity("Atlas", catalog)["id"] == project["id"]


def test_catalog_preserves_identity_and_candidate_alias_precedence():
    projects = [{"id": "first", "name": "Atlas", "aliases": ["Shared"]},
                {"id": "last", "name": "Cedar", "aliases": ["Shared"]}]
    catalog = organization_store.ProjectCatalog(projects)
    assert organization.project_identity("Shared", catalog)["id"] == "first"
    evidence = [{"text": "Shared owns the search workflow", "basis": "text"}]
    assert organization.project_candidates(evidence, projects=catalog) == organization.project_candidates(evidence, projects=projects)


def test_feature_key_uses_project_names_digest_without_registry_iteration(monkeypatch):
    names = organization.ProjectNames(["Atlas", *[f"Project {i}" for i in range(1000)]])
    assert names.digest == organization.ProjectNames(reversed(names)).digest
    def no_registry_iteration(self):
        raise AssertionError("feature key serialized the complete project registry")
    monkeypatch.setattr(organization.ProjectNames, "__iter__", no_registry_iteration)
    assert organization.project_scope([{"text": "Atlas owns search infrastructure."}], names) == "Atlas"


def test_indexed_catalog_prefix_normalization_preserves_longest_alias():
    projects = [{"id": "short", "name": "Atlas", "aliases": []},
                {"id": "long", "name": "Cedar", "aliases": ["Atlas MCP"]}]
    catalog = organization_store.ProjectCatalog(projects)
    for text in ("Atlas MCP protocol owns request routing.", "Atlas storage owns original files.",
                 "Unrelated search design explains request routing."):
        evidence = [{"text": text, "basis": "text"}]
        assert organization.project_candidates(evidence, projects=catalog) == organization.project_candidates(evidence, projects=projects)
