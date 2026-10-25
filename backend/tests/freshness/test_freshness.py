"""Isolated originals/indexes, deterministic provider; never calls hosted Jev."""
import threading

import pytest

from symbiknow.freshness import service as freshness
from symbiknow.freshness import judgments as freshness_judgments
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.core.application import ApplicationContext
from symbiknow.freshness.store import encode
from tests.api.test_ui_api import context as context, indexed, mutate

REAL_COMPARE_MANY = freshness_judgments.compare_many


@pytest.fixture
def library(context):
    root, monkeypatch, client = context
    a = indexed(root, name="old-policy.txt", content=b"Atlas current production retention is 30 days.\n")
    b = indexed(root, name="new-policy.txt", content=b"Atlas current production retention is 90 days.\n")
    service = server.application().freshness
    monkeypatch.setattr(freshness_judgments, "classify", lambda ps, filename: {p["id"]: "claim" for p in ps})
    monkeypatch.setattr(freshness_judgments, "compare", lambda *args: {"scope": "same", "relation": "incompatible"})
    monkeypatch.setattr(freshness_judgments, "compare_many", lambda pairs, contexts, as_of, **callbacks: {
        p["id"]: freshness_judgments.compare(p["a"], p["b"], contexts, as_of) for p in pairs})
    return root, monkeypatch, client, service, a, b


def finish(service, limit=100):
    for _ in range(limit):
        if not service.process_one():
            return service.get()
    pytest.fail("Scan failed to terminate")


def test_scan_includes_unregistered_originals_without_enumerating_on_start(library):
    root, patch, _, service, *_ = library
    storage.save_file(root, b"Not yet registered", "pending.txt")
    original = storage.iter_documents
    calls = []

    def inventory(*args, **kwargs):
        calls.append(True)
        yield from original(*args, **kwargs)

    patch.setattr(storage, "iter_documents", inventory)
    service.start()
    assert not calls
    result = finish(service)["scan"]
    assert calls and result["documents_total"] == 3
    assert result["status"] == "partial"
    assert result["gaps"]["unreadable_or_changed_documents"] == 1


def test_documents_with_likely_credentials_are_withheld_from_hosted_comparison(library):
    import json

    root, patch, _, service, *_ = library
    key = "sk-ant-" + "api03-" + "Zq7Rk2Lm9Xw4Tn8Vb3Hc"  # Assembled; never a stored literal.
    indexed(root, name="deploy-notes.txt",
            content=f"Atlas current production retention is 60 days.\nATLAS_KEY={key}\n".encode())
    sent = []
    patch.setattr(freshness_judgments, "classify",
                  lambda ps, filename: sent.append(json.dumps(ps)) or {p["id"]: "claim" for p in ps})
    patch.setattr(freshness_judgments, "compare",
                  lambda *args: sent.append(json.dumps(args)) or {"scope": "same", "relation": "incompatible"})
    service.start()
    scan = finish(service)["scan"]
    assert scan["gaps"]["sensitive_content_withheld"] == 1
    assert scan["documents_read"] == 2 and scan["pairs_checked"] == 1
    assert sent and not any(key in request for request in sent)


