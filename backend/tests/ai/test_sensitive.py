"""Likely credentials stay local: withheld documents are never sent to hosted Jev."""
import json

import httpx2
import pytest
from typesafe_sdk import Noul, RetryPolicy, TypeSafeClient

from symbiknow.ai import jev
from symbiknow.ai.sensitive import contains_likely_secret
from tests.ai.test_jev import match
from tests.ai.test_jev_proof import sdk

# Assembled at runtime so the repository never stores key-shaped literals.
KEY = "sk-ant-" + "api03-" + "Zq7Rk2Lm9Xw4Tn8Vb3Hc"
TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2"


@pytest.mark.parametrize("text", [
    f"ANTHROPIC_API_KEY={KEY}",
    f"export GITHUB_TOKEN={TOKEN}",
    'password: "SuperSecret123!@#"',
    "We don't share keys.\npassword: Zx9!qR7mK2vL8pWq4",  # A prose apostrophe cannot hide it.
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA",
    "hooks.slack.com/services/" + "T0A1B2C3D/B4E5F6G7H/" + "q8R9s0T1u2V3",
])
def test_likely_credentials_are_detected(text):
    assert contains_likely_secret(text)


@pytest.mark.parametrize("text", [
    "password = password123",
    "api_key: your-api-key-here",
    "api_key: sk-live-" + "X" * 20,
    "client_secret: 123e4567-e89b-12d3-a456-426614174000",
    "api_key = process.env.API_KEY",
    "The disk-encryption-performance-report is attached.",
    "npm_package_dependencies_typescript_version",
    # Library documents are prose: credential policy is not a credential.
    "Password: must be at least 12 characters with one symbol.",
    "Secret: The Secret Garden is a novel by Frances Hodgson Burnett.",
    "Rotate every API key and access token quarterly.",
])
def test_placeholders_identifiers_and_policy_prose_are_not_credentials(text):
    assert not contains_likely_secret(text)


def test_withheld_document_is_never_sent_and_is_not_a_negative_answer():
    requests = []
    secret = match("keys", text=f"ANTHROPIC_API_KEY={KEY}")
    with sdk(requests=requests) as client:
        result = jev.judge_matches("What is the capital?", [secret, match()], client=client)
    assert requests and not any(KEY in json.dumps(request) for request in requests)
    assert [m["document_id"] for m in result["matches"]] == ["keys", "doc1"]
    judged = {m["document_id"]: m["jev"] for m in result["matches"]}
    assert judged["keys"] == {"status": "not_evaluated", "reason": "sensitive_content"}
    assert judged["doc1"]["status"] == "evaluated"
    _, answer = jev.answer_results(result["matches"], result)
    assert answer["withheld_count"] == 1 and answer["not_evaluated_count"] == 1


@pytest.mark.parametrize("query", ["Who is the keeper?", "How many days is the retention?"])
def test_only_withheld_candidates_explain_why_nothing_was_checked(query):
    requests = []
    with sdk(requests=requests) as client:
        result = jev.judge_matches(query, [match("keys", text=f"api_key: {KEY} 9 days")], client=client)
    assert not requests
    accepted, answer = jev.answer_results(result["matches"], result)
    assert not accepted
    assert answer["status"] == "not_evaluated" and answer["reason"] == "sensitive_content"


def test_final_guard_refuses_any_unfiltered_request_before_network():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx2.Response(500)

    with TypeSafeClient(api_key="fixture", transport=httpx2.MockTransport(respond),
                        retry=RetryPolicy(max_retries=0)) as client:
        with pytest.raises(jev.SensitiveContentError):
            jev._call({"text": f"token: {TOKEN}"}, {"q": Noul(instructions="Check it")}, client)
        with pytest.raises(jev.SensitiveContentError):
            jev._call({"text": "source"}, {"q": Noul(instructions=f"Compare with {KEY}")}, client)
    assert not calls


def test_organization_withholds_document_and_never_sends_withheld_neighbors(monkeypatch):
    sent = []

    def capture(state, questions, client=None):
        sent.append(json.dumps([state, [q.model_dump(mode="json") for q in questions.values()]]))
        with sdk() as provider:
            return provider.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", capture)
    secret = match("keys", text=f"api_key: {KEY}")
    result = jev.organize_document(secret, secret["evidence"], [], folders=["Atlas"])
    assert result["status"] == "not_evaluated" and result["reason"] == "sensitive_content"
    assert "credentials" in result["organization_reason"] and not sent
    source = match()
    result = jev.organize_document(source, source["evidence"], [secret, match("doc2")], links_only=True)
    assert result["status"] == "evaluated" and sent
    assert not any(KEY in request for request in sent)
