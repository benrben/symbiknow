"""Numeric verification uses real SDK parsing plus local evidence and routing guards."""

import copy
import json
from types import SimpleNamespace

import httpx2
import pytest
from typesafe_sdk import RetryPolicy, TypeSafeClient

from app import jev, jev_numeric as numeric
from test_jev import match


def sdk(verdicts=None, confidence=0.95, requests=None):
    def respond(request):
        body = json.loads(request.content)
        if requests is not None:
            requests.append(body)
        answers = {}
        for key, question in body["questions"].items():
            assert question["type"] == "choice"
            choice = (verdicts or {}).get(key, "verified")
            answers[key] = dict(
                type="choice",
                choice=choice,
                confidence=confidence,
                probabilities={k: float(k == choice) for k in question["criteria"]},
            )
        return httpx2.Response(200, json=dict(model="jev-test", usage={}, answers=answers))

    return TypeSafeClient(
        api_key="fixture-not-a-credential",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    )


def documents():
    return [
        match("fact", text="Red Cypress backup retention is 9 days."),
        match("alias", text="RC is the same company and backup service as Red Cypress."),
    ]


def evaluate(docs=None, query="How many hours does RC retain backups?", **kwargs):
    with sdk(**kwargs) as client:
        r = jev.judge_matches(query, documents() if docs is None else docs, client=client)
    return r, jev.answer_results(r["matches"], r)


def test_one_call_combines_original_evidence_and_returns_exact_conversion():
    requests = []
    r, (matches, answer) = evaluate(requests=requests)
    assert len(requests) == 1
    state = requests[0]["state"]
    assert len(state["original_documents"]) == 2
    assert "RC is the same company" in state["original_documents"][1]["paragraphs"][0]
    assert set(requests[0]["questions"]) == {"v0"}
    assert answer["status"] == "answered"
    assert [m["document_id"] for m in matches] == ["fact"]
    value = answer["values"][0]
    assert (value["value"], value["unit"], value["display"]) == ("216", "hour", "216 hours")
    assert value["calculation"]["factor_numerator"] == 24
    assert value["source"]["quote"] == "9 days"
    assert (
        documents()[0]["evidence"][0]["text"][value["source"]["start"] : value["source"]["end"]]
        == "9 days"
    )
    assert {s["document_id"] for s in value["context_sources"]} == {"fact", "alias"}
    assert len(matches[0]["jev"]["verification_dependencies"]) == 2
    assert set(r["cross_document_assessment"]["compared_chunk_ids"]) == {"fact:v1:0", "alias:v1:0"}


@pytest.mark.parametrize("verdict", ["unsupported", "contradicted"])
def test_unsupported_or_contradicted_never_becomes_an_answer(verdict):
    r, (matches, answer) = evaluate(verdicts={"v0": verdict})
    assert not matches and "values" not in answer
    assert answer["status"] == "no_answer_in_evaluated_candidates"


def test_low_confidence_is_needs_context_not_no_answer():
    _, (matches, answer) = evaluate(confidence=0.59)
    assert not matches and answer["status"] == "needs_context"


def test_distinct_verified_values_cannot_be_published_as_one_answer():
    docs = [match(text="RC backup retention is 2 days. Another current policy says 3 days.")]
    _, (matches, answer) = evaluate(docs)
    assert not matches and answer["status"] == "needs_context"


def test_equivalent_units_are_deduplicated_in_code():
    docs = [match(text="RC backup retention is 2 days, also stated as 48 hours.")]
    _, (_, answer) = evaluate(docs)
    assert answer["values"][0]["display"] == "48 hours"


@pytest.mark.parametrize("text", ["2 months", "5 business days", "1 second"])
def test_ambiguous_or_nonterminating_conversion_is_not_invented(text):
    _, (matches, answer) = evaluate([match(text="RC backup retention is " + text + ".")])
    assert not matches and answer["status"] == "needs_context"


@pytest.mark.parametrize(
    "field,value",
    [("quote", "10 days"), ("number", "10"), ("unit", "hour"), ("start", 1), ("end", 4)],
)
def test_source_span_tampering_fails(field, value):
    _, docs, spans = numeric.prepare("How many hours does RC retain backups?", documents())
    span = spans[0] | {field: value}
    with pytest.raises(ValueError, match="evidence changed"):
        numeric.derive(docs[0]["paragraphs"][0], span, "hour")


