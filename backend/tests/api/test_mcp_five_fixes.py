"""Five handoff regressions: real SDK parsing, transport, OCFL and event ordering."""

import asyncio
import copy
import json
import threading
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest
from mcp import Client

from symbiknow.ingestion import service as ingest
from symbiknow.ai import jev
from symbiknow.ai import proof as jev_proof
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.search.projection import COMPACT_BYTES, project_search
from tests.ai.test_jev import match
from tests.ai.test_jev_proof import sdk
from tests.search.test_search import FixtureEmbedder


def test_partial_sdk_response_preserves_support_without_claiming_complete_coverage():
    with sdk({"coverage": "partial"}) as client:
        result = jev.judge_matches("Does switching views or panning change search?", [match()], client=client)
    judgment = result["matches"][0]["jev"]
    assert judgment["label"] == "partial" and judgment["coverage"] == "partial"
    assert judgment["supporting_chunk_ids"] == ["doc1:v1:0"]


@pytest.mark.parametrize("confidence,accepted", [(.599, False), (.6, True), (.7999, True), (.8, True)])
def test_proof_verification_uses_its_named_acceptance_boundary(confidence, accepted):
    with sdk({"coverage": "complete"}, confidence=confidence) as client:
        result = jev.judge_matches("What changes search?", [match()], client=client)
    assert bool(jev.answer_results(result["matches"], result)[0]) is accepted


@pytest.mark.parametrize("kind", ["wrong_entity", "obsolete", "rejected"])
def test_wrong_entity_obsolete_or_rejected_cannot_supply_support_or_conflict(kind):
    with sdk({"coverage": "missing", "proof_0_0": "unused", "status_0_0": "scoped"}) as client:
        result = jev.judge_matches("What changes search?", [match(text=kind)], client=client)
    judgment = result["matches"][0]["jev"]
    assert not judgment["supporting_chunk_ids"] and not judgment["conflicting_chunk_ids"]
    assert judgment["coverage"] != "complete"


def test_missing_support_and_explicit_correction_are_separate():
    with sdk({"coverage": "complete", "proof_0_0": "unused"}) as client:
        result = jev.judge_matches("What changes search?", [match()], client=client)
    assert not jev.answer_results(result["matches"], result)[0]
    with sdk({"coverage": "correction"}) as client:
        result = jev.judge_matches("Why does switching views change search?", [match()], client=client)
    judgment = result["matches"][0]["jev"]
    assert judgment["conflicting_chunk_ids"] and judgment["decision_reason"] == "premise_corrected"


