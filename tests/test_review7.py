"""Review-7 contracts against actual SDK serialization and isolated OCFL/LanceDB.

These are authored regression cases, not independent provider accuracy labels.
"""

import json
import random

import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from app import jev, organization, search, server, storage, ui
from test_search import FixtureEmbedder


def evidence(text, identity="opaque"):
    return [
        {
            "evidence_id": f"{identity}:v1:t0",
            "text": text,
            "basis": "text",
            "provenance": {"headings": [], "pages": [{"page_no": 2}]},
        }
    ]


def client_for(
    owner, subject="project_root", presence=0.95, confidence=0.95, subject_confidence=0.95
):
    calls = []

    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": presence}
            else:
                options = question["criteria"]
                wanted = owner if key == "project_owner" else subject
                chosen = next((k for k, v in options.items() if v == wanted), wanted)
                answers[key] = {
                    "type": "choice",
                    "choice": chosen,
                    "confidence": subject_confidence if key == "folder" else confidence,
                    "probabilities": {k: float(k == chosen) for k in options},
                }
        return httpx2.Response(
            200, json={"model": "jev-regression", "usage": {}, "answers": answers}
        )

    return TypeSafeClient(
        api_key="test-only",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    ), calls


@pytest.mark.parametrize("project", ["Symbiknow", "Cedar Shop"])
def test_long_heading_and_title_prose_keep_prefix(project):
    for title in [
        "Bounded taxonomy preparation and scale limits",
        "How can we retain every version?",
    ]:
        assert organization.topic_paths(evidence(f"# {project} / Organization / {title}")) == [
            f"{project} / Organization"
        ]
    assert organization.topic_paths(evidence("We must reset / rebuild the library")) == []


@pytest.mark.parametrize("project", ["Symbiknow", "NovaPay"])
def test_project_first_choice_shuffle_and_subject_abstention(project):
    rows = evidence(
        f"# {project} / Storage / Keep every original version without losing its history\n{project} keeps immutable originals."
    )
    document = {"document_id": "opaque", "version": "v1", "filename": "A-903.txt"}
    identities = []
    for seed in range(3):
        folders = [f"{project} / Storage", "Other / Storage", "Bounded / Manual"]
        random.Random(seed).shuffle(folders)
        client, calls = client_for(project, f"{project} / Storage", subject_confidence=0.2)
        with client:
            decision = jev.organize_document(document, rows, [], folders, client=client)
        assert decision["status"] == "evaluated"
        assert decision["folder"] == project
        identities.append(decision["canonical_project"]["id"])
        assert "project_presence" in calls[0]["questions"]
        assert "folder" not in calls[0]["questions"]
        assert calls[1]["state"]["document"]["accepted_project"]["name"] == project
        assert decision["folder_confidence"] == 0.2
        assert decision["ownership"]["probabilities"]
    assert len(set(identities)) == 1


@pytest.mark.parametrize(
    "outcome,presence,confidence",
    [
        ("no_project", 0.05, 0.95),
        ("multiple_projects", 0.4, 0.95),
        ("insufficient_evidence", 0.5, 0.95),
        ("Symbiknow", 0.95, 0.2),
    ],
)
def test_mention_shared_reference_and_unclear_owner_do_not_make_random_roots(
    outcome, presence, confidence
):
    rows = evidence("General OCFL reference. Symbiknow and NovaPay cite it as a shared dependency.")
    client, _ = client_for(outcome, presence=presence, confidence=confidence)
    with client:
        decision = jev.organize_document(
            {"document_id": "opaque", "version": "v1"},
            rows,
            [],
            ["Symbiknow / Storage", "NovaPay / Storage"],
            client=client,
        )
    assert decision["status"] == "evaluated"
    assert decision["folder"] == ""
    assert decision["canonical_project"] is None


def test_candidates_do_not_hide_other_owner_and_aliases_are_exact():
    roster = [organization.project_identity("NovaPay") | {"aliases": ["NP Payments"]}]
    rows = evidence(
        "Unlike Symbiknow, NP Payments owns this billing workflow. NP Payments checks invoices."
    )
    candidates = organization.project_candidates(rows, ["Symbiknow / Storage"], roster)
    assert {"Symbiknow", "NovaPay"} <= set(candidates)
    assert organization.project_identity("NP Payments", roster)["id"] == roster[0]["id"]
    assert organization.project_identity("Nova Pay", roster)["id"] != roster[0]["id"]
    assert (
        organization.project_candidates(evidence("Atlas s / Search / Flow"), ["Atlas / Search"])[0]
        != "Atlas"
    )
    ocr = [{**r, "basis": "ocr"} for r in evidence("Atlas s / Search / Flow")]
    assert organization.project_candidates(ocr, ["Atlas / Search"])[0] == "Atlas"


