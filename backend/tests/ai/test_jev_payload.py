"""OCR provenance must not exhaust Jev's text context or hide budget failures."""

import copy
import json

import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from symbiknow.ai import jev
from symbiknow.ai import numeric as jev_numeric
from symbiknow.ai import proof as jev_proof
from tests.ai.test_jev_proof import document, sdk


def test_ocr_boxes_are_compacted_in_both_checks_but_original_citations_survive():
    doc = document(texts=("This is a proposal.", "The keeper would be Noa."))
    provenance = {
        "pages": [
            {"page_no": n, "bbox": {"l": i / 3, "t": i / 7}, "charspan": [i, i + 1]}
            for n in (1, 2) for i in range(300)
        ],
        "headings": ["Proposed policy — not approved"],
    }
    for row in doc["evidence"]:
        row["basis"] = "ocr"
        row["provenance"] = copy.deepcopy(provenance)
    original = copy.deepcopy(doc)
    requests = []
    with sdk(confidence=0.7, requests=requests) as client:
        result = jev.judge_matches("Who is the keeper?", [doc], client=client)
    assert result["status"] == "evaluated" and len(requests) == 2
    for request in requests:
        for index, passage in enumerate(request["state"]["documents"][0]["evidence"]):
            assert passage["text"] == original["evidence"][index]["text"]
            assert passage["chunk_id"] == original["evidence"][index]["evidence_id"]
            assert passage["basis"] == "ocr"
            assert passage["location"] == {
                "pages": [{"page_no": 1}, {"page_no": 2}],
                "headings": provenance["headings"],
            }
        assert "bbox" not in json.dumps(request)
    assert doc == original
    assert result["matches"][0]["evidence"] == original["evidence"]


@pytest.mark.parametrize("location", [None, "page 2", {"page": 2}, {"pages": [1, 2]}])
def test_other_source_locations_are_preserved(location):
    assert jev._evidence_location(location) == location


@pytest.mark.parametrize("numeric", [False, True])
@pytest.mark.parametrize("limited", [False, True])
def test_provider_limit_is_not_an_outage_or_a_negative_answer(numeric, limited, monkeypatch):
    calls = []
    # An unrelated bad request must remain unavailable; do not mislabel it.
    body = {"detail": {"error_type": "max_tokens_exceeded" if limited else "invalid_model",
                       "debug": "secret source"}}

    def respond(request):
        calls.append(request)
        return httpx2.Response(400, json=body)

    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    monkeypatch.setattr(jev_numeric, "_CACHE", jev_numeric.ByteLRU())
    with TypeSafeClient(api_key="fixture", transport=httpx2.MockTransport(respond),
                        retry=RetryPolicy(max_retries=0)) as client:
        result = jev.judge_matches(
            "How many hours does RC retain backups?" if numeric else "Who is the keeper?",
            [document(texts=("RC backup retention is 9 days. The keeper is Noa.",))],
            client=client,
        )
    matches, answer = jev.answer_results(result["matches"], result)
    assert len(calls) == 1 and not matches
    assert result["status"] == answer["status"] == ("not_evaluated" if limited else "unavailable")
    if limited:
        assert result["reason"] == answer["reason"] == "context_budget"
    assert "secret source" not in json.dumps(result)
    assert not jev_proof._CACHE and not jev_numeric._CACHE