def test_manual_scan_evidence_review_reuse_and_original_integrity(library):
    root, patch, client, service, a, b = library
    assert service.get()["scan"] is None
    assert not service.store.path.exists()
    calls = []
    patch.setattr(freshness_judgments, "compare", lambda *args: calls.append(args) or {"scope": "same", "relation": "incompatible"})
    job = service.start(request_id="first")
    assert service.start(request_id="first")["scan_id"] == job["scan_id"]
    with pytest.raises(ValueError, match="different scan options"):
        service.start([a["document_id"]], request_id="first")
    with pytest.raises(ValueError, match="already running"):
        service.start()
    page = finish(service)
    assert page["scan"]["documents_read"] == 2
    assert page["scan"]["pairs_checked"] == 1
    assert len(calls) == 1
    finding = page["findings"][0]
    assert finding["category"] == "conflicting" and finding["validity"] == "valid"
    for evidence in finding["evidence"]:
        actual = search.resolve_evidence(root, evidence["document_id"], evidence["version"], evidence["evidence_id"])
        assert actual["text"][evidence["start"]:evidence["end"]] == evidence["text"]
    review = service.review(job["scan_id"], finding["finding_id"], 1, "dismissed", "Different intended deployment")
    assert review["revision"] == 2 and review["review"] == "dismissed"
    with pytest.raises(ValueError, match="Finding changed"):
        service.review(job["scan_id"], finding["finding_id"], 1, "confirmed")
    assert service.get()["findings"][0]["review_note"] == "Different intended deployment"
    service.start(request_id="second")
    finish(service)
    assert len(calls) == 1  # Dependency-bound successful result reused.
    assert storage.read_file(root, a["document_id"])[0].endswith(b"30 days.\n")
    assert storage.read_file(root, b["document_id"])[0].endswith(b"90 days.\n")
    assert len(storage.version_page(root, a["document_id"])["versions"]) == 1


def test_agent_review_previews_current_finding_and_rejects_stale_approval(library):
    from symbiknow.api.agents.symbiknow import ProductTools

    _, _, _, service, _, _ = library
    service.start()
    finding = finish(service)["findings"][0]
    product = ProductTools(service.context)
    args = {
        "scan_id": finding["scan_id"],
        "finding_id": finding["finding_id"],
        "expected_revision": finding["revision"],
        "decision": "historical",
    }
    preview = product.preview("review_freshness_finding", args)
    assert preview["finding"] == finding
    assert service.get()["findings"][0]["review"] == "pending"
    receipt = product.write("review_freshness_finding", args, preview)
    assert receipt["finding_id"] == finding["finding_id"]
    assert receipt["review"] == "historical" and receipt["revision"] == finding["revision"] + 1

    with pytest.raises(ValueError, match="Read a current finding"):
        product.write("review_freshness_finding", args, preview)
    assert service.get()["findings"][0]["review"] == "historical"


def test_current_reference_is_explicit_and_does_not_change_conflict_without_one(library):
    _, _, _, service, a, b = library
    service.start(reference_document_ids=[b["document_id"]])
    f = finish(service)["findings"][0]
    assert f["category"] == "possibly_outdated"
    assert f["affected_document_id"] == a["document_id"]


def test_retired_generic_label_removed_from_saved_scans_and_badges(library):
    _, _, _, service, a, b = library
    service.start()
    page = finish(service)
    finding = page["findings"][0]
    service.review(finding["scan_id"], finding["finding_id"], 1, "confirmed", "Old review")
    with service.store.connection() as db:
        db.execute("UPDATE findings SET category='needs_review'")
        db.execute("PRAGMA user_version=1")
    page = service.get()
    assert page["findings"] == []
    assert page["scan"]["findings_total"] == 0
    assert not service.badges([a["document_id"], b["document_id"]])
    with service.store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0
    with pytest.raises(ValueError, match="Unknown freshness label"):
        service.get(category="needs_review")


def test_update_and_same_head_reindex_invalidate_findings(library):
    root, _, _, service, a, b = library
    service.start()
    f = finish(service)["findings"][0]
    search.set_document_status(root, a, status="pending")
    assert service.get()["findings"][0]["validity"] == "needs_recheck"
    with pytest.raises(ValueError, match="Evidence changed"):
        service.review(f["scan_id"], f["finding_id"], 1, "confirmed")
    assert not service.process_one()  # No automatic rescan after mutation.
    storage.save_file(root, b"updated", b["filename"], document_id=b["document_id"], expected_version="v1")
    assert service.get()["scan"]["coverage_changed"]


