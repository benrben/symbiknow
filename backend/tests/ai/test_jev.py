"""Current joint-proof and organization contracts with typed SDK responses."""

import json
import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient
from symbiknow.ai import jev
from symbiknow.ai import proof as jev_proof
from symbiknow.ai.jev import judge_matches, organize_document
from tests.ai.test_jev_proof import sdk


def sdk_client(choices=None, nouls=None):
    choices, nouls = choices or {}, nouls or {}

    def respond(request):
        body = json.loads(request.content)
        assert request.url.path == "/v1/systemone"
        assert body["state"]
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "choice":
                options = question["criteria"]
                choice = choices.get(key, next(iter(options)))
                if choice not in options and choice in options.values():
                    choice = next(
                        name for name, description in options.items() if description == choice
                    )
                answers[key] = {
                    "type": "choice",
                    "choice": choice,
                    "confidence": 0.95,
                    "probabilities": {name: float(name == choice) for name in options},
                }
            else:
                answers[key] = {
                    "type": "noul",
                    "noul": nouls.get(
                        key,
                        (0.95 if choices.get("judge_" + key.removeprefix("complete_"), "direct") == "direct" else 0.05)
                        if key.startswith("complete_") else
                        0.01
                        if key.startswith(
                            ("conflict_", "premise_", "disagreement_", "historical_", "obsolete_", "scope_mismatch_", "cross_")
                        )
                        else 0.95,
                    ),
                }
        return httpx2.Response(200, json={"model": "jev-test", "usage": {}, "answers": answers})

    return TypeSafeClient(
        api_key="test-fixture-not-a-real-key",
        model="jev-test",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    )


def match(document_id="doc1", basis="text", text="The capital is Paris."):
    return {
        "document_id": document_id,
        "version": "v1",
        "filename": "France.txt",
        "evidence": [
            {
                "evidence_id": f"{document_id}:v1:0",
                "text": text,
                "basis": basis,
                "provenance": {"page": 1},
            }
        ],
    }



def test_sdk_judgment_selects_real_evidence():
    with sdk() as client:
        result = judge_matches("What is France's capital?", [match()], client=client)
    assert result["status"] == "evaluated"
    assert result["matches"][0]["jev"]["supporting_chunk_ids"] == ["doc1:v1:0"]


def test_joint_proof_binds_all_original_passages():
    d = match(text="Current Atlas history is kept without the assumed mechanism.")
    d["evidence"].append(dict(d["evidence"][0], evidence_id="doc1:v1:other",
                              text="Independent footer: colors and copyright."))
    requests = []
    with sdk(requests=requests) as client:
        result = judge_matches("Where is the mechanism?", [d], client=client)
    assert result["status"] == "evaluated"
    supplied = requests[0]["state"]["documents"][0]["evidence"]
    assert [p["text"] for p in supplied] == [p["text"] for p in d["evidence"]]
    assert len(result["matches"][0]["jev"]["verification_dependencies"]) == 2


def test_invalid_provider_selection_is_rejected():
    with sdk({"coverage": "invented-document-id"}) as client:
        assert judge_matches("Question", [match()], client=client)["status"] == "unavailable"


def test_visual_only_evidence_never_sent_as_text_judgment():
    result = judge_matches("Question", [match(basis="image", text="")])
    assert result["status"] == "not_evaluated"
    assert not result["matches"][0]["jev"].get("supporting_chunk_ids")


def test_ocr_basis_is_explicit():
    with sdk() as client:
        result = judge_matches("Question", [match(basis="ocr")], client=client)
    assert result["matches"][0]["jev"]["basis"] == ["ocr"]


def test_missing_token_leaves_search_usable(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert judge_matches("Question", [match()])["status"] == "unavailable"


def test_cross_document_conflicts_require_context_and_do_not_promote_citations():
    docs = [match("keeps", text="Current policy preserves versions."),
            match("deletes", text="Current policy deletes all versions.")]
    with sdk({"coverage": "conflicting"}) as client:
        result = judge_matches("Does the policy preserve versions?", docs, client=client)
    assert not jev.answer_results(result["matches"], result)[0]
    assert all(row["jev"]["coverage"] == "unknown" for row in result["matches"])


def test_cache_depends_on_all_supplied_windows(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    calls = []
    def call(state, questions, client=None):
        calls.append(state)
        with sdk() as client:
            return client.system_one(state=state, questions=questions)
    monkeypatch.setattr(jev, "_call", call)
    docs = [match("one"), match("two")]
    judge_matches("Question", docs, cache_namespace="fixture")
    assert judge_matches("Question", docs, cache_namespace="fixture")["cached"] == 2
    assert len(calls) == 1
    docs[1]["evidence"][0]["text"] = "Changed current passage."
    assert judge_matches("Question", docs, cache_namespace="fixture")["cached"] == 0
    assert len(calls) == 2


def test_provider_failure_never_cached(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    attempts = []
    def call(*args, **kwargs):
        attempts.append(1)
        raise TimeoutError("fixture outage")
    monkeypatch.setattr(jev, "_call", call)
    for _ in range(2):
        assert judge_matches("Question", [match()], cache_namespace="fixture")["status"] == "unavailable"
    assert len(attempts) == 2 and not jev_proof._CACHE


@pytest.mark.parametrize("coverage,expected", [("missing", "none"), ("partial", "partial"),
                                               ("complete", "complete")])
def test_coverage_retains_source_citations(coverage, expected):
    with sdk({"coverage": coverage}) as client:
        result = judge_matches("Which refund fields are required?", [match()], client=client)
    verdict = result["matches"][0]["jev"]
    assert verdict["coverage"] == expected
    assert bool(verdict["supporting_chunk_ids"]) is (coverage != "missing")


def test_organization_links_preserve_versions_and_evidence():
    document, neighbor = match(text="Atlas manages geography. The capital is Paris."), match("doc2")
    with sdk_client({"project_owner": "Atlas", "folder": "Atlas / Geography",
                     "pair_1_0_0": "supports"}) as client:
        result = organize_document(document, document["evidence"], [neighbor],
                                   folders=["Atlas / Geography"], groups=["Places"], client=client)
    assert result["status"] == "evaluated" and result["folder"] == "Atlas / Geography"
    link = result["links"][0]
    assert (link["document_id"], link["version"], link["source_version"]) == ("doc2", "v1", "v1")
    assert link["source_chunk_id"] == "doc1:v1:0" and link["target_chunk_id"] == "doc2:v1:0"


def test_hash_duplicates_are_bound_to_independent_source_ids():
    document, different, exact = match(), match("other"), match("exact")
    document["sha256"] = exact["sha256"] = "a" * 64
    different["sha256"] = "b" * 64
    with sdk_client({"folder": "project_root", "pair_1_0_0": "related"}) as client:
        result = organize_document(document, document["evidence"], [different, exact],
                                   folders=["Geography"], client=client)
    links = {link["document_id"]: link for link in result["links"]}
    assert links["exact"]["relation"] == "duplicate" and links["exact"]["basis"] == "sha256"
    assert links["other"]["relation"] == "related"


def test_new_heading_subject_reserved_after_large_existing_vocabulary():
    document = match(text="# Cedar Shop / Customer support / Warranty\nManufacturing defects are covered for 24 months.")
    with sdk_client({"folder": "f0"}) as client:
        result = organize_document(document, document["evidence"], [],
                                   folders=[f"Irrelevant {i}" for i in range(50)], client=client)
    assert result["folder"] == "Cedar Shop / Customer support"
