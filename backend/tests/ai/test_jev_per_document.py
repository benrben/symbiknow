"""Experimental per-document search judging: isolated yes/no questions per file."""

import json

import httpx2
from typesafe_sdk import TypeSafeClient, RetryPolicy

from symbiknow.ai import jev

from .test_jev_proof import document


def sdk(yes, requests, citation=0.99):
    """yes maps document_id to the question keys Jev answers yes for that file."""

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        answers = {}
        for key, q in body["questions"].items():
            if q["type"] == "choice":
                choice = next(iter(q["criteria"]))
                answers[key] = dict(type="choice", choice=choice, confidence=0.99,
                                    probabilities={v: float(v == choice) for v in q["criteria"]})
                continue
            identity = body["state"].get("document", {}).get("document_id")
            value = citation if key.startswith("cite_") else 0.99 if key in yes.get(identity, ()) else 0.05
            answers[key] = dict(type="noul", noul=value)
        return httpx2.Response(200, json=dict(model="jev-1.14.0", usage={}, answers=answers))

    return TypeSafeClient(api_key="fixture", model="jev-1.14.0",
                          transport=httpx2.MockTransport(respond), retry=RetryPolicy(max_retries=0))


def test_each_document_is_asked_alone_and_any_yes_returns_it(monkeypatch):
    monkeypatch.setenv("SYMBIKNOW_JEV_SEARCH_MODE", "per_document")
    requests = []
    docs = [document(), document("d1", ("Backups run nightly.",)),
            document("d2", ("Noa joined in May.",)), document("d3", ("The keeper role exists.",))]
    yes = {"d0": {"full_answer", "relevant"}, "d2": {"partial_answer"}, "d3": {"relevant"}}
    with sdk(yes, requests) as client:
        result = jev.judge_matches("Who is the keeper?", docs, client=client)
    assert [r["state"]["document"]["document_id"] for r in requests] == ["d0", "d1", "d2", "d3"]
    assert all("documents" not in r["state"] for r in requests)
    assert {"full_answer", "partial_answer", "corrects_premise", "relevant", "cite_0"} == set(requests[0]["questions"])
    labels = {m["document_id"]: m["jev"]["label"] for m in result["matches"]}
    assert labels == {"d0": "direct", "d1": "unrelated", "d2": "partial", "d3": "related"}
    assert result["proof_assessment"]["decision"]["returned"] == ["d0", "d2", "d3"]
    # Relevance alone returns a file but never cites it as an answer.
    assert result["matches"][3]["jev"]["supporting_chunk_ids"] == []
    related = jev.related_results(result["matches"], result)
    assert related == [dict(document_id="d3", version="v1", filename="Record.txt", relevance=0.99)]
    accepted, answer = jev.answer_results(result["matches"], result)
    assert answer["status"] == "answered"
    assert {m["document_id"] for m in accepted} == {"d0", "d2"}


def test_answer_without_a_cited_passage_is_only_related(monkeypatch):
    monkeypatch.setenv("SYMBIKNOW_JEV_SEARCH_MODE", "per_document")
    requests = []
    with sdk({"d0": {"full_answer"}}, requests, citation=0.2) as client:
        result = jev.judge_matches("Who is the keeper?", [document()], client=client)
    assert result["matches"][0]["jev"]["label"] == "related"
    accepted, answer = jev.answer_results(result["matches"], result)
    assert not accepted and answer["status"] == "no_answer_in_evaluated_candidates"


def test_joint_mode_remains_the_default(monkeypatch):
    monkeypatch.delenv("SYMBIKNOW_JEV_SEARCH_MODE", raising=False)
    requests = []
    with sdk({}, requests) as client:
        result = jev.judge_matches("Who is the keeper?", [document()], client=client)
    assert "documents" in requests[0]["state"] and "coverage" in requests[0]["questions"]
    # The joint proof has no per-file relevance, so it never reports related files.
    assert jev.related_results(result["matches"], result) == []