def test_delete_marks_saved_finding_without_touching_other_original(library):
    root, _, _, service, a, b = library
    service.start()
    finish(service)
    server.application().library.delete_item("delete-document", {"document_id": a["document_id"], "expected_version": "v1"})
    finding = service.get()["findings"][0]
    assert finding["validity"] == "source_removed"
    assert next(e for e in finding["evidence"] if e["document_id"] == a["document_id"])["text"] == ""
    with service.store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM passages WHERE document=?", (a["document_id"],)).fetchone()[0] == 0
    assert storage.read_file(root, b["document_id"])[0]


def test_cancel_during_provider_prevents_publication_and_recovery_does_not_restart(library):
    root, patch, _, service, _, _ = library
    entered, release = threading.Event(), threading.Event()
    def compare(*args):
        entered.set()
        assert release.wait(10)
        return {"scope": "same", "relation": "incompatible"}
    patch.setattr(freshness_judgments, "compare", compare)
    job = service.start()
    for _ in range(20):
        page = service.get()
        if page["scan"]["pairs_total"]:
            break
        service.process_one()
    thread = threading.Thread(target=service.process_one)
    thread.start()
    assert entered.wait(5)
    service.cancel(job["scan_id"])
    release.set()
    thread.join(10)
    assert not thread.is_alive()
    restarted = ApplicationContext(root).freshness
    assert restarted.get()["scan"]["status"] == "cancelled"
    assert restarted.get()["findings"] == []
    assert not restarted.process_one()


def test_changed_source_during_comparison_not_published(library):
    root, patch, _, service, a, _ = library
    def compare(*args):
        storage.save_file(root, b"new policy", a["filename"], document_id=a["document_id"], expected_version="v1")
        return {"scope": "same", "relation": "incompatible"}
    patch.setattr(freshness_judgments, "compare", compare)
    service.start()
    page = finish(service)
    assert not page["findings"]
    assert page["scan"]["gaps"]["changed_evidence_pairs"] == 1


def test_restart_resumes_saved_manual_job_and_paid_result_cache(library):
    root, patch, _, service, _, _ = library
    calls = []
    patch.setattr(freshness_judgments, "classify", lambda ps, filename: calls.append(filename) or {p["id"]: "claim" for p in ps})
    service.start()
    for _ in range(10):
        service.process_one()
        if calls:
            break
    assert len(calls) == 1
    page = finish(ApplicationContext(root).freshness)
    assert page["scan"]["status"] in {"completed", "partial"}
    assert len(calls) == 2 and len(page["findings"]) == 1


def test_provider_failure_is_reported_and_not_cached(library):
    _, patch, _, service, _, _ = library
    patch.setattr(freshness_judgments, "compare", lambda *args: (_ for _ in ()).throw(TimeoutError()))
    service.start()
    page = finish(service)
    assert page["scan"]["status"] == "failed" and "TimeoutError" in page["scan"]["error"]
    assert not page["findings"]
    patch.setattr(freshness_judgments, "compare", lambda *args: {"scope": "same", "relation": "incompatible"})
    service.start()
    assert len(finish(service)["findings"]) == 1


def test_context_limit_is_visible_and_never_creates_directional_claim(library):
    _, patch, _, service, _, _ = library
    patch.setattr(freshness_judgments, "MAX_CONTEXT", 1)
    patch.setattr(freshness_judgments, "compare", lambda *args: pytest.fail("Must not judge truncated context"))
    service.start()
    page = finish(service)
    assert page["scan"]["status"] == "partial"
    assert page["scan"]["gaps"]["context_limit_pairs"] == 1
    assert not page["findings"]


def test_full_evidence_iteration_and_spans_include_trailing_context():
    doc = {"document_id": "d", "version": "v1", "filename": "a", "evidence_revision": "r"}
    text = "First claim.\n\n" + "x" * 3400 + "\n\nTrailing historical disclaimer.\n"
    spans = list(freshness.segments({"text": text, "evidence_id": "e", "provenance": {}}, doc, 0))
    assert len(spans) == 5
    assert spans[-1]["text"] == "Trailing historical disclaimer.\n"
    for p in spans:
        assert text[p["start"]:p["end"]] == p["text"]
    assert all(len(p["text"]) <= 1600 for p in spans)


