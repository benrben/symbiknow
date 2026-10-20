"""Replay preserved answer cases through the sole current joint-proof SDK contract.

The recorded source/query corpus is retained. Its historical passage primitives
are projected into explicit proof roles and coverage for adapter regression only;
these controlled responses are not a fresh hosted-model quality measurement.
"""

import json
from pathlib import Path

import pytest

from symbiknow.ai import jev
from symbiknow.ai import proof as jev_proof
from tests.ai.test_jev_proof import sdk

CASES = json.loads((Path(__file__).resolve().parents[1] / "fixtures/jev-answer-parts.json").read_text())["cases"]


def replay(case, *, requests=None):
    recorded = case["judgment"]
    original = case["match"]
    roles = {}
    probabilities = {}
    for ordinal, passage in enumerate(recorded["passage_probabilities"]):
        supported = all(passage.get(field, 0) >= .8 for field in ["entity", "support", "applicability"])
        roles[f"proof_0_{ordinal}"] = "answer" if supported else "unused"
        probabilities[f"cite_0_{ordinal}"] = .99 if supported else .01
    coverage = ("partial" if recorded["model_label"] == "partial"
                else "complete" if recorded["complete_probability"] >= .8 else "missing")
    if "answer" not in roles.values():
        coverage = "missing"
    with sdk(dict(roles, coverage=coverage), probabilities=probabilities,
             confidence=recorded["model_confidence"], requests=requests) as client:
        result = jev_proof.judge(case["query"], [original], client=client)
    assert result["status"] == "evaluated"
    return result, jev.answer_results(result["matches"], result)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["case"])
def test_recorded_answer_sources_sdk_and_current_proof(case):
    result, (matches, answer) = replay(case)
    judgment = result["matches"][0]["jev"]
    if case["expected"] == "none":
        assert not matches and answer["answer_count"] == 0
        assert not judgment["supporting_chunk_ids"]
    else:
        assert matches and judgment["coverage"] == case["expected"]
        supplied = {row["evidence_id"] for row in case["match"]["evidence"]}
        assert set(judgment["supporting_chunk_ids"]) <= supplied
        assert judgment["supporting_chunk_ids"]
    assert not judgment["conflicting_chunk_ids"]


def test_answerability_preserves_negative_user_question_and_original_evidence():
    case = next(case for case in CASES if case["case"] == "C013")
    requests = []
    _, (matches, answer) = replay(case, requests=requests)
    assert matches and answer["complete_count"] == 1
    state = requests[0]["state"]
    assert state["user_question"] == case["query"]
    assert state["documents"][0]["evidence"][0]["text"] == case["match"]["evidence"][0]["text"]
    assert "Answerability is different from whether the answer is Yes" in requests[0]["questions"]["coverage"]["instructions"]


@pytest.mark.parametrize("confidence,accepted", [(.599, False), (.6, True), (.799, True), (.8, True)])
def test_uncertain_proof_verification_preserves_acceptance_boundary(confidence, accepted):
    with sdk({"coverage": "partial"}, confidence=confidence) as client:
        result = jev.judge_matches("Which refund fields are required?", [dict(CASES[0]["match"])], client=client)
    assert bool(jev.answer_results(result["matches"], result)[0]) is accepted


def test_explicit_partial_coverage_remains_partial_with_multiple_supporting_documents():
    from tests.ai.test_jev_proof import document
    docs = [document("one"), document("two")]
    with sdk({"coverage": "partial"}) as client:
        result = jev.judge_matches("Question with a missing value", docs, client=client)
    assert all(match["jev"]["coverage"] == "partial" for match in result["matches"])


def test_long_context_offsets_and_six_window_bound_remain_exact():
    text = "Background. " * 400 + "Windowneedle: retention is 17 days. " + "Appendix. " * 400
    match = dict(document_id="long", version="v1", filename="long.md",
                 evidence=[dict(evidence_id=f"long:v1:t{i}", text=text, basis="text") for i in range(8)])
    windows = jev._evidence(match, "Windowneedle retention")
    assert len(windows) == 6
    for window in windows:
        assert window["truncated"] and 0 < window["text_start"] < window["text_end"] < len(text)
        assert window["text"] == text[window["text_start"]:window["text_end"]]
        assert "retention is 17 days" in window["text"] and len(window["text"]) <= jev.MAX_TEXT
