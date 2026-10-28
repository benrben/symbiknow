"""An empty checked result still observes the compact metadata budget."""

import copy
import json

import pytest

from symbiknow.search.projection import COMPACT_BYTES, project_search


def unavailable_result(query="Who is the keeper?", folder=None, group=None):
    return {
        "matches": [],
        "status": "unavailable",
        "evaluation": {"status": "unavailable"},
        "answer": {"status": "unavailable"},
        "retrieval_fallback": {
            "tool": "search",
            "arguments": {"query": query, "mode": "semantic", "limit": 3,
                          "folder": folder, "group": group, "evaluate": False},
        },
    }


def test_compact_keeps_exact_small_fallback_arguments():
    result = unavailable_result(folder="Research / Sources", group="Reference")
    assert project_search(result)["retrieval_fallback"] == result["retrieval_fallback"]


@pytest.mark.parametrize("result", [
    unavailable_result(query="😀" * 3000, folder="😀" * 3000, group="😀" * 3000),
    unavailable_result(query="\x01" * 3990 + " keeper",
                       folder=" / ".join(["😀" * 200] * 12)),
])
def test_oversized_fallback_is_omitted_explicitly_without_changing_exact_full_arguments(result):
    saved = copy.deepcopy(result)
    compact = project_search(result)
    assert len(json.dumps(compact, ensure_ascii=False, separators=(",", ":")).encode()) <= COMPACT_BYTES
    assert compact["status"] == compact["answer"]["status"] == "unavailable"
    assert "retrieval_fallback" not in compact
    assert compact["omissions"]["retrieval_fallback"] == "use detail=full for exact retrieval-only arguments"
    assert compact["matches"] == [] and not compact["page"]["has_more"]
    assert project_search(result, "full") == saved and result == saved


def test_empty_result_rejects_other_oversized_compact_metadata():
    result = unavailable_result()
    result["extra_metadata"] = "😀" * 10000
    with pytest.raises(ValueError, match="Compact metadata exceeds budget; repeat with detail=full"):
        project_search(result)
    assert project_search(result, "full") == result