def test_compact_state_keeps_textual_provenance_without_changing_citations():
    provenance = {"heading": "Historical qualification", "bbox": [1, 2, 3, 4],
                  "pages": [{"page_no": 7, "bbox": [1]}, {"page_no": 7, "bbox": [2]}]}
    passage = {"id": "p", "document_id": "d", "text": "Current instructions despite the older heading.",
               "sha256": "local hash", "provenance": provenance}
    before = encode(passage)
    documents, paths = freshness_judgments.prepare_context([
        {"document_id": "d", "filename": "notes.md", "passages": [passage]}])
    assert paths[("d", "p")] == "documents[0].passages[0].text"
    assert documents[0]["passages"][0] == {
        "text": passage["text"], "source": {"heading": "Historical qualification", "pages": [{"page_no": 7}]}}
    assert encode(passage) == before


def test_all_thirteen_passages_and_late_qualifier_are_supplied(library):
    root, patch, _, service, a, _ = library
    from tests.search.test_search import FixtureEmbedder
    rows = [{
        "chunk_id": f"{a['document_id']}:v1:t{i}", "text": f"Atlas policy section {i}: retain logs for 30 days." if i < 12 else "These are historical policies, not current guidance.",
        "basis": "text", "provenance_json": "{}", "vector": [1.0, 0.0, 0.1],
    } for i in range(13)]
    search.put_chunks(root, a, rows, FixtureEmbedder.model_id)
    assert len(search.document_evidence(root, a["document_id"], "v1")) == 12
    assert sum(len(batch) for batch in search.evidence_batches(root, a["document_id"], "v1", 3)) == 13
    seen = []
    def compare(a, b, contexts, as_of):
        seen.append(contexts)
        return {"scope": "historical_or_hypothetical", "relation": "compatible"}
    patch.setattr(freshness_judgments, "compare", compare)
    service.start()
    page = finish(service, limit=300)
    assert page["scan"]["passages_read"] == 14
    assert page["scan"]["passages_classified"] == 14
    assert seen
    assert all(any(p["text"].startswith("These are historical") for c in contexts for p in c["passages"])
               for contexts in seen)
    assert not page["findings"]


def test_badges_are_invalidated_and_reset_does_not_erase_findings(library):
    root, _, _, service, a, b = library
    service.start()
    finish(service)
    docs = server.application().library.library({}).to_wire()["documents"]
    assert all(d["freshness_labels"] == ["Conflicting"] for d in docs)
    search.save_organization(root, a["document_id"], "v1", {"status": "evaluated", "folder": "New", "groups": [], "links": []})
    assert service.get()["findings"][0]["validity"] == "valid"
    search.set_document_status(root, b, status="pending")
    assert service.badges([a["document_id"]])[a["document_id"]] == ["Needs recheck"]


def test_changed_check_date_marks_recheck_without_model_call(library):
    _, patch, _, service, _, _ = library
    service.start()
    finish(service)
    patch.setattr(freshness, "now", lambda: "2099-01-02T00:00:00+00:00")
    assert service.get()["findings"][0]["validity"] == "needs_recheck"
    assert service.get()["scan"]["coverage_changed"]
    assert not service.process_one()


def test_wire_contracts_include_freshness(library):
    from tests.core.test_wire_contracts import validate
    _, _, _, service, _, _ = library
    validate("FreshnessPage", service.get())
    validate("FreshnessScan", service.start())
    page = finish(service)
    validate("FreshnessPage", page)
    validate("FreshnessFinding", page["findings"][0])


