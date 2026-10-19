"""Historical passage-policy contracts; new production proof contracts are in test_jev_proof.py."""

import json

import httpx2
from typesafe_sdk import RetryPolicy, TypeSafeClient

from app.jev import _judge_matches_legacy as judge_matches, _organize_document_legacy as organize_document


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
    with sdk_client({"judge_0": "direct"}) as client:
        result = judge_matches("What is France's capital?", [match()], client=client)
    assert result["status"] == "evaluated"
    judgment = result["matches"][0]["jev"]
    assert judgment["label"] == "direct"
    assert judgment["supporting_chunk_ids"] == ["doc1:v1:0"]


def test_passage_primitives_do_not_receive_neighbor_text_in_shared_state(monkeypatch):
    from app import jev
    calls=[]
    def capture(state, questions, client=None):
        calls.append((state, questions))
        with sdk_client() as sdk:
            return sdk.system_one(state=state, questions=questions)
    monkeypatch.setattr(jev,"_call",capture)
    d=match(text="Current Atlas history is kept without the assumed mechanism.")
    d["evidence"].append(dict(d["evidence"][0], evidence_id="doc1:v1:other",
                              text="Independent footer: colors and copyright."))
    result=judge_matches("Where is the mechanism Atlas uses for its history?",[d])
    assert result["status"] == "evaluated" and len(calls) == 1
    state,questions=calls[0]
    assert "evidence" not in state["document"]
    assert all(r["text"] not in json.dumps(state) for r in d["evidence"])
    for prefix in ["entity","support","conflict","obsolete"]:
        for n,row in enumerate(d["evidence"]):
            instruction=questions[f"{prefix}_0_{n}"].instructions
            assert instruction["passage"] == row["text"]
            assert d["evidence"][1-n]["text"] not in json.dumps(instruction)
    assert len(questions["judge_0"].instructions["evidence"]) == 2
    assert len(questions["disagreement_0"].instructions["evidence"]) == 2


def test_unsupported_direct_claim_becomes_uncertain():
    with sdk_client({"judge_0": "direct"}, {"support_0_0": 0.1}) as client:
        result = judge_matches("Question", [match()], client=client)
    assert result["matches"][0]["jev"]["label"] == "uncertain"


def test_invalid_provider_selection_is_rejected():
    with sdk_client({"judge_0": "invented-document-id"}) as client:
        result = judge_matches("Question", [match()], client=client)
    assert result["status"] == "unavailable"
    assert result["matches"] == [match()]


def test_visual_only_evidence_never_sent_as_text_judgment():
    result = judge_matches("Question", [match(basis="image", text="")])
    assert result["status"] == "not_evaluated"
    assert result["matches"][0]["jev"]["basis"] == "visual_match"


def test_ocr_basis_is_explicit():
    with sdk_client({"judge_0": "direct"}) as client:
        result = judge_matches("Question", [match(basis="ocr")], client=client)
    assert result["matches"][0]["jev"]["basis"] == ["ocr"]


