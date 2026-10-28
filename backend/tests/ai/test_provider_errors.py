"""Provider diagnostics remain actionable without publishing request secrets."""

import json

import httpx2
import pytest
from typesafe_sdk import (
    RetryPolicy,
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
    TypeSafeAPIResponseValidationError,
    TypeSafeAPITimeoutError,
    TypeSafeClient,
)

from symbiknow.ai import jev
from symbiknow.ai.provider_errors import provider_failure
from tests.ai.test_jev import match
from tests.ai.test_jev_numeric import documents


SECRET = "private-source-and-provider-secret"
REQUEST_ID = "req_01a17a9433957f299e9ca6abafc31542"


def api_error(status, *, detail=None, request_id=REQUEST_ID):
    return TypeSafeAPIError(
        status,
        {"detail": detail or {"error_type": "billing_error", "message": SECRET}},
        httpx2.Headers({"x-typesafe-request-id": request_id, "authorization": SECRET}),
        message=SECRET,
        endpoint="https://example.invalid/" + SECRET,
    )


def test_billing_failure_explains_recovery_and_omits_remote_text():
    result = provider_failure(api_error(402))
    assert result["status"] == "unavailable"
    failure = result["failure"]
    assert failure["code"] == "billing_required"
    assert failure["http_status"] == 402 and failure["request_id"] == REQUEST_ID
    assert failure["retryable"] is False
    assert "billing" in failure["message"] and "credits" in failure["recovery"]
    assert result["error"] == failure["message"]
    assert SECRET not in json.dumps(result) and "example.invalid" not in json.dumps(result)


@pytest.mark.parametrize("request_id", [SECRET, "req_" + SECRET, "req_" + "a" * 300,
                                       REQUEST_ID + "\n" + SECRET])
def test_unrecognized_request_identifiers_are_not_published(request_id):
    # Construct the exception before assigning the test header: HTTP transports
    # reject newlines, but a custom provider/transport must still fail safely.
    error = api_error(402)
    error.headers = {"x-typesafe-request-id": request_id}
    result = provider_failure(error)
    assert "request_id" not in result["failure"]
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize("status,code,retryable", [
    (401, "authentication_failed", False),
    (403, "permission_denied", False),
    (404, "endpoint_unavailable", False),
    (408, "provider_timeout", True),
    (413, "payload_too_large", False),
    (415, "unsupported_encoding", False),
    (422, "invalid_request", False),
    (429, "rate_limited", True),
    (500, "provider_overloaded", True),
    (529, "provider_overloaded", True),
    (418, "provider_error", False),
])
def test_http_failures_distinguish_configuration_from_transient_errors(status, code, retryable):
    result = provider_failure(api_error(status))["failure"]
    assert (result["code"], result["retryable"]) == (code, retryable)
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize("error,code,retryable", [
    (TypeSafeAPITimeoutError(15), "provider_timeout", True),
    (TimeoutError(SECRET), "provider_timeout", True),
    (TypeSafeAPIConnectionError(SECRET), "provider_connection", True),
    (RuntimeError(SECRET), "provider_error", False),
    (TypeSafeAPIResponseValidationError(200, {"private": SECRET}, httpx2.Headers(), SECRET),
     "invalid_response", False),
])
def test_sdk_and_local_exceptions_do_not_echo_their_messages(error, code, retryable):
    result = provider_failure(error)["failure"]
    assert (result["code"], result["retryable"]) == (code, retryable)
    assert SECRET not in json.dumps(result)


def test_context_error_uses_only_the_known_machine_code():
    failure = provider_failure(api_error(400, detail={"error_type": "max_tokens_exceeded",
                                                     "message": SECRET}))["failure"]
    assert failure["code"] == "context_budget" and not failure["retryable"]
    unknown = provider_failure(api_error(400, detail={"error_type": SECRET}))["failure"]
    assert unknown["code"] == "invalid_request" and SECRET not in json.dumps(unknown)


def test_missing_key_is_actionable_without_provider_call(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    result = jev.judge_matches("What is the capital?", [match()])
    assert result["failure"]["code"] == "configuration_missing"
    assert "TYPESAFE_API_KEY" in result["failure"]["recovery"]
    assert result["matches"][0]["jev"]["reason"] == "provider_unavailable"


@pytest.mark.parametrize("operation", ["proof", "numeric", "organization"])
def test_real_sdk_billing_failure_preserves_retrieved_evidence_without_verifying_it(operation):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx2.Response(
            402,
            json={"detail": {"error_type": "billing_error", "message": SECRET}},
            headers={"x-typesafe-request-id": REQUEST_ID},
        )

    with TypeSafeClient(api_key="fixture", transport=httpx2.MockTransport(respond),
                        retry=RetryPolicy(max_retries=0)) as client:
        if operation == "numeric":
            result = jev.judge_matches("How many hours does RC retain backups?", documents(),
                                       client=client)
        elif operation == "organization":
            doc = match()
            result = jev.organize_document(doc, doc["evidence"], [], client=client)
        else:
            result = jev.judge_matches("What is France's capital?", [match()], client=client)
    assert len(calls) == 1
    assert result["status"] == "unavailable"
    assert result["failure"]["code"] == "billing_required"
    assert result["failure"]["request_id"] == REQUEST_ID
    assert SECRET not in json.dumps(result)
    if operation != "organization":
        assert result["matches"]
        assert all(m["jev"] == {"status": "unavailable", "reason": "provider_unavailable"}
                   for m in result["matches"])
        accepted, answer = jev.answer_results(result["matches"], result)
        assert accepted == [] and answer["status"] == "unavailable"
        assert answer["evaluated_count"] == 0