def test_shared_context_batches_stream_early_and_reuse_each_decision(library):
    root, patch, _, service, a, _ = library
    from tests.search.test_search import FixtureEmbedder
    search.put_chunks(root, a, [{
        "chunk_id": f"{a['document_id']}:v1:t{i}",
        "text": f"Atlas production retention policy section {i}: keep logs for 30 days.",
        "basis": "text", "provenance_json": "{}", "vector": [1.0, 0.0, 0.1],
    } for i in range(12)], FixtureEmbedder.model_id)
    calls = []
    def compare(pairs, contexts, as_of, **callbacks):
        calls.append([p["id"] for p in pairs])
        assert len({p[s]["document_id"] for p in pairs for s in ("a", "b")}) <= 2
        assert sum(len(c["passages"]) for c in contexts) >= 12
        return {p["id"]: {"scope": "same", "relation": "incompatible"} for p in pairs}
    patch.setattr(freshness_judgments, "compare_many", compare)
    service.start()
    early = None
    for _ in range(300):
        if not service.process_one():
            break
        page = service.get()
        if page["findings"] and early is None:
            early = page["scan"]
    else:
        pytest.fail("Scan did not terminate")
    page = service.get()
    assert early["passages_classified"] < early["passages_read"]
    assert 16 < max(map(len, calls)) <= freshness_judgments.MAX_BATCH_PAIRS
    compared = [identity for batch in calls for identity in batch]
    assert len(compared) == len(set(compared)) == page["scan"]["pairs_total"]
    assert page["scan"]["pairs_checked"] == page["scan"]["pairs_total"]
    assert len(calls) < len(compared)
    prior_calls = len(calls)
    service.start()
    finish(service, limit=300)
    assert len(calls) == prior_calls


def test_batched_questions_keep_pair_orientation_and_split_without_truncating(monkeypatch):
    from types import SimpleNamespace
    from symbiknow.ai import jev
    contexts = [{"document_id": "d", "filename": "d.txt", "passages": [
        {"id": "a", "document_id": "d", "text": "Original claim."}, {"id": "b", "document_id": "d", "text": "Replacement."},
        {"id": "late", "document_id": "d", "text": "This qualification must stay in every call."},
    ]}]
    a, b = contexts[0]["passages"][:2]
    pairs = [{"id": "first", "a": a, "b": b}, {"id": "reverse", "a": b, "b": a}]
    calls = []
    def provider(state, questions):
        calls.append(state)
        assert state["documents"][0]["passages"][-1]["text"] == contexts[0]["passages"][-1]["text"]
        if len(questions) > 6:
            raise jev.ContextBudgetError("Test tokenizer limit")
        relation = "a_replaced" if state["comparisons"]["p0"]["a"]["source_path"] == "documents[0].passages[0].text" else "b_replaced"
        labels = {key: "same" if key.startswith(("subject_", "setting_")) else
                  "applicable" if key.startswith("period_") else relation for key in questions}
        return SimpleNamespace(nouls={"period_0": SimpleNamespace(noul=0.01), "effective_change_0": SimpleNamespace(noul=0.99), "specificity_0": SimpleNamespace(noul=0.99)}, choices={
            key: SimpleNamespace(choice=labels[key], confidence=0.9,
                                 probabilities={v: float(v == labels[key]) for v in q.criteria})
            for key, q in questions.items() if q.type == "choice"})
    monkeypatch.setattr(jev, "_call", provider)
    answers = freshness_judgments.compare_many(pairs, contexts, "2026-10-20")
    assert len(calls) == 3
    assert answers["first"]["relation"] == "a_replaced"
    assert answers["reverse"]["relation"] == "b_replaced"
    calls.clear()
    completed = []
    with pytest.raises(InterruptedError):
        freshness_judgments.compare_many(
            pairs, contexts, "2026-10-20", on_batch=completed.append,
            should_continue=lambda: not completed)
    assert len(completed) == 1
    assert len(calls) == 2  # Oversized request, then one success; no next call.


