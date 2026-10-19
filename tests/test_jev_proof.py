"""Production joint-proof contracts, using real SDK parsing and storage publication."""

import copy
import json

import httpx2
import pytest
from typesafe_sdk import TypeSafeClient, RetryPolicy

from app import jev, jev_proof


def document(identity="d0", texts=("The keeper is Noa.",)):
    return dict(
        document_id=identity,
        version="v1",
        filename="Record.txt",
        evidence=[
            dict(evidence_id=f"{identity}:v1:t{i}", text=t, basis="text", provenance={})
            for i, t in enumerate(texts)
        ],
    )


def sdk(choices=None, probabilities=None, confidence=0.99, requests=None):
    choices, probabilities = choices or {}, probabilities or {}

    def respond(request):
        body = json.loads(request.content)
        if requests is not None:
            requests.append(body)
        answers = {}
        for key, q in body["questions"].items():
            if q["type"] == "choice":
                choice = choices.get(key, next(iter(q["criteria"])))
                answers[key] = dict(
                    type="choice",
                    choice=choice,
                    confidence=confidence,
                    probabilities={v: float(v == choice) for v in q["criteria"]},
                )
            else:
                answers[key] = dict(type="noul", noul=probabilities.get(key, 0.99))
        return httpx2.Response(200, json=dict(model="jev-1.14.0", usage={}, answers=answers))

    return TypeSafeClient(
        api_key="fixture",
        model="jev-1.14.0",
        transport=httpx2.MockTransport(respond),
        retry=RetryPolicy(max_retries=0),
    )


def test_joint_rule_and_condition_publish_together_with_all_dependencies():
    docs = [
        document(texts=("Guests can export iff enabled.",)),
        document("d1", ("Enabled is false.",)),
    ]
    with sdk({"proof_0_0": "rule", "proof_1_0": "answer"}) as client:
        result = jev.judge_matches("Can guests export?", docs, client=client)
    accepted, answer = jev.answer_results(result["matches"], result)
    assert answer["status"] == "answered" and len(accepted) == 2
    for m in accepted:
        assert len(m["jev"]["verification_dependencies"]) == 2
        assert m["jev"]["supporting_chunk_ids"] == [m["evidence"][0]["evidence_id"]]


def test_second_check_retains_disclaimer_and_binds_actual_passage_text():
    requests = []
    doc = document(texts=("This entire document is fictional.", "The keeper is Noa."))
    with sdk(
        {"coverage": "missing", "proof_0_0": "bridge", "proof_0_1": "unused"},
        confidence=0.7,
        requests=requests,
    ) as client:
        result = jev.judge_matches("Who is the real keeper?", [doc], client=client)
    accepted, answer = jev.answer_results(result["matches"], result)
    assert not accepted and answer["status"] == "no_answer_in_evaluated_candidates"
    assert len(requests) == 2
    assert requests[0]["state"]["documents"] == requests[1]["state"]["documents"]
    assert (
        requests[1]["questions"]["cite_0_1"]["instructions"]["target_original_passage"]["text"]
        == doc["evidence"][1]["text"]
    )


@pytest.mark.parametrize("confidence", [0.7, 0.99])
@pytest.mark.parametrize("label", ["missing", "conflicting"])
def test_explicit_refusal_is_not_overridden_by_citation_roles(label, confidence):
    with sdk({"coverage": label}, confidence=confidence) as client:
        result = jev.judge_matches("Who is the keeper?", [document()], client=client)
    accepted, answer = jev.answer_results(result["matches"], result)
    assert not accepted
    assert answer["status"] == (
        "needs_context" if label == "conflicting" else "no_answer_in_evaluated_candidates"
    )
    assert answer["needs_context_count"] == int(label == "conflicting")


@pytest.mark.parametrize("coverage", ["complete", "partial", "correction", "missing", "conflicting"])
def test_uncertain_verification_never_publishes_a_preliminary_answer(coverage):
    requests = []
    with sdk({"coverage": coverage}, confidence=0.4, requests=requests) as client:
        result = jev.judge_matches("Who is the keeper?", [document()], client=client)
    accepted, answer = jev.answer_results(result["matches"], result)
    assert len(requests) == 2
    assert not accepted
    assert answer["status"] == "needs_context"
    assert answer["needs_context_count"] == 1
    judgment = result["matches"][0]["jev"]
    assert judgment["coverage"] == "unknown"
    assert not judgment["supporting_chunk_ids"] and not judgment["conflicting_chunk_ids"]


