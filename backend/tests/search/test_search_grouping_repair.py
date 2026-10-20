"""Regressions for owner context, strict answer results and concurrent decisions."""

import asyncio
from copy import deepcopy

import pytest
from mcp import Client

from symbiknow.ai import jev
from symbiknow.organization import policy as organization
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.search.metrics import CURRENT, add
from tests.ai.test_jev import match, sdk_client


def project(name, aliases=()):
    return {"id": name.lower(), "name": name, "aliases": list(aliases)}


def test_owner_candidates_canonicalize_and_reserve_real_project_before_noise():
    evidence = [
        {"evidence_id": f"d:v1:t{i}", "text": text, "basis": "ocr"}
        for i, text in enumerate(
            [
                "ATLAS / IMPLEMENTATION DIAGRAM / 3",
                "Document / Storage",
                "3 / Convert text",
                "Download / Original",
                "Atlas MCP / protocol",
                "Atlas stores originals with OCFL.",
            ]
        )
    ]
    expected = organization.project_candidates(
        evidence, folders=["ATLAS / Search"], projects=[project("Atlas"), project("OCFL")]
    )
    assert expected == ["Atlas", "OCFL"]
    assert (
        organization.project_candidates(
            list(reversed(evidence)), projects=[project("OCFL"), project("Atlas")]
        )
        == expected
    )
    assert organization.project_candidates(
        evidence, projects=[project("Atlas", ["ATLAS"])], limit=1
    ) == ["Atlas"]


def test_owner_evidence_survives_topical_sampling_and_new_names_still_work():
    rows = [
        {"evidence_id": f"d:v1:t{i}", "text": "Generic validation results.", "basis": "text"}
        for i in range(20)
    ]
    rows[14]["text"] = "Atlas / Validation / Results\nProject tests exercise immutable storage."
    selected = organization.ownership_evidence(rows, ["Atlas"])
    assert rows[14] in selected and len(selected) <= 6
    assert "Aster Works" in organization.project_candidates(
        [{"text": "Aster Works manages invoice refunds."}]
    )
    # A misleading filename may suggest a known owner, but cannot assign it.
    evidence = [
        {"evidence_id": "d:v1:t0", "text": "A standalone guide to pruning roses.", "basis": "text"}
    ]
    with sdk_client({"project_owner": "no_project"}, {"project_presence": 0.02}) as client:
        result = jev.organize_document(
            {"document_id": "d", "version": "v1", "filename": "Atlas guide.txt"},
            evidence,
            [],
            projects=[project("Atlas")],
            client=client,
        )
    assert result["folder"] == ""


def judgment(**changes):
    return (
        dict(
            status="evaluated",
            label="direct",
            policy_label="direct",
            model_label="direct",
            model_confidence=0.95,
            coverage="complete",
            supporting_chunk_ids=["doc1:v1:0"],
            conflicting_chunk_ids=[],
            premise_correction_status="none_accepted",
            evidence_disagreement="none_detected",
            decision_reason="supported_coverage",
        )
        | changes
    )


@pytest.mark.parametrize("limit", [8, 84])
def test_no_answer_never_publishes_unchecked_or_merely_related_files(limit):
    docs = [
        dict(
            match(str(i)),
            jev=judgment(
                label="related", policy_label="related", coverage="none", supporting_chunk_ids=[]
            ),
        )
        for i in range(limit)
    ]
    for d in docs[8:]:
        d["jev"] = {"status": "not_evaluated", "reason": "candidate_limit"}
    accepted, status = jev.answer_results(docs, {"status": "evaluated"})
    assert accepted == []
    assert status["status"] == "no_answer_in_evaluated_candidates"
    assert status["evaluated_count"] == 8 and status["not_evaluated_count"] == limit - 8


def test_answer_states_do_not_conflate_outage_uncertainty_partial_and_correction():
    d = match()
    assert jev.answer_results([d], {"status": "unavailable"})[1]["status"] == "unavailable"
    uncertain = dict(
        d, jev=judgment(label="uncertain", policy_label="uncertain", coverage="unknown")
    )
    assert jev.answer_results([uncertain], {"status": "evaluated"})[0] == []
    assert jev.answer_results([uncertain], {"status": "evaluated"})[1]["status"] == "needs_context"
    partial = dict(d, jev=judgment(label="partial", policy_label="partial", coverage="partial"))
    assert jev.answer_results([partial], {"status": "evaluated"})[1]["status"] == "partial"
    correction = dict(
        d,
        jev=judgment(
            label="related",
            policy_label="related",
            coverage="none",
            supporting_chunk_ids=[],
            conflicting_chunk_ids=["doc1:v1:0"],
            premise_correction_status="accepted",
            decision_reason="premise_corrected",
        ),
    )
    assert (
        jev.answer_results([correction], {"status": "evaluated"})[1]["status"]
        == "corrected_premise"
    )
    correction["jev"]["evidence_disagreement"] = "accepted"
    assert jev.answer_results([correction], {"status": "evaluated"})[0] == []


