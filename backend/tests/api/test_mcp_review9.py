"""Review 9: explicit semantics, useful bounded pages and publication races."""

import asyncio
import json
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from mcp import Client

from symbiknow.ai import jev
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.search.evaluation import premise_metrics
from symbiknow.search.projection import COMPACT_BYTES, SDK_RESULT_BYTES, project_search
from tests.ai.test_jev import match


def test_negative_answer_correction_and_disagreement_are_separate():
    from tests.ai.test_jev_proof import sdk
    for coverage, expected in [("complete", "complete"), ("correction", "none"),
                                ("conflicting", "unknown"), ("partial", "partial")]:
        with sdk({"coverage": coverage}) as client:
            result = jev.judge_matches("Does the policy preserve revisions?", [match()], client=client)
        judgment = result["matches"][0]["jev"]
        if coverage == "correction":
            assert judgment["conflicting_chunk_ids"]
        else:
            assert judgment["coverage"] == expected


@pytest.mark.parametrize("source", ["Wrong entity", "Rejected proposal", "Unrelated silence"])
def test_wrong_entity_rejected_status_or_silence_do_not_promote(source):
    from tests.ai.test_jev_proof import sdk
    with sdk({"coverage": "missing", "proof_0_0": "unused"}) as client:
        result = jev.judge_matches("Question", [match(text=source)], client=client)
    judgment = result["matches"][0]["jev"]
    assert not judgment["supporting_chunk_ids"] and not judgment["conflicting_chunk_ids"]
    assert judgment["coverage"] != "complete"


def result_fixture(count, citations=1):
    docs = []
    for i in range(count):
        m = match(str(i), text="Useful preserved revisions محفوظات. " * 100)
        m["filename"] = "📚שם文件" * 240
        m.update(folder="Project", groups=["Group"], retrieval={"rank": i + 1})
        m["evidence"] = [
            dict(m["evidence"][0], evidence_id=f"{i}:v1:t{p}") for p in range(citations)
        ]
        refs = [r["evidence_id"] for r in m["evidence"]]
        m["jev"] = dict(
            status="evaluated",
            label="direct",
            model_label="direct",
            coverage="complete",
            supporting_chunk_ids=refs,
            conflicting_chunk_ids=refs,
            possible_conflicting_chunk_ids=refs,
            evaluated_evidence=[
                dict(
                    chunk_id=r["evidence_id"], text=r["text"], text_start=0, text_end=len(r["text"])
                )
                for r in m["evidence"]
            ],
        )
        docs.append(m)
    return dict(status="ok", matches=docs, evaluation={"status": "evaluated"})


@pytest.mark.parametrize("count", [0, 1, 8, 10, 62, 100])
def test_all_projected_pages_keep_excerpts_order_and_roles(count):
    result = result_fixture(count, 3)
    seen, offset = [], 0
    while True:
        page = project_search(result, offset=offset, continuation=lambda n: str(n))
        assert (
            len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode())
            <= COMPACT_BYTES
        )
        for m in page["matches"]:
            assert all(r["text"] for r in m["evidence"])
            ids = {r["evidence_id"] for r in m["evidence"]}
            assert set(m["jev"]["supporting_chunk_ids"]) <= ids
        seen.extend(
            (m["document_id"], m["version"], m["retrieval"], m["jev"]["label"])
            for m in page["matches"]
        )
        if not page["page"]["has_more"]:
            break
        assert page["page"]["returned_count"] > 0
        offset = int(page["page"]["continuation"])
    assert seen == [
        (m["document_id"], m["version"], m["retrieval"], m["jev"]["label"])
        for m in result["matches"]
    ]


def test_many_citations_are_explicitly_omitted_and_never_dangle():
    page = project_search(result_fixture(1, 80))
    m = page["matches"][0]
    ids = {r["evidence_id"] for r in m["evidence"]}
    assert m["omissions"]["citations"]["supporting_chunk_ids"] == 72
    for key in ["supporting_chunk_ids", "conflicting_chunk_ids", "possible_conflicting_chunk_ids"]:
        assert set(m["jev"][key]) == ids
    assert all(r["text"] for r in m["evidence"])


