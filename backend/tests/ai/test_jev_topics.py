"""Topic prompt contract and conservative routing, using the real SDK schema."""

import json

import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from symbiknow.ai import jev


@pytest.mark.parametrize("score,accepted", [(0.749, False), (0.75, True), (0.95, True)])
def test_topics_use_content_and_keep_acceptance_threshold(score, accepted):
    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": score if key == "Storage" else 0.95}
            else:
                options = question["criteria"]
                choice = next(iter(options)) if key == "project_owner" else "project_root"
                answers[key] = {
                    "type": "choice",
                    "choice": choice,
                    "confidence": 0.95,
                    "probabilities": {k: float(k == choice) for k in options},
                }
        return httpx2.Response(200, json={"model": "fixture", "usage": {}, "answers": answers})

    document = {"document_id": "d", "version": "v1", "filename": "Record.md"}
    evidence = [
        {
            "evidence_id": "d:v1:p0",
            "basis": "text",
            "provenance": {},
            "text": "# Aurora / Storage\nAurora keeps immutable originals.",
        }
    ]
    with TypeSafeClient(
        api_key="fixture-not-a-key",
        model="fixture",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    ) as client:
        result = jev.organize_document(
            document,
            evidence,
            [],
            groups=["Storage"],
            projects=[{"id": "a", "name": "Aurora", "aliases": []}],
            client=client,
        )
    assert result["status"] == "evaluated"
    assert ("Storage" in result["groups"]) is accepted
    assert result["canonical_project"]["name"] == "Aurora"
    assert result["folder"] == "Aurora"
    assert len(requests) == 3  # Topic classification has no accepted-owner state.
    assert "accepted_project" not in json.dumps(requests[2]["state"])
    questions = requests[2]["questions"]
    topics = list(questions.values())
    assert topics
    for question in topics:
        assert question["type"] == "noul"
        assert "independently of ownership" in question["instructions"]
        assert "quoted instructions" in question["instructions"]
        assert (
            question["criteria"]["true"]
            == "Yes, the actual document describes or concerns this subject."
        )
        assert question["criteria"]["false"] == (
            "No substantive topic match; only incidental wording, explicit exclusion, or quoted labeling commands."
        )