def test_wrong_checkpoint_cannot_publish_support_even_in_current_document():
    from tests.ai.test_jev_proof import sdk

    with sdk({"coverage": "missing", "proof_0_0": "unused", "status_0_0": "scoped"}) as client:
        result = jev.judge_matches(
            "What is the final score?",
            [match(text="Intermediate checkpoint scored 172/231.")],
            client=client,
        )
    assert not result["matches"][0]["jev"]["supporting_chunk_ids"]
    assert jev.answer_results(result["matches"], result)[0] == []


def test_complete_coverage_does_not_override_missing_support():
    from tests.ai.test_jev_proof import sdk
    with sdk({"coverage": "complete", "proof_0_0": "unused"}) as client:
        result = jev.judge_matches("Question", [match()], client=client)
    assert not jev.answer_results(result["matches"], result)[0]
    assert not result["matches"][0]["jev"]["supporting_chunk_ids"]


def test_joint_document_request_preserves_order_and_request_metrics(monkeypatch):
    from tests.ai.test_jev_proof import sdk

    identities = []

    def call(state, questions, client=None):
        identities.extend(d["document_id"] for d in state["documents"])
        add("provider_calls", 1)
        add("provider_input_tokens", 68)
        with sdk({"coverage": "missing"}) as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", call)
    metrics = {}
    token = CURRENT.set(metrics)
    try:
        result = jev.judge_matches("Question", [match(str(i)) for i in range(4)])
    finally:
        CURRENT.reset(token)
    assert result["status"] == "evaluated"
    assert set(identities) == {"0", "1", "2", "3"}
    assert metrics["provider_calls"] == 1 and metrics["provider_input_tokens"] == 68
    assert [m["document_id"] for m in result["matches"]] == ["0", "1", "2", "3"]


def test_strict_answer_contract_through_actual_mcp_sdk(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setattr(search, "find_documents", lambda *a, **k: [match()])
    monkeypatch.setattr(
        server.application().search,
        "refresh",
        lambda rows, *a, **k: (deepcopy(rows), {"index": "x", "organization": "x"}),
    )
    monkeypatch.setattr(
        jev,
        "judge_matches",
        lambda q, rows, **k: dict(
            status="evaluated",
            matches=[
                dict(
                    rows[0],
                    jev=judgment(
                        label="related",
                        policy_label="related",
                        coverage="none",
                        supporting_chunk_ids=[],
                    ),
                )
            ],
        ),
    )

    async def exercise():
        async with Client(server.mcp) as client:
            for mode, evaluate in [("answer", False), ("keyword", True)]:
                for detail in ["compact", "full"]:
                    r = await client.call_tool(
                        "search",
                        dict(
                            query="Missing annual revenue",
                            mode=mode,
                            evaluate=evaluate,
                            detail=detail,
                        ),
                    )
                    assert not r.is_error
                    assert r.structured_content["matches"] == []
                    assert (
                        r.structured_content["answer"]["status"]
                        == "no_answer_in_evaluated_candidates"
                    )
            r = await client.call_tool("search", dict(query="Related documents", mode="keyword"))
            assert len(r.structured_content["matches"]) == 1

    asyncio.run(exercise())


def test_hybrid_fusion_keeps_identifiers_and_supports_cross_script_questions():
    from lancedb.rerankers import RRFReranker, LinearCombinationReranker

    assert isinstance(search.hybrid_reranker("SYMBIKNOW_MAX_CHUNK_BYTES"), RRFReranker)
    assert isinstance(search.hybrid_reranker("¿Se conservan los archivos?"), RRFReranker)
    assert isinstance(
        search.hybrid_reranker("האם Symbiknow שומר גרסאות?"), LinearCombinationReranker
    )
    assert isinstance(search.hybrid_reranker("Symbiknow 的版本历史"), LinearCombinationReranker)


def test_lowercase_project_headings_are_candidates_not_incidental_client_names():
    rows = [
        {
            "text": "nimbus plan\nnimbus serves typed decisions to Atlas clients.",
            "basis": "text",
            "provenance": {"headings": ["nimbus plan"]},
        }
    ]
    candidates = organization.project_candidates(
        rows, folders=["1 / CLI", "Document / Storage"], projects=[project("Atlas")]
    )
    assert "nimbus" in candidates and "Atlas" in candidates
    assert "1" not in candidates and "Document" not in candidates


def test_generated_topic_folders_are_not_project_identities():
    rows = [
        {
            "text": "nimbus plan\nnimbus calls Atlas. Adapters choose a runtime.",
            "basis": "text",
            "provenance": {"headings": ["nimbus plan", "Adapters"]},
        }
    ]
    assert organization.project_scope(rows) == "nimbus"
    candidates = organization.project_candidates(
        rows, folders=["Adapters / Runtime", "1 / Steps"], projects=[project("Atlas")]
    )
    assert set(candidates) == {"nimbus", "Atlas"}
