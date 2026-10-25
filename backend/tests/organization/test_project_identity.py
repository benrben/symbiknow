"""Identity, placement and topic authority remain independent across reruns."""

import json
from pathlib import Path

import pytest

from symbiknow.ai import jev, topics
from symbiknow.organization import edits, projects, store
from symbiknow.organization.policy import (
    descriptive_metadata, identity_statements, meaningful_subject, project_candidate_details, project_candidates,
    project_identity,
)
from symbiknow.library import storage
from symbiknow.search import index as search
from tests.api.test_ui_api import context as context, indexed, decision


IDENTITY = ("myai is the user-facing name of qwrun, our Rust engine. "
            "Source: /Users/example/Projects/crazyidea/runner. "
            "myai includes Jev Finder, a feature for searching library documents.")


def correction_arguments(root, document):
    row = search.get_document_status(root, document["document_id"])
    passage = search.document_evidence(root, document["document_id"], "v1")[0]
    return dict(expected_version="v1", expected_evidence_revision=row["evidence_revision"],
                expected_manual_revision=(edits.override(root, document["document_id"]) or {}).get("revision"),
                reason="Inspected app identity and repository provenance",
                evidence=[dict(document_id=document["document_id"], version="v1",
                               evidence_revision=row["evidence_revision"],
                               evidence_id=passage["evidence_id"], quote=passage["text"])])


def register(root, document):
    return projects.correct_ownership(
        root, document["document_id"],
        dict(name="Crazyidea", aliases=["myai", "qwrun"], features=["Jev Finder"]),
        **correction_arguments(root, document))


def test_identity_statements_keep_unknown_owner_despite_known_supplier():
    evidence = [{"evidence_id": "d:v1:t0", "basis": "text", "text":
                 "myai is the user-facing name of qwrun. Symbiknow supplies its documents."}]
    candidates = project_candidate_details(evidence, projects=[project_identity("Symbiknow")])
    assert {"myai", "qwrun", "Symbiknow"} <= {r["name"] for r in candidates}
    assert identity_statements(evidence)[0]["passage"] == "myai is the user-facing name of qwrun"
    for candidate in candidates:
        assert candidate["reasons"] and candidate["supporting_passages"]
    other = [{"text": "Nebula owns the workflow. Symbiknow supplies documents.", "basis": "text"}]
    assert "Nebula" in project_candidates(other, projects=[project_identity("Symbiknow")])
    # An arbitrary folder is not a registry entry or evidence of ownership.
    assert project_candidates([{"text": "A standalone reference."}], folders=["Personal"]) == []


def test_full_source_reference_anchors_reach_jev_despite_sample_limit(monkeypatch):
    class Neighbors(list):
        source_evidence = [
            {"document_id": "d", "version": "v1", "evidence_id": "d:v1:t129", "text": "Exact indexed reference"},
            {"document_id": "d", "version": "v0", "evidence_id": "d:v0:t130", "text": "Stale reference"},
        ]
    captured = []
    def evaluate(document, evidence, neighbors, *args, **kwargs):
        captured.extend(evidence)
        return {"status": "evaluated"}
    monkeypatch.setattr(jev, "_organization_decision", evaluate)
    jev.organize_document({"document_id": "d", "version": "v1"},
                         [{"evidence_id": "d:v1:t0", "text": "Opening"}], Neighbors())
    assert [e["text"] for e in captured] == ["Opening", "Exact indexed reference"]