def test_uncertain_decision_is_reported_as_coverage_without_a_label(library):
    _, patch, _, service, _, _ = library
    patch.setattr(freshness_judgments, "compare", lambda *args: {
        "scope": "same", "relation": "incompatible", "confidence": 0.3, "uncertain": True})
    service.start()
    page = finish(service)
    assert page["findings"] == []
    assert page["scan"]["status"] == "partial"
    assert page["scan"]["gaps"]["uncertain_comparisons"] == 1
    assert freshness_judgments.label({"scope": "same", "relation": "a_replaced", "confidence": 0.3}) == (None, None)


def test_saved_findings_keep_confidence_and_probabilities_in_wire_contract(library):
    from tests.core.test_wire_contracts import validate
    _, patch, _, service, _, _ = library
    answer = {"choice": "same", "confidence": 0.9, "probabilities": {"same": 0.95, "different": 0.05}}
    patch.setattr(freshness_judgments, "compare", lambda *args: {
        "scope": "same", "relation": "incompatible", "confidence": 0.9,
        "uncertain": False, "judgments": {"subject": answer}})
    service.start()
    finding = finish(service)["findings"][0]
    assert finding["decision"]["judgments"]["subject"] == answer
    validate("FreshnessFinding", finding)


def test_completed_subrequest_cached_when_a_later_subrequest_fails(library):
    from types import SimpleNamespace
    from symbiknow.ai import jev
    _, patch, _, service, a, b = library
    # Restore the actual batching function instead of the fixture's per-pair fake.
    patch.setattr(freshness_judgments, "compare_many", REAL_COMPARE_MANY)
    patch.setattr(freshness_judgments, "MAX_REQUEST_BYTES", 1)
    x = {"id": "x", "document_id": a["document_id"], "text": "Thirty days."}
    y = {"id": "y", "document_id": b["document_id"], "text": "Ninety days."}
    contexts = [{"document_id": d["document_id"], "filename": d["filename"], "passages": [p]}
                for d, p in ((a, x), (b, y))]
    pairs = [{"id": "xy", "a": x, "b": y}, {"id": "yx", "a": y, "b": x}]
    calls = []
    def provider(state, questions):
        calls.append(questions)
        if len(calls) == 2:
            raise TimeoutError("fixture")
        labels = {k: "same" if k.startswith(("subject_", "setting_")) else
                  "applicable" if k.startswith("period_") else "incompatible" for k in questions}
        return SimpleNamespace(nouls={"period_0": SimpleNamespace(noul=0.01), "effective_change_0": SimpleNamespace(noul=0.99), "specificity_0": SimpleNamespace(noul=0.99)}, choices={k: SimpleNamespace(
            choice=labels[k], confidence=0.95, probabilities={v: float(v == labels[k]) for v in q.criteria})
            for k, q in questions.items() if q.type == "choice"})
    patch.setattr(jev, "_call", provider)
    job = service.start()
    with pytest.raises(TimeoutError):
        service._decisions(pairs, contexts, "2026-10-20", job["scan_id"])
    result = service._decisions(pairs, contexts, "2026-10-20", job["scan_id"])
    assert set(result) == {"xy", "yx"} and len(calls) == 3


def screening_fixture():
    contexts = [{"document_id": d, "filename": d + ".txt", "passages": [
        {"id": f"{d}:{i}", "document_id": d, "text": str(i)} for i in range(10)
    ]} for d in ("a", "b")]
    contexts[0]["passages"].append({
        "id": "qualifier", "document_id": "a", "text": "Late effective-date qualification."})
    pairs = [{"id": str(i), "a": contexts[0]["passages"][i], "b": contexts[1]["passages"][i]}
             for i in range(10)]
    return pairs, contexts