@pytest.mark.parametrize("phrase", ["1,500 days", "-3 days", "2–4 days", "1/2 days", "1.2.3 days"])
def test_unsupported_number_format_cannot_be_read_as_a_smaller_value(phrase):
    assert numeric.prepare("How many hours does RC retain backups?", [match(text=phrase)]) is None


@pytest.mark.parametrize(
    "query",
    [
        "Who is the CEO?",
        "Does RC retain backups?",
        "How many hours does RC retain backups and how much does it cost?",
        "What are backup retention and the CEO phone number?",
        "כמה שעות נשמר גיבוי וגם מה המחיר?",
    ],
)
def test_general_and_compound_questions_keep_the_general_evaluator(query):
    assert numeric.intent(query) is None


def test_hebrew_decimal_and_ocr_are_supported_but_native_images_are_not():
    d = match(text="שירות RC שומר גיבויים למשך 1.5 ימים.", basis="ocr")
    _, (matches, answer) = evaluate([d], query="כמה שעות RC שומר גיבויים?")
    assert answer["values"][0]["display"] == "36 שעות"
    assert matches[0]["jev"]["basis"] == ["ocr"]
    assert (
        numeric.prepare(
            "How many hours does RC retain backups?", [match(text="9 days", basis="image")]
        )
        is None
    )


def test_budget_overflow_never_silently_discards_counterevidence(monkeypatch):
    monkeypatch.setattr(numeric, "MAX_CANDIDATES", 1)
    assert (
        numeric.prepare("How many hours does RC retain backups?", [match(text="2 days. 3 days.")])
        is None
    )
    monkeypatch.setattr(numeric, "MAX_CONTEXT", 10)
    assert numeric.prepare("How many hours does RC retain backups?", documents()) is None


def test_cache_depends_on_all_context_and_isolates_callers(monkeypatch):
    monkeypatch.setattr(numeric, "_CACHE", numeric.ByteLRU(max_bytes=2 * 1024**2))
    calls = []

    def call(state, questions, client=None):
        calls.append(state)
        with sdk() as c:
            return c.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", call)
    q = "How many hours does RC retain backups?"
    first = jev.judge_matches(q, documents(), cache_namespace="library")
    first["matches"][0]["jev"]["verified_answer"]["value"] = "BAD"
    second = jev.judge_matches(q, documents(), cache_namespace="library")
    assert second["matches"][0]["jev"]["verified_answer"]["value"] == "216"
    assert len(calls) == 1 and second["cached"] == 2
    changed = documents()
    changed[1]["evidence"][0]["text"] = "RC is only a customer of Red Cypress."
    jev.judge_matches(q, changed, cache_namespace="library")
    jev.judge_matches(q, documents(), cache_namespace="different-library")
    monkeypatch.setenv("TYPESAFE_DEFAULT_MODEL", "different-model")
    jev.judge_matches(q, documents(), cache_namespace="library")
    assert len(calls) == 4
    assert numeric._CACHE.bytes <= 2 * 1024**2


def test_provider_errors_are_sanitized_not_cached_or_promoted(monkeypatch):
    monkeypatch.setattr(numeric, "_CACHE", numeric.ByteLRU())
    calls = []

    def call(*args, **kwargs):
        calls.append(1)
        raise TimeoutError("secret-source-text-and-key")

    monkeypatch.setattr(jev, "_call", call)
    for _ in range(2):
        r = jev.judge_matches(
            "How many hours does RC retain backups?", documents(), cache_namespace="library"
        )
        matches, answer = jev.answer_results(r["matches"], r)
        assert not matches and answer["status"] == "unavailable"
        assert "secret-source-text" not in json.dumps(r)
    assert len(calls) == 2 and not numeric._CACHE