def test_far_apart_references_in_one_chunk_are_all_evaluated_with_exact_windows():
    import uuid
    import httpx2
    from typesafe_sdk import TypeSafeClient, RetryPolicy
    source = {"document_id": "manifest", "version": "v1"}
    text, neighbors = "", []
    for number in range(4):
        identity = str(uuid.uuid4())
        reference = f"Reference document_id={identity}."
        start = len(text)
        text += reference + "\n" + "Context describes this research collection. " * 100 + "\n"
        neighbors.append({"document_id": identity, "version": "v1", "candidate_source": "explicit_reference",
                          "references": [{"source_evidence_id": "manifest:v1:t0", "start": start,
                                          "end": start + len(reference), "reference_text": reference}],
                          "evidence": [{"evidence_id": f"{identity}:v1:t0", "basis": "text",
                                        "text": f"Company {number} substantive research report."}]})
    requests = []
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": 0.95}
            else:
                criteria = question["criteria"]
                chosen = ("related" if key.startswith("pair_") else
                          min((k for k, value in criteria.items() if "document_id=" in value), key=lambda k: len(criteria[k]))
                          if key.startswith("source_claim_") else next(iter(criteria)))
                answers[key] = {"type": "choice", "choice": chosen, "confidence": 0.99,
                                "probabilities": {k: float(k == chosen) for k in criteria}}
        return httpx2.Response(200, json={"model": "fixture", "usage": {}, "answers": answers})
    with TypeSafeClient(api_key="fixture", model="fixture", transport=httpx2.MockTransport(respond),
                        retry=RetryPolicy(max_retries=0)) as client:
        result = jev.organize_document(source, [{"evidence_id": "manifest:v1:t0", "text": text, "basis": "text"}],
                                       neighbors, links_only=True, client=client)
    assert result["status"] == "evaluated", result
    assert {link["document_id"] for link in result["links"]} == {n["document_id"] for n in neighbors}
    initial = [r for r in requests if any(k.startswith("pair_") for k in r["questions"])]
    assert len(initial) == 4
    offsets = set()
    for request in initial:
        docs = request["state"]["documents"]
        assert len(docs) == 2
        window = docs[0]["evidence"][0]
        assert docs[1]["document_id"] in window["text"]
        assert text[window["text_start"]:window["text_end"]] == window["text"]
        assert len(window["text"]) <= jev.MAX_TEXT
        offsets.add(window["text_start"])
    assert len(offsets) == 4
    for link in result["links"]:
        assert link["relation"] == "related"
        assert link["proof"]["checks"]["explicit_reference"] is True
        assert any(scope["supplied_ranges"][0]["truncated"] for scope in link["proof"]["context_scope"])


def test_all_thirteen_audited_owner_candidates_use_registry_not_feature_or_title():
    registry = store.ProjectCatalog([
        dict(**project_identity("Crazyidea"), features=["Jev Finder"]), project_identity("Symbiknow")])
    # Deliberately build a second immutable catalog; no global hardcoded alias merge.
    registry = store.ProjectCatalog([
        {**dict(registry[0]), "aliases": ["myai", "qwrun"]}, dict(registry[1])])
    fixtures = json.loads((Path(__file__).parents[1] / "fixtures/organization/project-candidate-audit.json").read_text())
    assert len(fixtures) == 13
    for case in fixtures:
        candidates = project_candidates([*case["evidence"], {"basis": "title", "text": case["filename"]}], projects=registry)
        assert "Crazyidea" in candidates, case["filename"]
        assert not {"Jev Finder", "Decode", "Final", "Batched", "Does", "Known"} & set(candidates)
        assert all("2026" not in name and "decision log" not in name for name in candidates)


def test_incidental_words_do_not_name_automatic_children_and_read_can_be_project():
    evidence = [{"text": "Does this document answer the question?\nRead this when starting work."}]
    assert not meaningful_subject("Crazyidea / Does", evidence)
    assert not meaningful_subject("Symbiknow / Read", evidence)
    assert meaningful_subject("Crazyidea / Search", [{"text": "Search ranks relevant library passages."}])
    assert project_candidates([{"basis": "text", "text": "# Read — Architecture\nRead is an app for books."}],
                              projects=[project_identity("Read")]) == ["Read"]
    metadata = descriptive_metadata([{"evidence_id": "d:v1:t0", "text":
                                     "Research report\nNYSE:LLY, dated 2026-10-23."}])
    assert metadata == {"dates": [{"value": "2026-10-23", "evidence_id": "d:v1:t0"}],
                        "tickers": [{"value": "NYSE:LLY", "evidence_id": "d:v1:t0"}],
                        "document_roles": [{"value": "Research report", "evidence_id": "d:v1:t0"}]}


