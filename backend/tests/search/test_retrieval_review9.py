"""Continuation compares refreshed contents with the retained immutable window."""

import json

import pytest

from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from tests.api.test_mcp_review9 import populate, result_fixture


def test_continuation_detects_in_place_refresh_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "search_full", lambda *args: result_fixture(100, 3))
    first = server.search("Q", limit=100)

    def refresh(matches, *args):
        # Final validation deliberately updates entries in place. Comparing this
        # list with its own mutated input would silently accept the new window.
        matches[0]["evidence"][0]["text"] = "changed evaluated passage"
        return matches, search.revisions(tmp_path)

    monkeypatch.setattr(server.application().search, "refresh", refresh)
    with pytest.raises(ValueError, match="changed heads/evidence/links; restart search"):
        server.search("Q", limit=100, continuation=first["page"]["continuation"])


@pytest.mark.parametrize("mutation", ["evidence", "target_update", "target_delete"])
def test_real_continuation_detects_changes_without_derived_revision(
    tmp_path, monkeypatch, mutation
):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    docs = populate(tmp_path, 62)
    source = docs[0]
    target = storage.save_file(tmp_path, b"dog relationship target", "dog.txt")
    ref = f"{target['document_id']}:v1:t0"
    search.put_chunks(
        tmp_path,
        target,
        [
            dict(
                chunk_id=ref,
                text="dog relationship target",
                basis="text",
                vector=[1.0, 0.0, 0.1],
                provenance_json="{}",
            )
        ],
        "review9-test",
    )
    search.set_document_status(
        tmp_path, target, status="indexed", indexed_version="v1", chunk_count=1
    )
    search.save_organization(
        tmp_path,
        source["document_id"],
        "v1",
        dict(
            status="evaluated",
            folder="Project",
            groups=["Group"],
            links=[
                dict(
                    document_id=target["document_id"],
                    version="v1",
                    source_version="v1",
                    source_chunk_id=f"{source['document_id']}:v1:t0",
                    target_chunk_id=ref,
                    relation="related",
                )
            ],
        ),
    )
    args = dict(query="cat", mode="keyword", limit=100, folder="Project")
    full = server.search(**args, detail="full")
    assert next(m for m in full["matches"] if m["document_id"] == source["document_id"])["links"]
    first = server.search(**args)
    assert first["page"]["has_more"]
    revision = search.revisions(tmp_path)
    if mutation == "evidence":
        # Completed same-head extraction publishes a new evidence epoch and
        # index revision; the retained continuation must reject that boundary.
        search.put_chunks(
            tmp_path,
            source,
            [
                dict(
                    chunk_id=f"{source['document_id']}:v1:t0",
                    text="cat changed extracted evidence",
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "review9-test",
        )
    elif mutation == "target_update":
        storage.save_file(tmp_path, b"new dog head", "dog.txt", document_id=target["document_id"])
    else:
        storage.delete_document(tmp_path, target["document_id"], "v1")
    if mutation == "evidence":
        assert search.revisions(tmp_path)["index"] != revision["index"]
    else:
        # Unsupported direct original mutations still require exact final checks.
        assert search.revisions(tmp_path) == revision
    error = "index/organization changes" if mutation == "evidence" else "changed heads/evidence/links"
    with pytest.raises(ValueError, match=error + "; restart search"):
        server.search(**args, continuation=first["page"]["continuation"])
    # Stored cursor remains the original comparison baseline after rejection.
    window = server._CONTINUATIONS[first["page"]["continuation"].split(".")[0]]
    assert window["revision"] == revision
    cached = next(
        m for m in window["result"]["matches"] if m["document_id"] == source["document_id"]
    )
    assert cached["links"]
    assert cached["evidence"][0]["text"] != "cat changed extracted evidence"
    assert json.dumps(window["result"])


@pytest.mark.parametrize("status", ["accepted", "possible"])
def test_compact_disagreement_citations_remain_local_and_resolvable(status):
    from symbiknow.search.projection import project_search

    result = result_fixture(2, 12)
    for m in result["matches"]:
        refs = [e["evidence_id"] for e in m["evidence"]]
        m["jev"].update(
            evidence_disagreement=status,
            disagreement_chunk_ids=refs,
            disagreement_scope="supplied applicable passages across documents",
        )
    page = project_search(result)
    for m in page["matches"]:
        refs = set(m["jev"]["disagreement_chunk_ids"])
        evidence = {r["evidence_id"]: r for r in m["evidence"]}
        assert m["jev"]["evidence_disagreement"] == status
        assert refs == evidence.keys()
        assert all(ref.startswith(m["document_id"] + ":") for ref in refs)
        assert all("disagreement" in evidence[ref]["roles"] for ref in refs)
        assert m["omissions"]["citations"]["disagreement_chunk_ids"] == 4


@pytest.mark.parametrize("mutation", ["head", "passage", "scope"])
def test_cross_document_decisions_require_all_current_compared_windows(
    tmp_path, monkeypatch, mutation
):
    from symbiknow.ai import jev

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    docs = populate(tmp_path, 2)

    def provider(query, matches, **kwargs):
        refs = []
        for m in matches:
            ref = m["evidence"][0]["evidence_id"]
            text = m["evidence"][0]["text"]
            refs.append(ref)
            m["jev"] = dict(
                status="evaluated",
                label="direct",
                policy_label="direct",
                coverage="complete",
                supporting_chunk_ids=[ref],
                evaluated_evidence=[
                    dict(chunk_id=ref, text=text, text_start=0, text_end=len(text))
                ],
            )
        target = docs[0]
        if mutation == "head":
            storage.save_file(
                tmp_path, b"new cat head", "cat.txt", document_id=target["document_id"]
            )
        elif mutation == "scope":
            search.save_organization(
                tmp_path,
                target["document_id"],
                "v1",
                dict(status="evaluated", folder="Other", groups=[]),
            )
        else:
            search.put_chunks(
                tmp_path,
                target,
                [
                    dict(
                        chunk_id=f"{target['document_id']}:v1:t0",
                        text="cat changed counterpart passage",
                        basis="text",
                        vector=[1.0, 0.0, 0.1],
                        provenance_json="{}",
                    )
                ],
                "review9-test",
            )
        return dict(
            status="evaluated",
            matches=matches,
            cross_document_assessment=dict(
                status="evaluated",
                compared_chunk_ids=refs,
                probabilities={ref: 0.01 for ref in refs},
            ),
        )

    monkeypatch.setattr(jev, "judge_matches", provider)
    result = server.search("cat", mode="keyword", folder="Project", evaluate=True, detail="full")
    assert result["matches"] == []  # Invalidated judgments cannot remain answer results.
    assert result["answer"]["status"] == "unavailable"
    assert result["answer"]["not_evaluated_count"] >= 1
    assert result["evaluation"]["cross_document_assessment"]["status"] == "unavailable"
    assert result["evaluation"]["cross_document_assessment"]["reason"] == "evidence_changed"


def test_cursor_binds_active_judgment_policy(tmp_path, monkeypatch):
    from symbiknow.ai import jev

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "search_full", lambda *args: result_fixture(100, 3))
    args = dict(query="Q", limit=100)
    first = server.search(**args)
    cursor = first["page"]["continuation"]
    monkeypatch.setattr(
        jev, "POLICY_VERSION", jev.POLICY_VERSION + "-changed"
    )
    with pytest.raises(ValueError, match="evaluation policy differ; restart search"):
        server.search(**args, continuation=cursor)