def test_revision_publication_manual_override_reference_validation_and_original_hashes(
    tmp_path, monkeypatch
):
    from app.ingest import index_document
    from app.organization_edits import edit

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    storage.init_storage(tmp_path)
    meta = storage.save_file(tmp_path, b"NovaPay keeps every version.", "opaque.txt")
    index_document(tmp_path, meta, b"NovaPay keeps every version.", FixtureEmbedder())
    before = ui.library({})
    rows = search.document_evidence(tmp_path, meta["document_id"], "v1")
    project = organization.project_identity("NovaPay")
    decision = {
        "status": "evaluated",
        "folder": "NovaPay / Storage",
        "canonical_project": project,
        "evidence_ids": [rows[0]["evidence_id"]],
        "links": [],
    }
    search.save_organization(tmp_path, meta["document_id"], "v1", decision)
    after = ui.library({})
    assert before["index_revision"] == after["index_revision"]
    assert before["organization_revision"] != after["organization_revision"]
    assert search.project_roster(tmp_path) == [project]
    edit(
        "move-documents",
        {
            "folder": "Review / Renamed",
            "documents": [{"document_id": meta["document_id"], "expected_version": "v1"}],
        },
    )
    search.save_organization(tmp_path, meta["document_id"], "v1", decision)
    assert search.get_document_status(tmp_path, meta["document_id"])["folder"] == "Review / Renamed"
    assert storage.read_metadata(tmp_path, meta["document_id"])["sha256"] == meta["sha256"]
    with pytest.raises(ValueError, match="evidence"):
        search.save_organization(
            tmp_path, meta["document_id"], "v1", decision | {"evidence_ids": ["invented"]}
        )


def test_search_cache_metadata_changes_conflicts_low_confidence_and_query_windows(monkeypatch):
    from test_jev_proof import sdk

    calls = []

    def provider(state, questions, client=None):
        calls.append(state)
        with sdk({"coverage": "correction"}, confidence=0.7) as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    rows = evidence(
        "Introduction " * 400
        + "NovaPay does not delete originals. Adopted policy retains every version."
    )
    doc = {"document_id": "opaque", "version": "v1", "evidence": rows, "folder": "Old"}
    query = "Why does NovaPay delete originals?"
    first = jev.judge_matches(query, [doc], cache_namespace="cache-regression")
    second = jev.judge_matches(
        query, [doc | {"folder": "Review / Renamed"}], cache_namespace="cache-regression"
    )
    assert len(calls) == 2  # The uncertain first pass receives an exact-text check.
    assert second["matches"][0]["folder"] == "Review / Renamed"
    judgment = first["matches"][0]["jev"]
    assert judgment["premise_correction_status"] == "accepted"
    assert judgment["conflicting_chunk_ids"] == [rows[0]["evidence_id"]]
    assert "does not delete" in judgment["evaluated_evidence"][0]["text"]
    assert not judgment["evaluated_evidence_complete"]
    updated = doc | {"version": "v2", "evidence": [rows[0] | {"evidence_id": "opaque:v2:t0"}]}
    jev.judge_matches(query, [updated], cache_namespace="cache-regression")
    assert len(calls) == 4


def test_document_sampling_reaches_tail_and_query_adds_stored_adjacent_context(tmp_path):
    storage.init_storage(tmp_path)
    meta = storage.save_file(tmp_path, b"fixture", "opaque.txt")
    rows = [
        {
            "chunk_id": f"{meta['document_id']}:v1:t{i}",
            "text": "cat policy" if i == 18 else f"Adjacent context {i} with negation and dates",
            "basis": "text",
            "provenance_json": json.dumps({"page": i + 1}),
            "vector": [1.0, 0.0, 0.1],
        }
        for i in range(20)
    ]
    search.put_chunks(tmp_path, meta, rows, "test-only-fixture")
    search.set_document_status(
        tmp_path, meta, status="indexed", indexed_version="v1", chunk_count=20
    )
    sample = search.document_evidence(tmp_path, meta["document_id"], "v1", limit=3)
    assert len(sample) == 3
    result = search.find_documents(tmp_path, "cat", mode="keyword")
    ids = {r["evidence_id"] for r in result[0]["evidence"]}
    assert {
        f"{meta['document_id']}:v1:t17",
        f"{meta['document_id']}:v1:t18",
        f"{meta['document_id']}:v1:t19",
    } <= ids


def test_bounded_roster_does_not_exclude_grounded_new_project():
    roster = [organization.project_identity(f"Existing {i}") for i in range(100)]
    rows = evidence("# NewHarbor / Storage / Design\nNewHarbor retains every version.")
    assert organization.project_candidates(rows, projects=roster)[0] == "NewHarbor"
    assert len(organization.project_candidates(rows, projects=roster)) <= 16