def test_proof_provider_retains_bounded_filename_context_in_both_checks():
    docs = [document(), document("d1")]
    docs[0]["filename"] = "Apollo-owner.txt"
    docs[1]["filename"] = "Other-project-" + "x" * 300 + ".txt"
    requests = []
    with sdk(confidence=0.7, requests=requests) as client:
        jev.judge_matches("Who is the keeper for Apollo?", docs, client=client)
    assert len(requests) == 2
    for request in requests:
        assert [d["filename"] for d in request["state"]["documents"]] == [
            d["filename"][:240] for d in docs
        ]


def test_partial_and_premise_correction_keep_public_status():
    for coverage, status in [("partial", "partial"), ("correction", "corrected_premise")]:
        with sdk({"coverage": coverage}) as client:
            result = jev.judge_matches("Question", [document()], client=client)
        assert jev.answer_results(result["matches"], result)[1]["status"] == status


@pytest.mark.parametrize("mutation", ["duplicate", "wrong_version", "too_many", "too_large"])
def test_invalid_or_over_budget_evidence_never_reaches_provider(monkeypatch, mutation):
    d = document()
    if mutation == "duplicate":
        d["evidence"] *= 2
    elif mutation == "wrong_version":
        d["evidence"][0]["evidence_id"] = "d0:v0:t0"
    elif mutation == "too_many":
        d = document(texts=tuple("claim" for _ in range(13)))
    else:
        d = document(texts=tuple("x" * 2400 for _ in range(8)))

    def forbidden(*a, **kw):
        pytest.fail("Provider called for invalid context")

    monkeypatch.setattr(jev, "_call", forbidden)
    result = jev.judge_matches("Who is the keeper?", [d])
    assert result["status"] in {"not_evaluated", "unavailable"}
    assert not jev.answer_results(result["matches"], result)[0]


def test_cache_covers_uncited_context_versions_and_cannot_be_mutated(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU(max_entries=4, max_bytes=150000))
    calls = []

    def call(state, questions, client=None):
        calls.append(state)
        with sdk({"proof_1_0": "bridge"}) as c:
            return c.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", call)
    docs = [document(), document("bridge", ("This record identifies the requested office.",))]
    first = jev.judge_matches("Who is keeper?", docs, cache_namespace="one")
    first["matches"][0]["jev"]["supporting_chunk_ids"].clear()
    second = jev.judge_matches("Who is keeper?", docs, cache_namespace="one")
    assert second["matches"][0]["jev"]["supporting_chunk_ids"] and len(calls) == 1
    docs[1]["evidence"][0]["text"] = "The identity was retracted."
    jev.judge_matches("Who is keeper?", docs, cache_namespace="one")
    jev.judge_matches("Who is keeper?", docs, cache_namespace="two")
    monkeypatch.setenv("TYPESAFE_DEFAULT_MODEL", "different-model")
    jev.judge_matches("Who is keeper?", docs, cache_namespace="two")
    docs[1]["filename"] = "Different-office.txt"
    jev.judge_matches("Who is keeper?", docs, cache_namespace="two")
    assert len(calls) == 5 and jev_proof._CACHE.bytes <= 150000


def test_failed_second_check_is_unavailable_and_not_cached(monkeypatch):
    monkeypatch.setattr(jev_proof, "_CACHE", jev_proof.ByteLRU())
    calls = []

    def call(state, questions, client=None):
        calls.append(state)
        if len(calls) % 2 == 0:
            raise TimeoutError("secret source and key")
        with sdk(confidence=0.7) as c:
            return c.system_one(state=state, questions=questions)

    monkeypatch.setattr(jev, "_call", call)
    for _ in range(2):
        result = jev.judge_matches("Who is keeper?", [document()], cache_namespace="test")
        assert result["status"] == "unavailable" and "secret source" not in json.dumps(result)
        assert not jev.answer_results(result["matches"], result)[0]
    assert len(calls) == 4 and not jev_proof._CACHE


