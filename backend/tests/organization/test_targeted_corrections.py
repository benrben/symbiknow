"""Corrections use isolated real stores and survive later AI publications."""
import json

import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.library import storage
from symbiknow.organization import corrections, edits, readmodel
from symbiknow.organization.store import scope_condition
from symbiknow.search import index
from tests.search.test_search import FixtureEmbedder, _add


@pytest.fixture
def library(tmp_path):
    storage.init_storage(tmp_path)
    embedder = FixtureEmbedder()
    source = _add(tmp_path, embedder, "source.md", b"# Atlas\nAtlas RAM remains bounded. Throughput is measured separately.")
    target = _add(tmp_path, embedder, "target.md", b"# Atlas results\nAtlas RAM remains bounded under streaming.")
    s, t = [index.get_document_status(tmp_path, d["document_id"]) for d in (source, target)]
    se, te = [index.document_evidence(tmp_path, d["document_id"], d["version"])[0] for d in (source, target)]
    link = dict(document_id=target["document_id"], version=target["version"], source_version=source["version"],
                source_chunk_id=se["evidence_id"], target_chunk_id=te["evidence_id"], relation="supports", confidence=.99)
    state = dict(status="evaluated", folder="Wrong", groups=["Wrong / Read"], links=[link],
                 evidence_revision=s["evidence_revision"], evidence_ids=[se["evidence_id"]],
                 dependency_evidence_revisions={target["document_id"]: t["evidence_revision"]})
    index.save_organization(tmp_path, source["document_id"], source["version"], state)
    context = ApplicationContext(tmp_path)
    readmodel.rebuild(tmp_path)
    args = dict(document_id=source["document_id"], expected_version=source["version"],
                expected_evidence_revision=s["evidence_revision"], expected_manual_revision=None,
                expected_correction_revision=None, reason="Inspected exact source claims",
                expected_target_evidence_revision=t["evidence_revision"])
    return context, source, target, state, args, (se, te), embedder


def row(library):
    context, source, *_ = library
    return index.get_document_status(context.DATA_DIR, source["document_id"])


def test_retraction_history_and_no_resurrection(library):
    context, source, target, state, args, _, _ = library
    request = dict(args, action="retract-link", previous=state["links"][0], request_id="retract-1")
    record = context.corrections.apply(request)
    assert not json.loads(row(library)["links_json"])
    assert record["previous"] == state["links"][0]
    assert context.corrections.apply(request) == record
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    assert not json.loads(row(library)["links_json"])
    assert ApplicationContext(context.DATA_DIR).corrections.inspect(source["document_id"])["history"] == [record]


def test_folder_topics_scope_and_manual_wins(library):
    context, source, _, state, args, _, _ = library
    record = context.corrections.apply(dict(args, action="correct-folder", value="Atlas / Engine"))
    assert row(library)["folder"] == "Atlas / Engine"
    assert source["document_id"] in scope_condition(context.DATA_DIR, "Atlas")
    context.corrections.apply(dict(args, action="replace-topics", value=["Research"], expected_correction_revision=record["id"]))
    assert row(library)["groups"] == ["Research"]
    assert source["document_id"] in scope_condition(context.DATA_DIR, group="Research")
    edits.edit("move-documents", {"folder": "My choice", "documents": [
        {"document_id": source["document_id"], "expected_version": source["version"]}]}, context)
    assert row(library)["folder"] == "My choice"
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    assert row(library)["folder"] == "My choice"
    assert row(library)["groups"] == ["Research"]


def test_replacement_changes_graph_and_exact_anchors(library):
    context, source, target, state, args, passages, _ = library
    from symbiknow.ai.proof import make_reviewed_proof
    value = dict(state["links"][0], relation="related", proof=make_reviewed_proof(
        source, target, *passages, relation="related", actor="user", reason=args["reason"]))
    context.corrections.apply(dict(args, action="supersede-link", previous=state["links"][0], value=value))
    links = json.loads(row(library)["links_json"])
    assert len(links) == 1 and links[0]["relation"] == "related"
    assert links[0]["proof"]["source"]["text"] == passages[0]["text"]


@pytest.mark.parametrize("field,value", [("expected_version", "v999"), ("expected_evidence_revision", "changed"),
                                        ("expected_manual_revision", "changed"), ("expected_correction_revision", "changed"),
                                        ("expected_target_evidence_revision", "changed")])
def test_stale_guards_fail_without_history(library, field, value):
    context, source, _, state, args, _, _ = library
    with pytest.raises(ValueError, match="changed"):
        context.corrections.apply(dict(args, action="retract-link", previous=state["links"][0], **{field: value}))
    assert not corrections.records(context.DATA_DIR, [source["document_id"]])
    assert json.loads(row(library)["links_json"]) == state["links"]


def test_user_accepted_link_protected(library):
    context, source, _, state, args, _, _ = library
    state["links"][0]["reviewed_by"] = "user"
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    with pytest.raises(ValueError, match="protected"):
        context.corrections.apply(dict(args, action="retract-link", previous=state["links"][0]))


def test_new_source_evidence_expires_derived_correction(library):
    context, source, _, _, args, _, embedder = library
    context.corrections.apply(dict(args, action="replace-topics", value=["Research"]))
    from symbiknow.ingestion.service import index_document
    index_document(context.DATA_DIR, source, b"New evidence without an Atlas research subject", embedder)
    assert row(library)["groups"] != ["Research"]
    assert len(context.corrections.inspect(source["document_id"])["history"]) == 1