def test_explicit_correction_preserves_suggestion_and_folder_and_survives_automatic_run(context):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    automatic = {**decision("Symbiknow / Search"), "canonical_project": project_identity("Symbiknow")}
    search.save_organization(root, doc["document_id"], "v1", automatic)
    edits.edit("move-documents", {"folder": "Read", "documents": [
        {"document_id": doc["document_id"], "expected_version": "v1"}]})
    before = json.loads(search.get_document_status(root, doc["document_id"])["organization_json"])
    assert before["effective_owner"]["name"] == "Symbiknow"
    assert before["manual_folder_override"]["folder"] == "Read"
    record = register(root, doc)
    search.save_organization(root, doc["document_id"], "v1", automatic)
    row = search.get_document_status(root, doc["document_id"])
    details = json.loads(row["organization_json"])
    assert row["folder"] == "Read"
    assert details["effective_owner"]["name"] == details["canonical_project"]["name"] == "Crazyidea"
    assert details["automatic_owner_suggestion"]["name"] == "Symbiknow"
    assert details["correction_provenance"][-1]["revision"] == record["revision"]
    assert projects.project_registry(root)[0]["aliases"] == ["myai", "qwrun"]
    assert store.catalog(root).canonical_names["jev finder"] == "Crazyidea"
    assert projects.history(root, doc["document_id"])[0]["reason"] == record["reason"]
    cleared = projects.overlay(root, [{"document_id": doc["document_id"], "organization_json": "{}"}])[0]
    assert json.loads(cleared["organization_json"])["automatic_owner_suggestion"]["name"] == "Symbiknow"
    # Persisted registry works after clearing process caches as well.
    store._CATALOG_CACHE.values.clear()
    assert store.catalog(root).canonical_names["qwrun"] == "Crazyidea"


@pytest.mark.parametrize("field,value", [
    ("expected_version", "v0"), ("expected_evidence_revision", "stale"),
    ("expected_manual_revision", "stale"), ("expected_ownership_revision", "stale"),
])
def test_correction_guard_failure_does_not_change_registry(context, field, value):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    arguments = {**correction_arguments(root, doc), field: value}
    with pytest.raises(ValueError):
        projects.correct_ownership(root, doc["document_id"], {"name": "Crazyidea"}, **arguments)
    assert not projects.project_registry(root)
    assert not projects.ownership_overrides(root, [doc["document_id"]])


@pytest.mark.parametrize("text", [
    "Crazyidea compares qwrun with Symbiknow.",
    "myai is the user-facing name of qwrun. Source: /Users/example/Projects/crazyidea/runner. Symbiknow supplies its documents.",
])
def test_alias_registration_requires_relationship_passage_not_cooccurrence(context, text):
    root, _, _ = context
    doc = indexed(root, content=text.encode())
    with pytest.raises(ValueError, match="explicit identity"):
        projects.correct_ownership(root, doc["document_id"], {"name": "Crazyidea", "aliases": ["Symbiknow"]},
                                   **correction_arguments(root, doc))
    assert projects.project_registry(root) == []


def test_deleted_source_erases_identity_quotes_and_registry(context):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    register(root, doc)
    projects.purge_document(root, doc["document_id"])
    assert not projects.history(root, doc["document_id"])
    assert not projects.project_registry(root)
    for path in (root / "temp").glob("project-identities.sqlite3*"):
        assert b"myai is the user-facing" not in path.read_bytes()


def test_registry_aliases_expire_with_evidence_but_manual_owner_remains(context):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    record = register(root, doc)
    # Exercise a persisted catalog too: it must not resurrect stale aliases.
    search.save_organization(root, doc["document_id"], "v1", {
        **decision("Crazyidea"), "canonical_project": record["effective_owner"]})
    assert store.catalog(root).canonical_names["myai"] == "Crazyidea"
    documents = search._table(root, "documents")
    documents.update(where=f"document_id = '{doc['document_id']}'", values={"evidence_revision": "replacement"})
    assert projects.project_registry(root) == []
    assert "myai" not in store.catalog(root).canonical_names
    details = json.loads(search.get_document_status(root, doc["document_id"])["organization_json"])
    assert details["effective_owner"]["name"] == "Crazyidea"


def test_repeated_correction_keeps_one_copy_of_registry_evidence(context):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    record = register(root, doc)
    arguments = correction_arguments(root, doc)
    arguments["expected_ownership_revision"] = record["revision"]
    projects.correct_ownership(root, doc["document_id"],
        {"name": "Crazyidea", "aliases": ["myai", "qwrun"], "features": ["Jev Finder"]}, **arguments)
    assert len(projects.project_registry(root)[0]["identity_evidence"]) == 1
    assert len(projects.history(root, doc["document_id"])) == 2


