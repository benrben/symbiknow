"""Durable-job projection errors keep the full-result recovery actionable."""

import copy
from types import SimpleNamespace

import pytest

from symbiknow.api import mcp as server


def test_get_job_oversized_compact_metadata_explains_full_recovery(monkeypatch):
    stored = {"job_id": "fixture", "status": "completed", "error": None, "result": {
        "matches": [], "status": "unavailable", "evaluation": {"status": "unavailable"},
        "extra_metadata": "😀" * 10000, "metrics": {},
    }}
    context = SimpleNamespace(
        jobs=SimpleNamespace(get=lambda _: copy.deepcopy(stored)),
        work=SimpleNamespace(get=lambda *_: {"payload": {"args": {"query": "keeper"}}}),
    )
    monkeypatch.setattr(server, "application", lambda: context)
    with pytest.raises(server.SearchRequestError, match="Compact metadata exceeds budget; repeat with detail=full"):
        server.get_job("fixture")
    assert server.get_job("fixture", detail="full")["result"] == stored["result"]
