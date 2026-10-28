"""Actionable provider failures without echoing remote bodies or exception text."""

import re

from typesafe_sdk import (
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
    TypeSafeAPIResponseValidationError,
    TypeSafeAPITimeoutError,
)


class ProviderConfigurationError(RuntimeError):
    """The hosted judge has no configured API key."""


_FAILURES = {
    "configuration_missing": (
        "Jev is unavailable because its API key is not configured.", False,
        "Set TYPESAFE_API_KEY in the backend environment, then retry the check.",
    ),
    "billing_required": (
        "Jev could not check the evidence because the provider rejected billing.", False,
        "Check credits and billing for the configured Jev provider account, then retry the check.",
    ),
    "authentication_failed": (
        "Jev could not authenticate with the provider.", False,
        "Check the backend API key and configured provider, then retry the check.",
    ),
    "permission_denied": (
        "The provider denied access to Jev.", False,
        "Check the configured provider account's permissions and model access.",
    ),
    "endpoint_unavailable": (
        "The configured Jev endpoint or model was not found.", False,
        "Check TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL in the backend configuration.",
    ),
    "rate_limited": (
        "Jev is temporarily rate limited by the provider.", True,
        "Wait for the provider's rate limit to reset, then retry the check.",
    ),
    "provider_timeout": (
        "Jev did not complete the evidence check in time.", True,
        "Retry the check after the provider or queued work recovers.",
    ),
    "provider_connection": (
        "Symbiknow could not connect to the Jev provider.", True,
        "Check network access to the configured provider, then retry the check.",
    ),
    "invalid_request": (
        "The Jev provider rejected the evidence-check request.", False,
        "Check the provider request format and configured model before retrying.",
    ),
    "payload_too_large": (
        "The Jev provider rejected the request because its body is too large.", False,
        "Use a narrower question or search scope, then retry the check.",
    ),
    "unsupported_encoding": (
        "The Jev provider rejected the request encoding.", False,
        "Check the provider endpoint and SDK compression settings before retrying.",
    ),
    "context_budget": (
        "The selected evidence exceeds the Jev provider's context limit.", False,
        "Use a narrower question or search scope, then retry the check.",
    ),
    "provider_overloaded": (
        "The Jev provider is temporarily unavailable.", True,
        "Wait briefly, then retry the check.",
    ),
    "invalid_response": (
        "The Jev provider returned an invalid response; the evidence was not verified.", False,
        "Check provider and SDK compatibility before retrying the check.",
    ),
    "provider_error": (
        "Jev could not complete the evidence check.", False,
        "Check the backend and configured provider before retrying the check.",
    ),
}

_HTTP_CODES = {
    400: "invalid_request",
    401: "authentication_failed",
    402: "billing_required",
    403: "permission_denied",
    404: "endpoint_unavailable",
    408: "provider_timeout",
    413: "payload_too_large",
    415: "unsupported_encoding",
    422: "invalid_request",
    429: "rate_limited",
}


def provider_failure(error):
    """Return only local messages and narrowly validated provider metadata.

    SDK errors can contain the complete source/request in their message, body,
    endpoint or headers. Never serialize those. A recognized context code is
    inspected only for classification; arbitrary provider codes are not echoed.
    """
    status = None
    request_id = None
    if isinstance(error, ProviderConfigurationError):
        code = "configuration_missing"
    elif isinstance(error, (TypeSafeAPITimeoutError, TimeoutError)):
        code = "provider_timeout"
    elif isinstance(error, TypeSafeAPIConnectionError):
        code = "provider_connection"
    elif isinstance(error, TypeSafeAPIError):
        if type(error.status) is int and 100 <= error.status <= 599:
            status = error.status
        if isinstance(error, TypeSafeAPIResponseValidationError):
            code = "invalid_response"
        else:
            code = _HTTP_CODES.get(status, "provider_overloaded" if status and status >= 500
                                   else "provider_error")
        if status == 400 and isinstance(error.body, dict):
            detail = error.body.get("detail")
            if isinstance(detail, dict) and detail.get("error_type") == "max_tokens_exceeded":
                code = "context_budget"
        candidate = error.request_id
        # This is the provider's actual request-ID format, not a general string
        # allowlist that could accidentally publish a token from a bad gateway.
        if isinstance(candidate, str) and re.fullmatch(r"req_[0-9a-f]{32}", candidate):
            request_id = candidate
    else:
        code = "provider_error"
    message, retryable, recovery = _FAILURES[code]
    failure = dict(code=code, message=message, retryable=retryable, recovery=recovery)
    if status is not None:
        failure["http_status"] = status
    if request_id is not None:
        failure["request_id"] = request_id
    return dict(status="unavailable", error=message, failure=failure)