def test_visual_preview_is_honest():
    m = match(basis="image", text="")
    row = project_search({"matches": [m]})["matches"][0]["evidence"][0]
    assert row["basis"] == "image" and row["text"] == ""
    assert row["assessment"] == "not_evaluated"


def test_actual_sdk_pages_and_bad_cursors(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "search_full", lambda *args: result_fixture(100, 3))
    monkeypatch.setattr(
        server.application().search, "refresh", lambda ms, *args: (ms, search.revisions(tmp_path))
    )

    async def exercise():
        async with Client(server.mcp) as c:
            schema = await c.list_tools()
            assert {t.name for t in schema.tools} == {
                "upload",
                "download",
                "search",
                "upload_folder",
                "download_folder",
                "remove_file",
                "ask",
                "list_documents", "get_taxonomy", "list_jev_decisions", "get_organization_history", "list_jobs",
                "resolve_jev_decision",
                "get_job",
            }
            props = next(t for t in schema.tools if t.name == "search").input_schema["properties"]
            assert props["detail"]["default"] == "compact" and "continuation" in props
            args = dict(query="Q", limit=100, folder="Project", mode="keyword")
            ids, token = [], None
            while True:
                r = await c.call_tool("search", args | ({"continuation": token} if token else {}))
                assert not r.is_error
                page = r.structured_content
                assert json.loads(r.content[0].text) == page
                assert (
                    len(json.dumps(page, ensure_ascii=False, separators=(",", ":")).encode())
                    <= COMPACT_BYTES
                )
                assert len(r.model_dump_json().encode()) <= SDK_RESULT_BYTES
                ids.extend(m["document_id"] for m in page["matches"])
                token = page["page"]["continuation"]
                if token is None:
                    break
            assert ids == [str(i) for i in range(100)]
            first = (await c.call_tool("search", args)).structured_content
            token = first["page"]["continuation"]
            for changed in [
                dict(query="other"),
                dict(folder="other"),
                dict(group="other"),
                dict(mode="semantic"),
                dict(evaluate=True),
                dict(limit=99),
                dict(detail="full"),
            ]:
                assert (
                    await c.call_tool("search", args | changed | {"continuation": token})
                ).is_error
            assert (await c.call_tool("search", args | {"continuation": "bad"})).is_error
            monkeypatch.setattr(server, "CURSOR_TTL", -1)
            assert (await c.call_tool("search", args | {"continuation": token})).is_error
            full = await c.call_tool("search", args | {"detail": "full"})
            assert len(full.structured_content["matches"]) == 100

    asyncio.run(exercise())