def screening_provider(state, questions):
    from types import SimpleNamespace
    assert state["documents"][0]["passages"][-1]["text"] == "Late effective-date qualification."
    choices, nouls = {}, {}
    for key, q in questions.items():
        number = int(state["comparisons"]["p" + key.rsplit("_", 1)[1]]["a"]["text"])
        if q.type == "choice":
            choice = ("different" if number < 8 else "unclear" if number == 8 else "same"
                      ) if key.startswith("subject_") else "same" if key.startswith("setting_") else "incompatible"
            choices[key] = SimpleNamespace(
                choice=choice, confidence=0.89 if number == 7 else 0.95,
                probabilities={value: float(value == choice) for value in q.criteria})
        else:
            nouls[key] = SimpleNamespace(noul=0.01 if key.startswith("period_") else 0.99)
    return SimpleNamespace(choices=choices, nouls=nouls)


def test_subject_screen_keeps_uncertain_pairs_and_all_context(monkeypatch):
    from symbiknow.ai import jev
    from symbiknow.search.metrics import CURRENT
    pairs, contexts = screening_fixture()
    calls, checkpoints, metrics = [], [], {}
    def provider(state, questions):
        calls.append((state, questions))
        return screening_provider(state, questions)
    monkeypatch.setattr(jev, "_call", provider)
    token = CURRENT.set(metrics)
    try:
        answers = freshness_judgments.compare_many(pairs, contexts, "2026-10-20", on_batch=checkpoints.append)
    finally:
        CURRENT.reset(token)
    assert [len(q) for _, q in calls] == [10, 18]
    assert {p["a"]["text"] for p in calls[1][0]["comparisons"].values()} == {"7", "8", "9"}
    assert set(answers) == {str(i) for i in range(10)}
    assert len(checkpoints) == 2 and len(checkpoints[0]) == 7
    assert answers["0"]["used_judgments"] == ["subject"]
    assert answers["0"]["relation"] == "unknown" and freshness_judgments.label(answers["0"]) == (None, None)
    assert freshness_judgments.label(answers["9"])[0] == "conflicting"
    assert metrics == {"freshness_questions": 28, "freshness_screened_pairs": 10,
                       "freshness_screened_out_pairs": 7, "freshness_detailed_pairs": 3}


def test_subject_screen_cancellation_stops_detailed_requests(monkeypatch):
    from symbiknow.ai import jev
    pairs, contexts = screening_fixture()
    calls, completed = [], []
    def provider(state, questions):
        calls.append(questions)
        return screening_provider(state, questions)
    monkeypatch.setattr(jev, "_call", provider)
    with pytest.raises(InterruptedError):
        freshness_judgments.compare_many(
            pairs, contexts, "2026-10-20", on_batch=completed.append,
            should_continue=lambda: not completed)
    assert len(calls) == 1 and len(completed[0]) == 7


def test_subject_screen_checkpoints_survive_detailed_request_failure(library):
    from symbiknow.ai import jev
    _, patch, _, service, _, _ = library
    pairs, contexts = screening_fixture()
    calls = []
    def provider(state, questions):
        calls.append(questions)
        if len(calls) == 2:
            raise TimeoutError("fixture")
        return screening_provider(state, questions)
    patch.setattr(jev, "_call", provider)
    patch.setattr(freshness_judgments, "compare_many", REAL_COMPARE_MANY)
    scan = service.start()["scan_id"]
    with pytest.raises(TimeoutError):
        service._decisions(pairs, contexts, "2026-10-20", scan)
    answers = service._decisions(pairs, contexts, "2026-10-20", scan)
    assert set(answers) == {p["id"] for p in pairs}
    assert [len(q) for q in calls] == [10, 18, 18]
    service._decisions(pairs, contexts, "2026-10-20", scan)
    assert len(calls) == 3  # Both completed stages are reused.


