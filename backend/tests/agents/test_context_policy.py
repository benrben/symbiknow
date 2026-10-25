from symbiknow.api.agents.http import browser_result, context


def test_clear_context_covers_browser_replies_and_exact_versions():
    policy = dict(open_document=False, selection=False, scope=False, results=False)
    raw = dict(context_policy=policy, open_document={"document_id": "private", "version": "v2"},
               selection=["private"], selection_documents=[{"document_id": "private", "version": "v2"}],
               folder="Private", project="Private", query="secret", loaded_document_count=3,
               visible_documents=[{"document_id": "private", "version": "v2"}])
    assert context(raw) == {"context_policy": policy}
    reply = browser_result({"ok": True, "state": {**raw, "context_policy": dict.fromkeys(policy, True)}},
                           {"context_policy": policy})
    assert reply == {"ok": True, "state": {"context_policy": policy}}


def test_selected_metadata_is_bounded_and_contents_never_pass():
    result = context({"selection_documents": [{"document_id": "id", "version": "v4", "text": "secret"}] * 200,
                      "loaded_document_count": 250, "project": "Example"})
    assert len(result["selection_documents"]) == 100
    assert result["selection_documents"][0] == {"document_id": "id", "version": "v4"}
    assert result["loaded_document_count"] == 250
    assert result["project"] == "Example"
