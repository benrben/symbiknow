"""Crash, overlap, admission, and evidence semantics of durable work."""
import threading

import pytest

from symbiknow.core.application import ApplicationContext
from symbiknow.core.contracts import DomainResult
from symbiknow.core.work import WorkStore


def test_update_during_lease_survives_old_acknowledgment(tmp_path):
    queue = WorkStore(tmp_path)
    queue.enqueue("ingest", "doc", {"version": "v1"}, replace=True)
    old = queue.claim("ingest")[0]
    queue.enqueue("ingest", "doc", {"version": "v2"}, replace=True)
    queue.finish(old, remove=True)
    next_item = queue.claim("ingest")[0]
    assert next_item["payload"] == {"version": "v2"}
    queue.recover()
    assert queue.claim("ingest")[0]["generation"] == next_item["generation"]


def test_durable_job_acknowledges_before_provider_and_survives_restart(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def retrieve(**args):
        calls.append(args["query"])
        args["on_retrieved"]([{"document_id": "one"}])
        entered.set()
        assert release.wait(3)
        return DomainResult({"matches": [], "answer": {"status": "not_evaluated", "reason": "context_budget"}})

    job = context.jobs.start("ask", {"query": "question"}, "retry-id")
    assert not calls and job["status"] == "queued"
    restarted = ApplicationContext(tmp_path)
    monkeypatch.setattr(restarted.search, "retrieve", retrieve)
    monkeypatch.setattr(restarted.search, "refresh", lambda matches, *args: (matches, {}))
    worker = threading.Thread(target=restarted.jobs.process_one)
    worker.start()
    try:
        assert entered.wait(2)
        progress = restarted.jobs.get(job["job_id"])
        assert progress["status"] == "running"
        assert progress["result"]["matches"][0]["document_id"] == "one"
    finally:
        release.set()
        worker.join(3)
    completed = restarted.jobs.get(job["job_id"])
    assert completed["status"] == "completed"
    assert completed["result"]["answer"]["reason"] == "context_budget"
    assert restarted.jobs.start("ask", {"query": "question"}, "retry-id")["status"] == "completed"
    with pytest.raises(ValueError, match="different arguments"):
        restarted.jobs.start("ask", {"query": "different"}, "retry-id")
    assert calls == ["question"]


def test_job_admission_and_argument_memory_are_bounded(tmp_path):
    queue = WorkStore(tmp_path)
    for i in range(256):
        queue.start("search", {"query": str(i)})
    with pytest.raises(ValueError, match="full"):
        queue.start("search", {"query": "overflow"})
    with pytest.raises(ValueError, match="128 KiB"):
        queue.start("search", {"query": "x" * 140000})


def test_bulk_backlog_does_not_claim_interactive_or_preview_capacity(tmp_path):
    queue = WorkStore(tmp_path)
    for i in range(100):
        queue.start("bulk-export", {"documents": []}, f"export-{i}")
    queue.start("search", {"query": "now"}, "search")
    queue.start("preview", {"document_id": "one"}, "preview")
    assert queue.claim("jobs", kinds=("ask", "search"))[0]["id"] == "search"
    assert queue.claim("jobs", kinds=("preview",))[0]["id"] == "preview"
    assert queue.claim("jobs", kinds=("ask", "search", "preview"), exclude=True)[0]["id"].startswith("export-")


@pytest.mark.parametrize("blocked_kind", ["upload-commit", "ask"])
def test_search_worker_runs_while_bulk_or_judge_is_blocked(tmp_path, monkeypatch, blocked_kind):
    context = ApplicationContext(tmp_path)
    entered, release, searched = threading.Event(), threading.Event(), threading.Event()

    def commit(identity):
        entered.set()
        assert release.wait(5)
        return {"stored": True}

    def retrieve(**args):
        if args["query"] == "blocked":
            commit("judge")
            return DomainResult({"matches": []})
        searched.set()
        return DomainResult({"matches": []})

    monkeypatch.setattr(context.transfers, "commit_upload", commit)
    monkeypatch.setattr(context.search, "retrieve", retrieve)
    context.jobs.open()
    try:
        context.jobs.start(blocked_kind, {"request_id": "one"} if blocked_kind == "upload-commit" else {"query": "blocked"})
        assert entered.wait(2)
        context.jobs.start("search", {"query": "now"})
        assert searched.wait(2)
        assert not release.is_set()
    finally:
        release.set()
        context.jobs.close()