def test_large_link_context_retained_with_bounded_claim_pairs():
    source = document(texts=tuple(f"Original operational claim {i}." for i in range(12)))
    neighbors = [
        document(f"n{i}", tuple(f"Neighbor operational claim {j}." for j in range(12)))
        for i in range(5)
    ]
    requests = []
    with sdk(requests=requests) as client:
        result = jev.organize_document(
            source, source["evidence"], neighbors, links_only=True, client=client
        )
    assert result["status"] == "evaluated"
    assert len(requests) == 1
    assert all(len(d["evidence"]) == 12 for d in requests[0]["state"]["documents"])
    assert sum(k.startswith("pair_") for k in requests[0]["questions"]) <= 45


@pytest.mark.parametrize("passages", [12, 128])
def test_long_file_links_sample_original_windows_and_keep_ending_disclaimer(passages):
    texts = tuple(
        f"Passage {i}: " + "Original operational statement. " * 38 for i in range(passages - 1)
    )
    texts += ("This entire document is fictional; none of these claims is real.",)
    source = document(texts=texts)
    neighbors = [document(f"n{i}", texts) for i in range(5)]
    for item in [source, *neighbors]:
        item["evidence"].sort(key=lambda e: e["evidence_id"])
    before = copy.deepcopy([source, *neighbors])
    requests = []
    with sdk(requests=requests) as client:
        result = jev.organize_document(
            source, source["evidence"], neighbors, links_only=True, client=client
        )
    assert result["status"] == "evaluated"
    docs = requests[0]["state"]["documents"]
    assert sum(len(e["text"]) for d in docs for e in d["evidence"]) <= 50000
    for d in docs:
        assert len(d["evidence"]) <= 12
        assert d["evidence"][0]["chunk_id"].endswith(":t0")
        assert d["evidence"][-1]["text"] == texts[-1]
    assert all(
        s["sampled"] and s["available_windows"] == passages
        for s in result["link_context_assessment"]
    )
    assert [source, *neighbors] == before


@pytest.mark.parametrize("mutation", ["head", "passage", "scope", "delete"])
def test_general_proof_refresh_rejects_changed_uncited_dependency(tmp_path, monkeypatch, mutation):
    from app import search, server, storage

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    docs, stored = [], []
    for i, text in enumerate(["The keeper is Noa.", "The requested archive is this same office."]):
        meta = storage.save_file(tmp_path, text.encode(), f"{i}.txt")
        ref = f"{meta['document_id']}:v1:t0"
        search.put_chunks(
            tmp_path,
            meta,
            [dict(chunk_id=ref, text=text, basis="text", vector=[1.0, 0.0], provenance_json="{}")],
            "proof-test",
        )
        search.set_document_status(
            tmp_path, meta, status="indexed", indexed_version="v1", chunk_count=1
        )
        search.save_organization(
            tmp_path,
            meta["document_id"],
            "v1",
            dict(status="evaluated", folder="Project", groups=[]),
        )
        docs.append(
            dict(
                document_id=meta["document_id"],
                version="v1",
                filename=f"{i}.txt",
                evidence=[dict(evidence_id=ref, text=text, basis="text", provenance={})],
            )
        )
        stored.append(meta)
    with sdk({"proof_1_0": "bridge"}) as client:
        result = jev.judge_matches("Who is keeper?", docs, client=client)
    accepted, _ = jev.answer_results(result["matches"], result)
    assert len(accepted) == 1
    fresh, _ = server._refresh_matches(copy.deepcopy(accepted), "Project", None)
    assert fresh[0]["jev"]["status"] == "evaluated"
    meta = stored[1]
    if mutation == "head":
        storage.save_file(tmp_path, b"changed identity", "1.txt", document_id=meta["document_id"])
    elif mutation == "passage":
        search.put_chunks(
            tmp_path,
            meta,
            [
                dict(
                    chunk_id=f"{meta['document_id']}:v1:t0",
                    text="Unrelated offices.",
                    basis="text",
                    vector=[1.0, 0.0],
                    provenance_json="{}",
                )
            ],
            "proof-test",
        )
    elif mutation == "scope":
        search.save_organization(
            tmp_path, meta["document_id"], "v1", dict(status="evaluated", folder="Other", groups=[])
        )
    else:
        storage.delete_document(tmp_path, meta["document_id"], "v1")
    refreshed, _ = server._refresh_matches(copy.deepcopy(accepted), "Project", None)
    assert refreshed[0]["jev"] == dict(status="not_evaluated", reason="evidence_changed")
