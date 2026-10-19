"""Replay real generated-case responses through the SDK; preserve strict guards."""

import copy
import json
from pathlib import Path

import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from app import jev

CASES = json.loads((Path(__file__).parent / "fixtures/jev-answer-parts.json").read_text())["cases"]


def replay(case, *, inspect_request=None):
    """Reconstruct typed SDK answers from recorded raw probabilities, not policy labels."""
    j = case["judgment"]

    def respond(request):
        body = json.loads(request.content)
        if inspect_request:
            inspect_request(body)
        answers = {}
        for key, q in body["questions"].items():
            if q["type"] == "choice":
                answers[key] = dict(
                    type="choice",
                    choice=j["model_label"],
                    confidence=j["model_confidence"],
                    probabilities=j["probabilities"],
                )
                continue
            p = (
                j["passage_probabilities"][int(key.rsplit("_", 1)[1])]
                if key.count("_") == 2
                else j["passage_probabilities"][0]
            )
            value = (
                j["complete_probability"]
                if key.startswith("complete_")
                else p["scope_mismatch"]
                if key.startswith("scope_mismatch_")
                else p["historical_request"]
                if key.startswith("historical_")
                else p[key.split("_", 1)[0]]
            )
            answers[key] = dict(type="noul", noul=value)
        return httpx2.Response(200, json=dict(model=j["model"], usage={}, answers=answers))

    with TypeSafeClient(
        api_key="fixture-not-a-credential",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    ) as sdk:
        # These recordings use the general evaluator's judge/support primitives,
        # not the numeric verifier's verified/unsupported/contradicted choices.
        # Keep replaying that contract; numeric dispatch has its own SDK tests.
        result = jev._judge_matches(case["query"], [copy.deepcopy(case["match"])], client=sdk)
    assert result["status"] == "evaluated"
    return result, jev.answer_results(result["matches"], result)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["case"])
def test_recorded_answer_parts_sdk_and_policy(case):
    result, (matches, answer) = replay(case)
    j = result["matches"][0]["jev"]
    if case["expected"] == "none":
        assert not matches and answer["answer_count"] == 0
        assert not j["supporting_chunk_ids"]
    else:
        assert matches and j["coverage"] == case["expected"]
        supplied = {r["evidence_id"] for r in case["match"]["evidence"]}
        assert set(j["supporting_chunk_ids"]) <= supplied
        assert j["supporting_chunk_ids"]
    assert not j["conflicting_chunk_ids"]  # neutral requests are not premise assertions


def test_completeness_task_is_distinct_from_users_yes_no_question():
    case = next(c for c in CASES if c["case"] == "C013")
    seen = []

    def inspect(body):
        q = body["questions"]["complete_0"]["instructions"]
        # The binary task is answerability, while this user request has answer No.
        # Keeping separate fields prevents the user's negative truth value from
        # being substituted for whether the source supplies a complete answer.
        assert q["user_request"] == case["query"]
        assert q["question"] != q["user_request"]
        assert q["evidence"][0]["text"] == case["match"]["evidence"][0]["text"]
        seen.append(body)

    _, (matches, answer) = replay(case, inspect_request=inspect)
    assert len(seen) == 1 and matches and answer["complete_count"] == 1


@pytest.mark.parametrize("field", ["entity", "support", "applicability"])
def test_partial_answer_keeps_each_original_acceptance_boundary(field):
    case = next(c for c in CASES if c["case"] == "C071")
    j = case["judgment"]
    p = copy.deepcopy(j["passage_probabilities"][0])
    for value, accepted in [(0.799, False), (0.8, True)]:
        routed = jev.route_answer(
            j["model_label"], j["model_confidence"], [p | {field: value}], j["complete_probability"]
        )
        assert bool(routed["supporting_chunk_ids"]) is accepted
        assert routed["coverage"] == ("partial" if accepted else "unknown")


def test_high_level_direct_cannot_overrule_no_requested_value_support():
    case = next(c for c in CASES if c["case"] == "C070")
    p = case["judgment"]["passage_probabilities"][0]
    assert p["support"] < jev.SUPPORT_ACCEPT
    routed = jev.route_answer("direct", 1.0, [p], complete_probability=1.0)
    assert routed["coverage"] == "unknown" and not routed["supporting_chunk_ids"]


@pytest.mark.parametrize(
    "label, confidence, coverage",
    [
        ("partial", 0.99, "partial"),
        ("partial", 0.6, "partial"),
        ("partial", 0.599, "complete"),
        ("direct", 0.99, "complete"),
    ],
)
def test_completeness_cannot_override_confident_partial_choice(label, confidence, coverage):
    from test_jev import match, sdk_client

    d = match(text="Backups are retained for 23 days. The CEO phone number is not documented.")
    with sdk_client({"judge_0": label}, {"complete_0": 0.97}) as client:
        result = jev._judge_matches_legacy(
            "What are backup retention and the CEO phone number?", [d], client=client
        )
    j = result["matches"][0]["jev"]
    j["model_confidence"] = confidence
    routed = jev.route_answer(
        label, confidence, j["passage_probabilities"], j["complete_probability"]
    )
    assert routed["supporting_chunk_ids"] and routed["coverage"] == coverage


def test_cross_document_agreement_cannot_bypass_confident_partial_coverage():
    from test_jev import match, sdk_client

    docs = [match("one"), match("two")]
    with sdk_client(
        {"judge_0": "partial", "judge_1": "partial"}, {"complete_0": 0.97, "complete_1": 0.97}
    ) as client:
        result = jev._judge_matches_legacy("Question with a missing value", docs, client=client)
    assert result["cross_document_assessment"]["status"] == "evaluated"
    assert all(m["jev"]["coverage"] == "partial" for m in result["matches"])


def test_long_context_offsets_and_six_window_bound_remain_exact():
    text = "Background. " * 400 + "Windowneedle: retention is 17 days. " + "Appendix. " * 400
    match = dict(
        document_id="long",
        version="v1",
        filename="long.md",
        evidence=[dict(evidence_id=f"long:v1:t{i}", text=text, basis="text") for i in range(8)],
    )
    windows = jev._evidence(match, "Windowneedle retention")
    assert len(windows) == 6
    for w in windows:
        assert w["truncated"] and 0 < w["text_start"] < w["text_end"] < len(text)
        assert w["text"] == text[w["text_start"] : w["text_end"]]
        assert "retention is 17 days" in w["text"] and len(w["text"]) <= jev.MAX_TEXT
    assert "long:v1:t6" not in {w["chunk_id"] for w in windows}