def test_bad_span_rejected(library):
    context, _, _, state, args, _, _ = library
    value = dict(state["links"][0], proof={"source": {"start": 0, "end": 9, "text": "invented"}})
    with pytest.raises(ValueError, match="proof|exact"):
        context.corrections.apply(dict(args, action="supersede-link", previous=state["links"][0], value=value))


def test_superseded_proof_is_revalidated_at_publication(library):
    context, source, target, state, args, passages, _ = library
    from symbiknow.ai.proof import make_reviewed_proof
    value = dict(state["links"][0], relation="related", proof=make_reviewed_proof(
        source, target, *passages, relation="related", actor="user", reason=args["reason"]))
    state["links"] = [value]
    index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)
    value["proof"]["target"]["text"] = "A false target claim"
    with pytest.raises(ValueError, match="proof text changed"):
        index.save_organization(context.DATA_DIR, source["document_id"], source["version"], state)


def test_deletion_removes_copied_passages(library):
    context, source, target, state, args, _, _ = library
    context.corrections.apply(dict(args, action="retract-link", previous=state["links"][0]))
    assert corrections.records(context.DATA_DIR, [source["document_id"]])
    storage.clear_deleted_caches(context.DATA_DIR, target["document_id"])
    assert not corrections.records(context.DATA_DIR, [source["document_id"]])


def test_accepted_link_can_gain_evidence_without_replacing_user_decision(library):
    context, source, target, state, args, passages, _ = library
    from symbiknow.ai.proof import make_reviewed_proof
    old = state['links'][0]
    old.update(relation='related', reviewed_by='user', decision_id='accepted-original')
    index.save_organization(context.DATA_DIR, source['document_id'], source['version'], state)
    added = dict(old, proof=make_reviewed_proof(source, target, *passages,
                 relation='related', actor='agent', reason=args['reason']))
    context.corrections.apply(dict(args, action='supplement-link', previous=old, value=added))
    active = json.loads(row(library)['links_json'])[0]
    assert all(active[k] == v for k, v in old.items())
    assert active['additional_evidence'][0]['proof'] == added['proof']
    index.save_organization(context.DATA_DIR, source['document_id'], source['version'], state)
    assert json.loads(row(library)['links_json'])[0] == active


def test_history_read_keeps_correction_action_and_current_effective_topics(library):
    context, source, _, _, args, _, _ = library
    correction = context.corrections.apply(dict(args, action="replace-topics", value=["Research"], actor="user"))
    history = context.catalog.history(source["document_id"], limit=1)
    event = history["entries"][0]
    assert event["id"] == correction["id"] and event["action"] == "replace-topics"
    assert event["timestamp"] == correction["timestamp"] and event["value"] == ["Research"]
    assert history["current"]["topics"] == ["Research"]


def test_reset_retires_earlier_corrections_keeps_history_and_honors_later_ones(library):
    context, source, _, state, args, _, _ = library
    root, identity = context.DATA_DIR, source["document_id"]
    folder = context.corrections.apply(dict(args, action="correct-folder", value="Atlas / Engine"))
    topics = context.corrections.apply(dict(args, action="replace-topics", value=["Research"],
                                            expected_correction_revision=folder["id"]))
    retracted = context.corrections.apply(dict(args, action="retract-link", previous=state["links"][0],
                                               expected_correction_revision=topics["id"]))
    assert (row(library)["folder"], row(library)["groups"]) == ("Atlas / Engine", ["Research"])
    assert corrections.reset(root, [identity], grouping=True, links=False, request_id="r1") == [identity]
    corrections.reset(root, [identity], grouping=True, links=False, request_id="r1")  # Replay.
    current = row(library)
    assert (current["folder"], current["groups"]) == ("Wrong", ["Wrong / Read"])
    assert not json.loads(current["links_json"])  # Links were not part of this reset.
    corrections.reset(root, [identity], grouping=False, links=True, request_id="r2")
    assert json.loads(row(library)["links_json"]) == state["links"]
    history = context.corrections.inspect(identity)["history"]
    assert [h["action"] for h in history] == ["correct-folder", "replace-topics", "retract-link",
                                             "reset-corrections", "reset-corrections"]
    later = context.corrections.apply(dict(args, action="correct-folder", value="Atlas / Later",
                                           expected_correction_revision=history[-1]["id"]))
    assert row(library)["folder"] == "Atlas / Later"
    assert json.loads(index.get_document_status(root, identity)["organization_json"])["correction_ids"] == [later["id"]]
    assert retracted["id"] in {h["id"] for h in context.corrections.inspect(identity)["history"]}


def test_reset_without_corrections_or_scope_changes_nothing(library):
    context, source, *_ = library
    assert corrections.reset(context.DATA_DIR, [source["document_id"]], grouping=True, links=True, request_id="r") == []
    context.corrections.apply(dict(library[4], action="correct-folder", value="Atlas / Engine"))
    assert corrections.reset(context.DATA_DIR, [source["document_id"]], grouping=False, links=False, request_id="r") == []
    assert row(library)["folder"] == "Atlas / Engine"