def test_cached_hit_finishes_before_unrelated_blocked_provider(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    entered, release, hit_done = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def provider(state, questions, client=None):
        query = state["user_question"]
        calls.append(query)
        if query == "B":
            entered.set()
            assert release.wait(5)
        with sdk() as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    jev.judge_matches("A", [match()], cache_namespace="isolation")
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(jev.judge_matches, "B", [match("other")], cache_namespace="isolation")
        assert entered.wait(2)

        def hit():
            result = jev.judge_matches("A", [match()], cache_namespace="isolation")
            hit_done.set()
            return result

        fast = pool.submit(hit)
        try:
            assert hit_done.wait(2), "Cached A must complete before releasing B"
            assert fast.result(timeout=2)["cached"] == 1
        finally:
            release.set()
        slow.result(timeout=5)
    assert calls == ["A", "B"]


def test_unrelated_misses_can_enter_provider_concurrently(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    entered = threading.Barrier(3)

    def provider(state, questions, client=None):
        entered.wait(timeout=5)
        with sdk() as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(jev.judge_matches, "A", [match()], cache_namespace="parallel")
        b = pool.submit(jev.judge_matches, "B", [match()], cache_namespace="parallel")
        entered.wait(timeout=5)
        a.result(timeout=5)
        b.result(timeout=5)


def test_expanded_context_failure_cannot_reuse_subset_but_preserves_subset_cache(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    failing = False
    calls = []

    def provider(state, questions, client=None):
        calls.append([m["document_id"] for m in state["documents"]])
        if failing:
            raise RuntimeError("fixture failure")
        with sdk() as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    jev.judge_matches("Q", [match()], cache_namespace="mixed")
    failing = True
    result = jev.judge_matches("Q", [match(), match("miss")], cache_namespace="mixed")
    assert all(m["jev"]["status"] == "unavailable" for m in result["matches"])
    assert jev.judge_matches("Q", [match()], cache_namespace="mixed")["cached"] == 1
    failing = False
    assert jev.judge_matches("Q", [match(), match("miss")], cache_namespace="mixed")["cached"] == 0
    assert calls == [["doc1"], ["doc1", "miss"], ["doc1", "miss"]]


@pytest.mark.parametrize(
    "change",
    ["namespace", "query", "version", "text", "model", "prompt", "policy", "proof_version"],
)
def test_cache_fingerprint_invalidates_semantic_changes(monkeypatch, change):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())

    def provider(state, questions, client=None):
        with sdk() as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    jev.judge_matches("Q", [match()], cache_namespace="cache")
    doc, query, namespace = match(), "Q", "cache"
    if change == "namespace":
        namespace = "other"
    elif change == "query":
        query = "Other"
    elif change == "version":
        doc["version"] = "v2"
        doc["evidence"][0]["evidence_id"] = "doc1:v2:0"
    elif change == "text":
        doc["evidence"][0]["text"] += " New text."
    elif change == "model":
        monkeypatch.setenv("TYPESAFE_DEFAULT_MODEL", "other-model")
    elif change == "prompt":
        monkeypatch.setattr(jev, "PROMPT_VERSION", "next-prompt")
    elif change == "policy":
        monkeypatch.setattr(jev, "POLICY_VERSION", "next-policy")
    else:
        monkeypatch.setattr(jev_proof, "VERSION", "next-proof")
    assert jev.judge_matches(query, [doc], cache_namespace=namespace)["cached"] == 0
    doc["folder"] = "Renamed"
    result = jev.judge_matches(query, [doc], cache_namespace=namespace)
    assert result["cached"] == 1 and result["matches"][0]["folder"] == "Renamed"


def long_result():
    docs = []
    for i in range(8):
        doc = match(str(i), text="Versions remain محفوظות unchanged. " * 2000)
        with sdk({"coverage": "partial"}) as client:
            doc["jev"] = jev.judge_matches("Question", [match()], client=client)["matches"][0]["jev"]
        doc["jev"]["supporting_chunk_ids"] = [f"{i}:v1:0"]
        doc["jev"]["evaluated_evidence"] = [
            {
                "chunk_id": f"{i}:v1:0",
                "text": doc["evidence"][0]["text"][:2400],
                "text_start": 0,
                "text_end": 2400,
            }
        ]
        doc["retrieval"] = {"rank": i + 1}
        docs.append(doc)
    return {"matches": docs, "status": "ok", "evaluation": {"status": "evaluated"}}


def test_compact_projection_same_decisions_bounded_unicode_bytes_no_duplicate_text():
    full = long_result()
    saved = copy.deepcopy(full)
    compact = project_search(full)
    assert (
        len(json.dumps(compact, ensure_ascii=False, separators=(",", ":")).encode())
        <= COMPACT_BYTES
    )
    for a, b in zip(full["matches"], compact["matches"], strict=True):
        assert a["retrieval"] == b["retrieval"] and a["jev"]["label"] == b["jev"]["label"]
        assert a["jev"]["supporting_chunk_ids"] == b["jev"]["supporting_chunk_ids"]
        assert "evaluated_evidence" not in b["jev"] and "probabilities" not in b["jev"]
        assert b["evidence"][0]["excerpt_truncated"]
    assert full == saved and project_search(full, "full") == full


def test_actual_mcp_discovery_schema_json_text_and_full_diagnostics(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", True)
    result = long_result()
    monkeypatch.setattr(server, "search_full", lambda *a: copy.deepcopy(result))

    async def exercise():
        async with Client(server.mcp) as client:
            tools = (await client.list_tools()).tools
            assert {t.name for t in tools} == {
                "upload",
                "download",
                "search",
                "upload_folder",
                "download_folder",
                "remove_file",
                "scan_freshness",
                "get_freshness_scan",
                "cancel_freshness_scan",
                "review_freshness_finding",
                "ask",
                "list_jev_decisions",
                "resolve_jev_decision",
            }
            schema = next(t.input_schema for t in tools if t.name == "search")
            assert schema["properties"]["detail"]["default"] == "compact"
            assert schema["properties"]["detail"]["enum"] == ["compact", "full"]
            responses = []
            for arguments in ({"query": "Q"}, {"query": "Q", "detail": "full"}):
                response = await client.call_tool("search", arguments)
                assert not response.is_error
                assert json.loads(response.content[0].text) == response.structured_content
                responses.append(response.structured_content)
            assert "probabilities" not in responses[0]["matches"][0]["jev"]
            assert "evaluated_evidence" in responses[1]["matches"][0]["jev"]

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "mutation", ["update", "external_update", "delete", "move", "reset", "evidence"]
)
def test_final_freshness_after_provider_latency_actual_storage(tmp_path, monkeypatch, mutation):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    content = b"The feline cat rests."
    doc = storage.save_file(tmp_path, content, "cat.txt")
    ingest.index_document(tmp_path, doc, content, FixtureEmbedder())
    search.save_organization(
        tmp_path,
        doc["document_id"],
        "v1",
        {"status": "evaluated", "folder": "Project", "groups": []},
    )
    entered, release = threading.Event(), threading.Event()

    def provider(query, matches, **kwargs):
        entered.set()
        assert release.wait(5)
        for m in matches:
            m["jev"] = {
                "status": "evaluated",
                "label": "uncertain",
                "possible_conflicting_chunk_ids": [m["evidence"][0]["evidence_id"]],
            }
        return {"status": "evaluated", "matches": matches}

    monkeypatch.setattr(jev, "judge_matches", provider)
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(
            server.search, "cat", mode="keyword", folder="Project", evaluate=True, detail="full"
        )
        assert entered.wait(3)
        try:
            if mutation == "update":
                storage.save_file(
                    tmp_path, b"New dog head", "cat.txt", document_id=doc["document_id"]
                )
            elif mutation == "external_update":
                subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        "import sys; from symbiknow.library import storage; storage.save_file(sys.argv[1], b'External new head', 'cat.txt', document_id=sys.argv[2])",
                        str(tmp_path),
                        doc["document_id"],
                    ],
                    cwd=Path(__file__).resolve().parents[3],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )
            elif mutation == "delete":
                storage.delete_document(tmp_path, doc["document_id"], "v1")
            elif mutation == "move":
                search.save_organization(
                    tmp_path,
                    doc["document_id"],
                    "v1",
                    {"status": "evaluated", "folder": "Other", "groups": []},
                )
            elif mutation == "reset":
                search.remove_document(tmp_path, doc["document_id"])
            else:
                search.put_chunks(
                    tmp_path,
                    doc,
                    [
                        {
                            "chunk_id": "replacement",
                            "text": "changed cat evidence",
                            "basis": "text",
                            "vector": [1.0, 0.0, 0.1],
                            "provenance_json": "{}",
                        }
                    ],
                    "fixture",
                )
        finally:
            release.set()
        result = request.result(timeout=5)
    assert result["matches"] == []
    if mutation == "evidence":
        # Re-extraction invalidates automatic placement before the provider
        # returns. The changed source no longer belongs to the requested scope.
        assert result["answer"]["status"] == "no_candidates"
        state = search.get_document_status(tmp_path, doc["document_id"])
        assert state["folder"] == "" and state["organization_status"] == "pending"
    if mutation != "delete":
        assert storage.read_file(tmp_path, doc["document_id"], "v1")[0] == content