def test_missing_token_leaves_search_usable(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert judge_matches("Question", [match()])["status"] == "unavailable"


def test_cross_document_disagreement_retains_local_citations_and_support():
    docs = [match("keeps", text="Current policy preserves versions."),
            match("deletes", text="Current policy deletes all versions.")]
    with sdk_client(nouls={"cross_0": 0.95, "cross_1": 0.95}) as client:
        result = judge_matches("Does the policy preserve versions?", docs, client=client)
    assert result["cross_document_assessment"]["status"] == "evaluated"
    for row in result["matches"]:
        j = row["jev"]
        assert j["label"] == "uncertain" and j["coverage"] == "unknown"
        assert j["evidence_disagreement"] == "accepted"
        assert j["disagreement_chunk_ids"] == [row["evidence"][0]["evidence_id"]]
        assert j["supporting_chunk_ids"] == j["disagreement_chunk_ids"]
        assert not j["conflicting_chunk_ids"]


def test_cross_document_agreement_and_wrong_entity_do_not_conflict():
    docs = [match("correct"), match("other")]
    with sdk_client(nouls={"entity_1_0": 0.1}) as client:
        result = judge_matches("Question", docs, client=client)
    assert "cross_document_assessment" not in result
    assert result["matches"][0]["jev"]["label"] == "direct"
    assert not result["matches"][1]["jev"]["supporting_chunk_ids"]
    with sdk_client() as client:
        result = judge_matches("Question", docs, client=client)
    assert result["cross_document_assessment"]["status"] == "evaluated"
    assert all(m["jev"]["evidence_disagreement"] == "none_detected" for m in result["matches"])


def test_cross_comparison_cache_depends_on_all_supplied_windows(monkeypatch):
    from app import jev
    monkeypatch.setattr(jev, "_JUDGMENTS", jev.OrderedDict())
    monkeypatch.setattr(jev, "_DISAGREEMENTS", jev.OrderedDict())
    calls = []
    def call(state, questions, client=None):
        calls.append(state)
        with sdk_client() as sdk:
            return sdk.system_one(state=state, questions=questions)
    monkeypatch.setattr(jev, "_call", call)
    docs = [match("one"), match("two")]
    first = judge_matches("Question", docs, cache_namespace="fixture")
    assert len(calls) == 3
    second = judge_matches("Question", docs, cache_namespace="fixture")
    assert second["cached"] == 2 and len(calls) == 3
    assert first["matches"] == second["matches"]
    docs[1]["evidence"][0]["text"] = "Changed current passage."
    changed = judge_matches("Question", docs, cache_namespace="fixture")
    assert changed["cached"] == 1 and len(calls) == 5
    assert calls[-1]["passages"][1]["text"] == "Changed current passage."


def test_cross_comparison_failure_is_explicit_uncertainty_and_is_never_cached(monkeypatch):
    from app import jev
    monkeypatch.setattr(jev, "_JUDGMENTS", jev.OrderedDict())
    monkeypatch.setattr(jev, "_DISAGREEMENTS", jev.OrderedDict())
    attempts = []
    def call(state, questions, client=None):
        if any(k.startswith("cross_") for k in questions):
            attempts.append(state)
            raise TimeoutError("fixture outage")
        with sdk_client() as sdk:
            return sdk.system_one(state=state, questions=questions)
    monkeypatch.setattr(jev, "_call", call)
    docs = [match("one"), match("two")]
    for repeat in range(2):
        result = judge_matches("Question", docs, cache_namespace="fixture")
        assert result.get("cached", 0) == (2 if repeat else 0)
        assert result["cross_document_assessment"]["status"] == "unavailable"
        for m in result["matches"]:
            j = m["jev"]
            assert j["cross_document_assessment_status"] == "unavailable"
            assert j["label"] == "uncertain" and j["coverage"] == "unknown"
            assert j["supporting_chunk_ids"] and j["decision_reason"] == "disagreement_unavailable"
    assert len(attempts) == 2 and not jev._DISAGREEMENTS


def test_cross_comparison_is_one_bounded_request_for_evaluated_candidates(monkeypatch):
    from app import jev
    calls = []
    def call(state, questions, client=None):
        calls.append((state, questions))
        with sdk_client() as sdk:
            return sdk.system_one(state=state, questions=questions)
    monkeypatch.setattr(jev, "_call", call)
    docs = [match(str(i)) for i in range(9)]
    for d in docs:
        d["evidence"] = [dict(d["evidence"][0], evidence_id=f"{d['document_id']}:v1:{n}")
                         for n in range(7)]
    result = judge_matches("Question", docs)
    assert len(calls) == 9  # eight candidate calls, one comparison
    state, questions = calls[-1]
    assert len(state["passages"]) == len(questions) == 16
    assert len({p["document_id"] for p in state["passages"]}) == 8
    assert result["matches"][-1]["jev"]["reason"] == "candidate_limit"


def test_organization_links_preserve_versions_and_evidence():
    document, neighbor = match(text="Atlas manages geography. The capital is Paris."), match("doc2")
    with sdk_client(
        {
            "project_owner": "Atlas",
            "folder": "Atlas / Geography",
            "link_0": "supports",
            "source_0": "p0",
            "target_0": "p0",
        }
    ) as client:
        result = organize_document(
            document,
            document["evidence"],
            [neighbor],
            folders=["Atlas / Geography"],
            groups=["Places"],
            client=client,
        )
    assert result["status"] == "evaluated"
    assert result["folder"] == "Atlas / Geography"
    assert "Places" in result["groups"]
    assert result["links"][0] == {
        "document_id": "doc2",
        "version": "v1",
        "source_version": "v1",
        "relation": "supports",
        "source_chunk_id": "doc1:v1:0",
        "target_chunk_id": "doc2:v1:0",
        "confidence": 0.95,
    }


def test_hash_duplicates_bypass_neighbor_cap_and_model_guesses_are_not_duplicates():
    document, different, exact = match(), match("other"), match("exact")
    document["sha256"] = exact["sha256"] = "a" * 64
    different["sha256"] = "b" * 64
    with sdk_client(
        {"folder": "project_root", "link_0": "duplicate", "source_0": "p0", "target_0": "p0"}
    ) as client:
        result = organize_document(
            document, document["evidence"], [different, exact], folders=["Geography"], client=client
        )
    links = {link["document_id"]: link for link in result["links"]}
    assert links["exact"]["relation"] == "duplicate"
    assert links["exact"]["basis"] == "sha256"
    assert links["other"]["relation"] == "related"


def test_new_heading_subject_reserved_after_large_existing_vocabulary():
    document = match(
        text="# Cedar Shop / Customer support / Warranty\nManufacturing defects are covered for 24 months."
    )
    with sdk_client({"folder": "f0"}) as client:
        result = organize_document(
            document,
            document["evidence"],
            [],
            folders=[f"Irrelevant {i}" for i in range(50)],
            client=client,
        )
    assert result["folder"] == "Cedar Shop / Customer support"


def test_unrelated_is_explicit_and_never_carries_answer_support():
    with sdk_client({"judge_0": "unrelated"}, {"support_0_0": 0.01}) as client:
        result = judge_matches(
            "Which refund fields are required?", [match(text="Herbs need sunlight.")], client=client
        )
    verdict = result["matches"][0]["jev"]
    assert verdict["label"] == "unrelated"
    assert verdict["supporting_chunk_ids"] == []


def test_partial_answer_retains_a_real_supporting_passage():
    document = match(text="Refund requests need the invoice number.")
    with sdk_client({"judge_0": "partial"}, {"support_0_0": 0.95}) as client:
        result = judge_matches("Which two refund fields are required?", [document], client=client)
    assert result["matches"][0]["jev"]["label"] == "partial"
    assert result["matches"][0]["jev"]["supporting_chunk_ids"] == ["doc1:v1:0"]
