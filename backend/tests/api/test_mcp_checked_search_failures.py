"""Checked MCP jobs preserve failures, fallback evidence and current-version guards.

Real MCP transport, durable jobs, originals and LanceDB; fixture vectors and SDK
responses keep these contract checks independent of hosted model availability.
"""

import json

import httpx2
from mcp import Client
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from symbiknow.ai import jev, numeric, proof
from symbiknow.api import mcp as server
from symbiknow.cli.client import call
from symbiknow.library import storage
from symbiknow.search import index
from tests.ai.test_jev_proof import sdk
from tests.search.test_search import FixtureEmbedder


QUERY = "Who is the cat keeper?"
SCOPE = {"folder": "Fixture", "group": "keepers", "limit": 3}
ROUTES = {
    "ask": ("ask", {}, "semantic"),
    "answer": ("search", {"mode": "answer"}, "hybrid"),
    "evaluate": ("search", {"mode": "keyword", "evaluate": True}, "keyword"),
}


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("SYMBIKNOW_WARMUP", "0")
    monkeypatch.setattr(index, "get_embedder", FixtureEmbedder)
    monkeypatch.setattr(proof, "_CACHE", proof.ByteLRU())
    monkeypatch.setattr(numeric, "_CACHE", numeric.ByteLRU())
    text = "The cat keeper is Noa. Cat backups are retained for 9 days."
    metadata = storage.save_file(tmp_path, text.encode(), "keeper.txt")
    ref = f"{metadata['document_id']}:v1:t0"
    index.put_chunks(tmp_path, metadata, [dict(
        chunk_id=ref, text=text, basis="text", vector=[1.0, 0.0, 0.1],
        provenance_json="{}",
    )], FixtureEmbedder.model_id)
    index.set_document_status(tmp_path, metadata, status="indexed", indexed_version="v1", chunk_count=1)
    index.save_organization(tmp_path, metadata["document_id"], "v1", dict(
        status="evaluated", folder=SCOPE["folder"], groups=[SCOPE["group"]],
    ))
    return tmp_path, metadata, ref


async def checked_job(client, route, query=QUERY):
    tool, extra, _ = ROUTES[route]
    submitted = await client.call_tool(tool, dict(query=query, **SCOPE, **extra))
    assert not submitted.is_error
    receipt = submitted.structured_content
    assert receipt["job_id"] and receipt["status"] in {"queued", "running", "completed"}
    # Poll through the public tool; the server's isolated worker owns execution.
    import asyncio

    for _ in range(100):
        job = await call(client, "get_job", {"job_id": receipt["job_id"], "detail": "full"})
        if job["status"] in {"completed", "failed"}:
            break
        await asyncio.sleep(.02)
    assert job["status"] == "completed", job
    assert job["error"] is None
    return receipt["job_id"], job["result"]