def populate(root, count):
    docs = []
    for i in range(count):
        text = "cat history with useful retained versions. " * 20
        d = storage.save_file(root, text.encode(), f"cat-{i}.txt")
        search.put_chunks(
            root,
            d,
            [
                dict(
                    chunk_id=f"{d['document_id']}:v1:t0",
                    text=text,
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "review9-test",
        )
        search.set_document_status(root, d, status="indexed", indexed_version="v1", chunk_count=1)
        search.save_organization(
            root,
            d["document_id"],
            "v1",
            dict(status="evaluated", folder="Project", groups=["Group"]),
        )
        docs.append(d)
    return docs


@pytest.mark.parametrize("mutation", ["commit_gap", "delete", "move", "group", "reset", "pending"])
def test_real_cursor_restarts_after_mutation(tmp_path, monkeypatch, mutation):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    docs = populate(tmp_path, 62)
    args = dict(query="cat", mode="keyword", limit=100, folder="Project", group="Group")
    first = server.search(**args)
    assert first["page"]["has_more"]
    # Mutation beyond the first page: continuation checks the entire bounded window.
    target_id = server.search(**args, detail="full")["matches"][-1]["document_id"]
    target = next(d for d in docs if d["document_id"] == target_id)
    if mutation == "commit_gap":
        subprocess.run(
            [
                sys.executable,
                "-c",
                "from symbiknow.library import storage; import sys; storage.save_file(sys.argv[1],b'new head','cat.txt',document_id=sys.argv[2])",
                str(tmp_path),
                target_id,
            ],
            check=True,
            capture_output=True,
            timeout=10,
        )
    elif mutation == "delete":
        storage.delete_document(tmp_path, target_id, "v1")
    elif mutation == "move":
        search.save_organization(
            tmp_path, target_id, "v1", dict(status="evaluated", folder="Other", groups=["Group"])
        )
    elif mutation == "group":
        search.save_organization(
            tmp_path, target_id, "v1", dict(status="evaluated", folder="Project", groups=[])
        )
    elif mutation == "reset":
        search.remove_document(tmp_path, target_id)
    else:
        search.set_document_status(tmp_path, target, status="pending")
    with pytest.raises(ValueError, match="restart search"):
        server.search(**args, continuation=first["page"]["continuation"])


def test_candidate_head_work_does_not_hold_index_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    populate(tmp_path, 10)
    entered, release, independent = threading.Event(), threading.Event(), threading.Event()
    original = storage.metadata_many
    blocked_thread = None

    def head(root, identity):
        nonlocal blocked_thread
        if (
            threading.current_thread().name.startswith("ThreadPoolExecutor")
            and blocked_thread is None
        ):
            blocked_thread = threading.get_ident()
            entered.set()
            assert release.wait(5)
        return original(root, identity)

    monkeypatch.setattr(storage, "metadata_many", head)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(server.search, "cat", mode="keyword", limit=8, detail="full")
        assert entered.wait(3)

        def other():
            with search.INDEX_LOCK:
                independent.set()

        second = pool.submit(other)
        try:
            assert independent.wait(2)
        finally:
            release.set()
        second.result()
        result = future.result(timeout=5)
    identities = [m["document_id"] for m in result["matches"]]
    assert identities == sorted(identities)  # equal-score document-ID tie break
    assert result["metrics"]["candidate_head_checks"] == 8
    assert result["metrics"]["head_reads"] == 16
    assert result["metrics"]["head_batches"] == 2
    assert result["metrics"]["storage_backend_batches"] == 2


def test_possible_correction_is_not_quality_success():
    j = dict(
        status="evaluated",
        conflicting_chunk_ids=[],
        possible_conflicting_chunk_ids=["a"],
        evaluated_evidence=[dict(chunk_id="a")],
    )
    m = premise_metrics([dict(expected_correction=True, judgment=j)])
    assert m["accepted_correction_recall"] == 0 and m["abstentions"] == 1
    assert m["evidence_id_correctness"] == 1


def test_cached_end_to_end_finishes_while_cold_provider_is_blocked(tmp_path, monkeypatch):
    from symbiknow.ai import proof as jev_proof
    from tests.ai.test_jev_proof import sdk

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    populate(tmp_path, 8)
    entered, release, done = threading.Event(), threading.Event(), threading.Event()

    def provider(state, questions, client=None):
        if state["user_question"] == "cat history":
            entered.set()
            assert release.wait(5)
        with sdk({"coverage": "missing"}) as client:
            return client.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", provider)
    server.search("cat", mode="keyword", limit=8, evaluate=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        cold = pool.submit(server.search, "cat history", mode="keyword", limit=8, evaluate=True)
        assert entered.wait(3)

        def hit():
            result = server.search("cat", mode="keyword", limit=8, evaluate=True)
            done.set()
            return result

        cached = pool.submit(hit)
        try:
            assert done.wait(2)
            assert cached.result()["evaluation"]["cached"] == 8
        finally:
            release.set()
        result = cold.result(timeout=5)
        assert result["matches"] == []
        assert result["answer"]["evaluated_count"] == 8


def test_unevaluated_passages_are_refreshed_before_publication(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    doc = populate(tmp_path, 1)[0]
    original = search.find_documents

    def changed(*args, **kwargs):
        matches = original(*args, **kwargs)
        search.put_chunks(
            tmp_path,
            doc,
            [
                dict(
                    chunk_id=f"{doc['document_id']}:v1:t0",
                    text="cat changed extracted window",
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "review9-test",
        )
        return matches

    monkeypatch.setattr(search, "find_documents", changed)
    result = server.search("cat", mode="keyword", detail="full")
    assert result["matches"][0]["evidence"][0]["text"] == "cat changed extracted window"
    assert result["matches"][0]["jev"]["reason"] == "evidence_changed"


def test_final_snapshot_excludes_supported_cross_process_writer(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    doc = populate(tmp_path, 1)[0]
    entered, release = threading.Event(), threading.Event()
    original = storage.metadata_many
    calls = 0

    def head(root, identity):
        nonlocal calls
        calls += 1
        if calls == 2:  # authoritative final head, inside read_snapshot
            entered.set()
            assert release.wait(5)
        return original(root, identity)

    monkeypatch.setattr(storage, "metadata_many", head)
    marker = tmp_path / "writer-attempted"
    child_code = (
        "import sys; from pathlib import Path; from symbiknow.library import storage; "
        "Path(sys.argv[3]).write_text('attempting'); "
        "storage.save_file(sys.argv[1],b'cat new version','cat.txt',document_id=sys.argv[2]); "
        "print('committed',flush=True)"
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(server.search, "cat", mode="keyword", detail="full")
        assert entered.wait(3)
        child = subprocess.Popen(
            [sys.executable, "-c", child_code, str(tmp_path), doc["document_id"], str(marker)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            # The child's file marker establishes its event order before we release the snapshot.
            import time

            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline:
                threading.Event().wait(0.01)
            assert marker.exists() and child.poll() is None
            assert json.loads(storage._run(tmp_path, "cat", doc["document_id"], "metadata.json"))["version"] == "v1"
        finally:
            release.set()
        result = request.result(timeout=5)
        stdout, stderr = child.communicate(timeout=5)
        assert child.returncode == 0, stderr
    assert stdout.strip() == b"committed"
    assert result["matches"][0]["version"] == "v1"  # valid protected publication snapshot
    assert storage.read_metadata(tmp_path, doc["document_id"])["version"] == "v2"
    assert server.search("cat", mode="keyword")["matches"] == []


def test_mixed_visual_and_text_preview_keeps_available_text():
    m = match(basis="image", text="")
    m["evidence"].append(
        {"evidence_id": "doc1:v1:ocr", "basis": "ocr", "text": "Readable OCR fact."}
    )
    m["jev"] = {"status": "evaluated", "label": "related"}
    row = project_search({"matches": [m]})["matches"][0]["evidence"][0]
    assert row["basis"] == "ocr" and row["text"] == "Readable OCR fact."


def test_batched_passages_preserve_identity_version_and_bound(tmp_path):
    docs = populate(tmp_path, 2)
    ref = "shared'passage"
    for i, doc in enumerate(docs):
        search.put_chunks(
            tmp_path,
            doc,
            [
                dict(
                    chunk_id=ref,
                    text=f"cat source {i}",
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "review9-test",
        )
    requested = [(d["document_id"], "v1", ref) for d in docs]
    requested.append((docs[0]["document_id"], "v2", ref))
    with search.INDEX_LOCK:
        records = search.resolve_evidence_many(tmp_path, requested)
        for i, doc in enumerate(docs):
            key = (doc["document_id"], "v1", ref)
            assert records[key] == search.resolve_evidence(tmp_path, *key)
            assert records[key]["text"] == f"cat source {i}"
        assert requested[-1] not in records
        with pytest.raises(ValueError, match="bounded"):
            search.resolve_evidence_many(tmp_path, [("d", "v1", str(i)) for i in range(2001)])
