"""Admission isolation must hold at saturation, not just during execution."""
import pytest

from symbiknow.core.work import JOB_POOL_LIMIT, WorkStore


def test_saturated_bulk_preserves_search_judge_and_preview_admission(tmp_path):
    queue = WorkStore(tmp_path)
    for i in range(JOB_POOL_LIMIT):
        queue.start("bulk-export", {"documents": []}, f"bulk-{i}")
    with pytest.raises(ValueError, match="Bulk job queue is full"):
        queue.start("upload-commit", {"request_id": "overflow"})
    for kind in ("search", "ask", "preview"):
        assert queue.start(kind, {}, kind)["status"] == "queued"
    assert queue.start("bulk-export", {"documents": []}, "bulk-0")["status"] == "queued"
    item = queue.claim("jobs", kinds=("bulk-export",))[0]
    with pytest.raises(ValueError, match="full"):
        queue.start("bulk-export", {"documents": []}, "still-full")
    queue.finish(item, {})
    assert queue.start("bulk-export", {"documents": []}, "freed")["status"] == "queued"
    # Retrying a failed/completed identity must not bypass a saturated pool.
    with pytest.raises(ValueError, match="full"):
        queue.enqueue("jobs", item["id"], item["payload"], replace=True)


def test_artifact_kinds_share_a_bounded_pool(tmp_path):
    queue = WorkStore(tmp_path)
    for i in range(JOB_POOL_LIMIT):
        queue.start("preview", {"document_id": str(i)})
    for kind in ("original-range", "original-prepare"):
        with pytest.raises(ValueError, match="Artifacts job queue is full"):
            queue.start(kind, {})
    assert queue.start("search", {"query": "available"})["status"] == "queued"
