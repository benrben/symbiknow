"""Published read projections retain exact evidence/manual invalidation semantics."""
import pytest

from symbiknow.organization import readmodel
from symbiknow.search import index
from symbiknow.core.application import ApplicationContext
from tests.organization.test_decisions import pending as pending


def test_projections_follow_publications_receipts_and_manual_moves(pending):
    ctx, source, target, _, _ = pending
    readmodel.rebuild(ctx.DATA_DIR)
    assert readmodel.aggregates(ctx.DATA_DIR)["library_total"] == 2
    queue = ctx.decisions.list()["decisions"]
    assert len(queue) == 2
    queue.sort(key=lambda item: item["kind"] != "folder")
    ctx.decisions.resolve(queue[0]["id"], "change", "Chosen / Folder")
    assert index.browse_documents(ctx.DATA_DIR, folder="Chosen")["total"] == 1
    assert readmodel.aggregates(ctx.DATA_DIR)["folders"]["Chosen / Folder"] == 1
    assert len(ctx.decisions.list()["decisions"]) == 1
    ctx.decisions.resolve(queue[1]["id"], "skip")
    assert ApplicationContext(ctx.DATA_DIR).decisions.list()["decisions"] == []


def test_cursor_binds_scope_sort_and_publication(pending):
    ctx, source, _, _, _ = pending
    readmodel.rebuild(ctx.DATA_DIR)
    page = index.browse_documents(ctx.DATA_DIR, limit=1)
    tail = index.browse_documents(ctx.DATA_DIR, limit=1, cursor=page["next_cursor"])
    assert tail["documents"][0]["document_id"] != page["documents"][0]["document_id"]
    with pytest.raises(ValueError, match="cursor"):
        index.browse_documents(ctx.DATA_DIR, limit=1, sort="date", cursor=page["next_cursor"])
    readmodel.source_changed(ctx.DATA_DIR, source["document_id"])
    with pytest.raises(ValueError, match="changed"):
        index.browse_documents(ctx.DATA_DIR, limit=1, cursor=page["next_cursor"])


def test_original_change_revokes_dependent_folder_before_registration(pending):
    from symbiknow.library import storage
    ctx, source, target, _, _ = pending
    state = index.get_document_status(ctx.DATA_DIR, target["document_id"])
    index.save_organization(ctx.DATA_DIR, source["document_id"], "v1", {
        "status": "evaluated", "folder": "Dependent", "groups": [], "links": [],
        "dependency_evidence_revisions": {target["document_id"]: state["evidence_revision"]}})
    readmodel.rebuild(ctx.DATA_DIR)
    assert index.browse_documents(ctx.DATA_DIR, folder="Dependent")["total"] == 1
    storage.save_file(ctx.DATA_DIR, b"changed", target["filename"], document_id=target["document_id"])
    assert index.browse_documents(ctx.DATA_DIR, folder="Dependent")["total"] == 0


def test_hot_reads_do_not_iterate_metadata(pending, monkeypatch):
    ctx, *_ = pending
    readmodel.rebuild(ctx.DATA_DIR)
    monkeypatch.setattr(index, "metadata_batches", lambda *a, **kw: pytest.fail("read scanned metadata"))
    assert ctx.library.library({}).to_wire()["total"] == 2
    assert ctx.decisions.list()["decisions"]


def test_taxonomy_cursor_keeps_scopes_beyond_first_page(tmp_path):
    import uuid
    with readmodel.connection(tmp_path, create=True) as db:
        for number in range(205):
            readmodel._put(db, index._document_row({"document_id": str(number), "filename": str(number), "version": "v1"}, folder=f"Project {number:03} / Topic", groups=[f"group-{number:03}"]))
        db.execute("INSERT INTO meta VALUES('ready','1')")
        db.execute("INSERT INTO meta VALUES('revision',?)", (uuid.uuid4().hex,))
    page = readmodel.aggregates(tmp_path, folder="Project 204")
    assert page['scoped_folders'] == {'Project 204 / Topic': 1}
    names = set(page['folders'])
    while page['taxonomy_has_more']:
        page = readmodel.aggregates(tmp_path, after=page['taxonomy_next_after'])
        names.update(page['folders'])
    assert len(names) == 205
    assert readmodel.browse(tmp_path, folder='Project 204')['total'] == 1
    assert len(index.organization_catalog(tmp_path)['folders']) == 205


def test_generation_prepares_projection_before_switch(pending, monkeypatch):
    from symbiknow.organization import store
    ctx, source, *_ = pending
    readmodel.rebuild(ctx.DATA_DIR)
    store.stage(ctx.DATA_DIR, 'prepared-read-model', source['document_id'], 'v1', {
        'status': 'evaluated', 'folder': 'Prepared / New', 'groups': [], 'links': []})
    original = readmodel.rebuild
    monkeypatch.setattr(readmodel, 'rebuild', lambda *a: pytest.fail('publication rebuilt under the read lock'))
    old_path = readmodel.path(ctx.DATA_DIR)
    with readmodel.connection(ctx.DATA_DIR):
        index.publish_organization_generation(ctx.DATA_DIR, 'prepared-read-model')
        assert old_path.exists()
    readmodel.prune(ctx.DATA_DIR)
    assert not old_path.exists()
    first_path = readmodel.path(ctx.DATA_DIR)
    assert first_path.name != 'organization-read.sqlite3'
    assert readmodel.browse(ctx.DATA_DIR, folder='Prepared')['total'] == 1
    index.save_organization(ctx.DATA_DIR, source['document_id'], 'v1', {
        'status': 'evaluated', 'folder': 'Later', 'groups': [], 'links': []})
    assert readmodel.path(ctx.DATA_DIR) == first_path
    assert readmodel.browse(ctx.DATA_DIR, folder='Later')['total'] == 1
    monkeypatch.setattr(readmodel, 'rebuild', original)