def test_corrected_owner_skips_inference_and_topics_never_receive_folder_names(context, monkeypatch):
    from tests.ai.test_jev_topics import httpx2, TypeSafeClient, RetryPolicy
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    search.save_organization(root, doc["document_id"], "v1", {
        **decision("Symbiknow"), "canonical_project": project_identity("Symbiknow")})
    register(root, doc)
    row = search.get_document_status(root, doc["document_id"])
    requests = []
    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": 0.95}
            else:
                answers[key] = {"type": "choice", "choice": "project_root", "confidence": 0.95,
                                "probabilities": {k: float(k == "project_root") for k in question["criteria"]}}
        return httpx2.Response(200, json={"model": "fixture", "usage": {}, "answers": answers})
    with TypeSafeClient(api_key="fixture", model="fixture", transport=httpx2.MockTransport(respond),
                        retry=RetryPolicy(max_retries=0)) as client:
        result = jev.organize_document(row, search.document_evidence(root, doc["document_id"], "v1"), [],
            groups=["Symbiknow / Read", "Jev Finder / Does", "2026-10-23", "NYSE:LLY"],
            projects=store.catalog(root), client=client)
    assert result["status"] == "evaluated"
    assert result["effective_owner"]["name"] == "Crazyidea"
    assert result["automatic_owner_suggestion"]["name"] == "Symbiknow"
    assert len(requests) == 2
    assert not any("project_owner" in req["questions"] for req in requests)
    assert set(requests[1]["questions"]) == set(topics.DEFINITIONS)
    assert result["groups"] == list(topics.DEFINITIONS)


def test_ownership_history_read_retains_provenance_and_effective_identity(context):
    from symbiknow.core.application import ApplicationContext
    root, _, _ = context
    document = indexed(root, name="identity.md", content=IDENTITY.encode())
    correction = register(root, document)
    history = ApplicationContext(root).catalog.history(document["document_id"], limit=1)
    assert history["current"]["project"]["name"] == "Crazyidea"
    event = history["entries"][0]
    assert event["id"] == correction["revision"] and event["action"] == "correct-ownership"
    assert event["actor"] == correction["actor"] and event["timestamp"] == correction["created_at"]
    assert event["effective_owner"]["id"] == correction["effective_owner"]["id"]


def test_reset_retires_owner_correction_into_history(context):
    root, _, _ = context
    doc = indexed(root, content=IDENTITY.encode())
    search.save_organization(root, doc["document_id"], "v1",
                             {**decision("Symbiknow / Search"), "canonical_project": project_identity("Symbiknow")})
    record = register(root, doc)
    assert projects.ownership_overrides(root, [doc["document_id"]])
    assert projects.reset_ownership(root, [doc["document_id"]], request_id="r1") == [doc["document_id"]]
    assert projects.reset_ownership(root, [doc["document_id"]], request_id="r1") == []  # Replay.
    assert projects.ownership_overrides(root, [doc["document_id"]]) == {}
    details = json.loads(search.get_document_status(root, doc["document_id"])["organization_json"])
    assert details["effective_owner"]["name"] == "Symbiknow" and "ownership_correction" not in details
    history = projects.history(root, doc["document_id"])
    assert [h.get("action", "correct-ownership") for h in history] == ["correct-ownership", "reset-ownership"]
    assert history[1]["previous_revision"] == record["revision"]


def test_registered_project_survives_one_changed_evidence_source(context):
    root, _, _ = context
    stable = indexed(root, name="overview.md", content=IDENTITY.encode())
    changing = indexed(root, name="decision-log.md", content=IDENTITY.encode())
    register(root, stable)
    register(root, changing)
    evidence = {e["document_id"] for e in projects.project_registry(root)[0]["identity_evidence"]}
    assert evidence == {stable["document_id"], changing["document_id"]}
    storage.save_file(root, b"appended decision log entry", "decision-log.md", document_id=changing["document_id"])
    [project] = projects.project_registry(root)
    assert project["name"] == "Crazyidea" and project["aliases"] == ["myai", "qwrun"]
    assert {e["document_id"] for e in project["identity_evidence"]} == {stable["document_id"]}


def test_one_letter_names_are_never_project_candidates():
    evidence = [{"evidence_id": "d:v1:t0", "basis": "text",
                 "text": "S runs the batched benchmark. For S the MLX B64 path stays faster."}]
    assert "S" not in project_candidates(evidence)
    assert "S" not in project_candidates(evidence, projects=[project_identity("S")])