def test_unchanged_eight_results_actual_rocfl_reads_below_baseline(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    for i in range(8):
        doc = storage.save_file(tmp_path, b"cat history", f"history-{i}.txt")
        ingest.index_document(tmp_path, doc, b"cat history", FixtureEmbedder())
    calls = []
    original = storage._run

    def counted(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(storage, "_run", counted)
    result = server.search("cat", mode="keyword", limit=8)
    assert len(result["matches"]) == 8
    assert not calls  # Sixteen authoritative identities use two native batches.
    assert result["metrics"]["head_reads"] == 16
    assert result["metrics"]["head_batches"] == result["metrics"]["storage_backend_batches"] == 2


@pytest.mark.parametrize("confidence", [.4, .599])
def test_uncertain_verification_never_publishes_a_premise_correction(confidence):
    with sdk({"coverage": "correction"}, confidence=confidence) as client:
        result = jev.judge_matches("Why does this mechanism exist?", [match()], client=client)
    verdict = result["matches"][0]["jev"]
    assert not verdict["conflicting_chunk_ids"]
    assert verdict["coverage"] == "unknown"


@pytest.mark.parametrize("mutation", ["link_reset", "link_target_update", "link_target_delete"])
def test_relationships_are_refreshed_after_blocked_provider(tmp_path, monkeypatch, mutation):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    source = storage.save_file(tmp_path, b"cat rests", "cat.txt")
    target = storage.save_file(tmp_path, b"dog rests", "dog.txt")
    for metadata, text in [(source, b"cat rests"), (target, b"dog rests")]:
        ingest.index_document(tmp_path, metadata, text, FixtureEmbedder())
    source_ref = search.document_evidence(tmp_path, source["document_id"], "v1")[0]["evidence_id"]
    target_ref = search.document_evidence(tmp_path, target["document_id"], "v1")[0]["evidence_id"]
    link = {
        "document_id": target["document_id"],
        "version": "v1",
        "source_version": "v1",
        "relation": "related",
        "source_chunk_id": source_ref,
        "target_chunk_id": target_ref,
    }
    search.save_organization(
        tmp_path,
        source["document_id"],
        "v1",
        {"status": "evaluated", "folder": "Project", "links": [link], "groups": []},
    )
    entered, release = threading.Event(), threading.Event()

    def provider(query, matches, **kwargs):
        assert matches[0]["links"] == []  # final publication alone validates relationships
        entered.set()
        assert release.wait(5)
        for m in matches:
            m["jev"] = {
                "status": "evaluated",
                "label": "direct",
                "coverage": "complete",
                "supporting_chunk_ids": [m["evidence"][0]["evidence_id"]],
                "evaluated_evidence": jev._evidence(m, query),
            }
        return {"status": "evaluated", "matches": matches}

    monkeypatch.setattr(jev, "judge_matches", provider)
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(server.search, "cat", mode="keyword", evaluate=True, detail="full")
        assert entered.wait(3)
        try:
            if mutation == "link_reset":
                search.save_organization(
                    tmp_path,
                    source["document_id"],
                    "v1",
                    {"status": "evaluated", "folder": "Project", "links": [], "groups": []},
                )
            elif mutation == "link_target_update":
                storage.save_file(
                    tmp_path, b"new dog head", "dog.txt", document_id=target["document_id"]
                )
            else:
                storage.delete_document(tmp_path, target["document_id"], "v1")
        finally:
            release.set()
        result = request.result(timeout=5)
    assert result["matches"][0]["links"] == []
    assert storage.read_file(tmp_path, source["document_id"], "v1")[0] == b"cat rests"