@pytest.mark.parametrize("outcome", ["success", "cancel", "failure"])
def test_two_context_groups_share_bounded_work_and_keep_publication_safe(library, outcome):
    from symbiknow.search.metrics import add
    root, patch, _, service, _, _ = library
    indexed(root, name="third-policy.txt", content=b"Atlas current production retention is 60 days.\n")
    job = service.start()
    for _ in range(20):
        if service.get()["scan"]["pairs_total"] >= 2:
            break
        service.process_one()
    else:
        pytest.fail("Expected two independent document groups")
    entered, release = threading.Barrier(3), threading.Event()
    groups, lock = [], threading.Lock()
    def compare(pairs, contexts, as_of, **callbacks):
        with lock:
            ordinal = len(groups)
            groups.append(tuple(d["document_id"] for d in contexts))
        add("parallel_test_calls", 1)
        entered.wait(10)
        assert release.wait(10)
        if outcome == "failure" and ordinal == 0:
            raise TimeoutError("fixture")
        return {p["id"]: {"scope": "same", "relation": "incompatible"} for p in pairs}
    patch.setattr(freshness_judgments, "compare_many", compare)
    thread = threading.Thread(target=service.process_one)
    thread.start()
    try:
        entered.wait(10)  # Both hosted groups entered before either can finish.
        if outcome == "cancel":
            service.cancel(job["scan_id"])
    finally:
        release.set()
        thread.join(15)
    assert not thread.is_alive()
    page = service.get()
    assert len(groups) == len(set(groups)) == 2
    assert page["scan"]["usage"]["parallel_test_calls"] == 2
    if outcome == "cancel":
        assert page["scan"]["status"] == "cancelled" and not page["findings"]
    else:
        assert len(page["findings"]) == (1 if outcome == "failure" else 2)
        assert page["scan"]["pairs_checked"] == len(page["findings"])
        if outcome == "failure":
            assert page["scan"]["status"] == "failed"


@pytest.mark.parametrize("scope,relation,expected", [
    ("unclear", "incompatible", None), ("different", "incompatible", None),
    ("same", "unknown", None),
    ("historical_or_hypothetical", "a_retired", None), ("same", "compatible", None),
    ("same", "a_replaced", "possibly_replaced"), ("same", "b_retired", "possibly_deprecated"),
])
def test_policy_requires_scope_before_a_warning(scope, relation, expected):
    assert freshness_judgments.label({"scope": scope, "relation": relation})[0] == expected


def test_http_job_review_and_pagination(library):
    _, _, client, service, a, _ = library
    response = mutate(client, "freshness", {"request_id": "ui"})
    assert response.status_code == 200, response.text
    finish(service)
    page = client.get("/api/freshness", params={"document_id": a["document_id"]}).json()
    assert page["scan"]["scan_id"] == response.json()["scan_id"]
    f = page["findings"][0]
    reviewed = mutate(client, "freshness-review", {
        "scan_id": f["scan_id"], "finding_id": f["finding_id"], "expected_revision": 1, "decision": "historical",
    })
    assert reviewed.status_code == 200, reviewed.text
    assert client.get("/api/freshness").json()["findings"][0]["review"] == "historical"
    assert mutate(client, "freshness", {"request_id": "ui"}).json()["scan_id"] == response.json()["scan_id"]
    assert client.get("/api/freshness?category=unknown").status_code == 400
    assert client.get("/api/freshness?limit=101").status_code == 400


def test_paginated_results_filters_and_revision_guard(library):
    _, _, _, service, a, b = library
    service.start()
    f = finish(service)["findings"][0]
    with service.store.connection() as db:
        for i in range(5):
            item = {**f, "finding_id": f"z{i}"}
            db.execute("INSERT INTO findings VALUES(?,?,?,?,?,?,?,?)",
                       (f["scan_id"], item["finding_id"], a["document_id"], b["document_id"],
                        "conflicting", "pending", 1, encode(item)))
    first = service.get(limit=2, category="conflicting")
    second = service.get(after=first["next_after"], limit=2, category="conflicting")
    assert first["has_more"] and second["has_more"]
    assert not ({r["finding_id"] for r in first["findings"]} & {r["finding_id"] for r in second["findings"]})