@pytest.mark.parametrize(
    "choice,confidence", [("invented", 0.99), ("verified", float("nan")), ("verified", 1.1)]
)
def test_invalid_provider_decisions_fail_closed(monkeypatch, choice, confidence):
    monkeypatch.setattr(
        jev,
        "_call",
        lambda *a, **kw: SimpleNamespace(
            choices={"v0": SimpleNamespace(choice=choice, confidence=confidence)},
            model="test",
            usage=None,
        ),
    )
    r = jev.judge_matches("How many hours does RC retain backups?", documents())
    assert r["status"] == "unavailable"


@pytest.mark.parametrize(
    "mode,mutation",
    [
        ("keyword", "none"),
        ("semantic", "none"),
        ("hybrid", "none"),
        ("answer", "none"),
        ("keyword", "head"),
        ("keyword", "passage"),
        ("keyword", "scope"),
        ("keyword", "delete"),
        ("keyword", "during_verification"),
    ],
)
def test_publication_and_refresh_require_context_document(tmp_path, monkeypatch, mode, mutation):
    from app import search, server, storage

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    docs = []
    stored = []
    for i, text in enumerate(
        ["Red Cypress backup retention is 9 days.", "RC is the same backup service as Red Cypress."]
    ):
        d = storage.save_file(tmp_path, text.encode(), f"{i}.txt")
        ref = f"{d['document_id']}:v1:t0"
        search.put_chunks(
            tmp_path,
            d,
            [
                dict(
                    chunk_id=ref,
                    text=text,
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "numeric-test",
        )
        search.set_document_status(
            tmp_path, d, status="indexed", indexed_version="v1", chunk_count=1
        )
        search.save_organization(
            tmp_path, d["document_id"], "v1", dict(status="evaluated", folder="Project", groups=[])
        )
        docs.append(
            dict(
                document_id=d["document_id"],
                version="v1",
                filename=f"{i}.txt",
                evidence=[dict(evidence_id=ref, text=text, basis="text", provenance={})],
            )
        )
        stored.append(d)
    original_judge = jev.judge_matches

    def judge(q, matches, **kwargs):
        with sdk() as c:
            result = original_judge(q, matches, client=c)
        if mutation == "during_verification":
            storage.save_file(
                tmp_path, b"changed alias", "1.txt", document_id=stored[1]["document_id"]
            )
        return result

    monkeypatch.setattr(jev, "judge_matches", judge)
    monkeypatch.setattr(search, "find_documents", lambda *a, **kw: copy.deepcopy(docs))
    result = server.search(
        "How many hours does RC retain backups?",
        mode=mode,
        folder="Project",
        evaluate=mode != "answer",
        detail="full",
    )
    if mutation == "during_verification":
        assert result["answer"]["status"] == "unavailable"
        assert not result["matches"] and "values" not in result["answer"]
        return
    assert result["answer"]["values"][0]["value"] == "216"
    assert len(result["matches"]) == 1
    from app.search_projection import project_search

    compact = project_search(result)
    assert compact["answer"]["values"] == result["answer"]["values"]
    assert compact["answer"]["values"][0]["source"]["chunk_id"] in {
        e["evidence_id"] for m in compact["matches"] for e in m["evidence"]
    }
    bridge = stored[1]
    if mutation == "head":
        storage.save_file(tmp_path, b"changed alias", "1.txt", document_id=bridge["document_id"])
    elif mutation == "passage":
        search.put_chunks(
            tmp_path,
            bridge,
            [
                dict(
                    chunk_id=f"{bridge['document_id']}:v1:t0",
                    text="Unrelated companies.",
                    basis="text",
                    vector=[1.0, 0.0, 0.1],
                    provenance_json="{}",
                )
            ],
            "numeric-test",
        )
    elif mutation == "scope":
        search.save_organization(
            tmp_path,
            bridge["document_id"],
            "v1",
            dict(status="evaluated", folder="Other", groups=[]),
        )
    elif mutation == "delete":
        storage.delete_document(tmp_path, bridge["document_id"], "v1")
    refreshed, _ = server._refresh_matches(copy.deepcopy(result["matches"]), "Project", None)
    if mutation == "none":
        assert refreshed == result["matches"]
    else:
        assert refreshed[0]["jev"]["status"] == "not_evaluated"
        assert refreshed[0]["jev"]["reason"] == "evidence_changed"