def billing_provider(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx2.Response(402, json={"detail": {
            "error_type": "billing_error", "message": "private-provider-body-token",
        }})

    def provider(state, questions, client=None):
        with TypeSafeClient(api_key="fixture", transport=httpx2.MockTransport(respond),
                            retry=RetryPolicy(max_retries=0)) as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    return requests


@pytest.mark.parametrize("route", ROUTES)
async def test_billing_failure_has_actionable_receipt_and_unchecked_fallback(library, monkeypatch, route):
    async with Client(server.mcp) as client:
        _, metadata, ref = library
        requests = billing_provider(monkeypatch)
        _, result = await checked_job(client, route)
        assert len(requests) == 1
        assert result["status"] == result["evaluation"]["status"] == result["answer"]["status"] == "unavailable"
        failure = result["evaluation"]["failure"]
        assert failure["code"] == "billing_required" and failure["retryable"] is False
        assert failure["http_status"] == 402 and failure["message"] and failure["recovery"]
        assert result["answer"]["failure"] == failure
        assert result["matches"] == [] and not result["answer"].get("values")
        assert result["answer"]["candidate_count"] == result["answer"]["not_evaluated_count"] == 1
        assert "private-provider-body-token" not in json.dumps(result)
        fallback = result["retrieval_fallback"]
        assert fallback == {"tool": "search", "arguments": dict(
            query=QUERY, mode=ROUTES[route][2], evaluate=False, **SCOPE,
        )}
        retrieved = await call(client, fallback["tool"], fallback["arguments"])
        assert len(requests) == 1  # Reading unchecked evidence never retries billing.
        assert retrieved["status"] == "ok" and retrieved["evaluation"]["status"] == "not_requested"
        assert [(m["document_id"], m["version"]) for m in retrieved["matches"]] == [(metadata["document_id"], "v1")]
        assert retrieved["matches"][0]["evidence"][0]["evidence_id"] == ref
        assert "keeper is Noa" in retrieved["matches"][0]["evidence"][0]["text"]


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("coverage,status", [
    ("complete", "answered"), ("partial", "partial"), ("missing", "no_answer_in_evaluated_candidates"),
])
async def test_checked_routes_keep_success_partial_and_absence_distinct(library, monkeypatch, route, coverage, status):
    async with Client(server.mcp) as client:
        _, _, ref = library

        def provider(state, questions, client=None):
            choices = {"coverage": coverage}
            if coverage == "missing":
                choices["proof_0_0"] = "unused"
            with sdk(choices) as client:
                return client.system_one(state=state, questions=questions)

        monkeypatch.setattr(jev, "_call", provider)
        _, result = await checked_job(client, route)
        assert result["status"] == "ok" and result["evaluation"]["status"] == "evaluated"
        assert result["answer"]["status"] == status
        assert "retrieval_fallback" not in result and "failure" not in result["answer"]
        if coverage == "missing":
            assert result["matches"] == []
        else:
            assert result["matches"][0]["jev"]["supporting_chunk_ids"] == [ref]


@pytest.mark.parametrize("mutation", ["update", "delete"])
async def test_fallback_retrieval_rejects_stale_or_deleted_originals(library, monkeypatch, mutation):
    async with Client(server.mcp) as client:
        root, metadata, _ = library
        requests = billing_provider(monkeypatch)
        _, result = await checked_job(client, "ask")
        fallback = result["retrieval_fallback"]
        first = await call(client, fallback["tool"], fallback["arguments"])
        assert first["matches"]
        if mutation == "update":
            # Simulate the durable-original/index publication window: old v1 evidence
            # remains in LanceDB but must never escape once the current head is v2.
            storage.save_file(root, b"The dog keeper is Dina.", "keeper.txt",
                              document_id=metadata["document_id"], expected_version="v1")
        else:
            storage.delete_document(root, metadata["document_id"], "v1")
        retrieved = await call(client, fallback["tool"], fallback["arguments"])
        assert retrieved["matches"] == []
        assert len(requests) == 1


@pytest.mark.parametrize("mutation", ["update", "delete"])
async def test_completed_checked_job_drops_stale_or_deleted_answer(library, monkeypatch, mutation):
    async with Client(server.mcp) as client:
        root, metadata, _ = library

        def provider(state, questions, client=None):
            with sdk() as client:
                return client.system_one(state=state, questions=questions)

        monkeypatch.setattr(jev, "_call", provider)
        job_id, result = await checked_job(client, "answer")
        assert result["answer"]["status"] == "answered" and result["matches"]
        if mutation == "update":
            storage.save_file(root, b"The dog keeper is Dina.", "keeper.txt",
                              document_id=metadata["document_id"], expected_version="v1")
        else:
            storage.delete_document(root, metadata["document_id"], "v1")
        current = await call(client, "get_job", {"job_id": job_id, "detail": "full"})
        if mutation == "delete":
            assert current["status"] == "failed"
            assert current["result"] is None
            assert current["error"] == "A source document was deleted"
        else:
            assert current["status"] == "completed"
            assert current["result"]["matches"] == []
            assert current["result"]["answer"]["status"] != "answered"
            assert not current["result"]["answer"].get("values")
