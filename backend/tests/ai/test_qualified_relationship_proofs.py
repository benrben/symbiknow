"""Exact relationship proofs cannot be replaced by confidence or template overlap."""
from copy import deepcopy
import hashlib

import pytest

from symbiknow.ai import proof
from symbiknow.ai.link_evidence import proof_references, validate_link_proof
from tests.ai.test_jev_proof import document, sdk


def judge(source, target, *, choices=None, probabilities=None):
    requests = []
    values = {"support_1_0_0": .01, "conflict_1_0_0": .01,
              "topic_1_0_0": .99, "context_1_0_0": .99, **(probabilities or {})}
    with sdk({"pair_1_0_0": "supports", **(choices or {})}, values, confidence=.99, requests=requests) as client:
        result = proof.links(source, source["evidence"], [target], client)
    return result, requests


def supplied_claim(state, identity):
    """Resolve the provider's compact claim reference back to exact evidence."""
    from symbiknow.ai.link_evidence import span

    claim = state["claims"][identity]
    doc = state["documents"][claim["document_index"]]
    passage = doc["evidence"][claim["passage_index"]]
    start = claim["text_start"] - passage["text_start"]
    end = claim["text_end"] - passage["text_start"]
    result = span(doc, passage, start, end)
    if claim.get("whole_passage"):
        assert result["text"] == passage["text"]
        assert "selected_text" not in claim
    else:
        assert claim["selected_text"] == result["text"]
    return result


def rule(request, question, name):
    """Shared rules travel once in state; the question must point at its rule."""
    assert f"state.criteria.{name}" in request["questions"][question]["instructions"]
    return request["state"]["criteria"][name]


def test_confident_template_connection_still_faces_independent_verification():
    source = document(texts=("Investor fit. Consider risk tolerance and portfolio concentration.",))
    target = document("other", ("Investor fit. Consider risk tolerance and portfolio concentration.",))
    source["filename"], target["filename"] = "Pharma report.md", "Chipmaker report.md"
    result, requests = judge(source, target, probabilities={"topic_1_0_0": .01, "support_1_0_0": .99})
    assert len(requests) == 2
    assert not result["links"]
    assert not result["link_evaluations"][0]["accepted"]
    assert "generic limitations" in rule(requests[1], "topic_1_0_0", "topic")


def test_memory_caveat_does_not_support_entire_mixed_throughput_claim():
    source = document(texts=("On device A, streaming lowers peak RAM only when weights do not stay resident.",))
    target = document("other", ("On device A, throughput doubles and bandwidth reaches 90 GB/s. Streaming can lower peak RAM.",))
    result, requests = judge(source, target)
    link = result["links"][0]
    assert link["relation"] == "related"
    assert link["proof"]["target"]["text"] == target["evidence"][0]["text"]
    assert "EVERY factual assertion" in rule(requests[1], "support_1_0_0", "support")


def test_narrowed_claim_keeps_surrounding_conditions_as_proof_context():
    source = document(texts=("Measurements use device A. Streaming reduces RAM only when weights do not stay resident.",))
    target = document("other", ("Throughput doubles on device B. On device A, streaming reduces RAM when weights do not stay resident.",))
    result, requests = judge(source, target, choices={"source_claim_1_0_0": "s1", "target_claim_1_0_0": "s1"},
                             probabilities={"support_1_0_0": .99})
    link = result["links"][0]
    assert link["relation"] == "supports"
    value = link["proof"]
    assert value["target"]["text"] == "On device A, streaming reduces RAM when weights do not stay resident."
    assert "Throughput" not in value["target"]["text"]
    assert value["target_context"]["text"] == target["evidence"][0]["text"]
    assert value["source_context"]["text"].startswith("Measurements use device A.")
    state = requests[1]["state"]
    assert supplied_claim(state, state["selected_claims"]["1_0_0"]["target"]) == value["target"]
    assert value["context"][0]["sha256"] == hashlib.sha256(source["evidence"][0]["text"].encode()).hexdigest()


def test_actual_counterexample_can_contradict_universal_in_overlapping_scope():
    source = document(texts=("On Atlas, transaction 42 took twenty milliseconds on June 1.",))
    target = document("other", ("Every Atlas transaction completes within ten milliseconds.",))
    result, requests = judge(source, target, probabilities={"conflict_1_0_0": .99})
    link = result["links"][0]
    assert link["relation"] == "contradicts"
    assert link["proof"]["criterion"] == "incompatible_claims"
    assert "overlapping applicable situation and relevant time" in rule(requests[1], "conflict_1_0_0", "conflict")
    result, _ = judge(source, target, probabilities={"conflict_1_0_0": .99, "context_1_0_0": .01})
    assert not result["links"]


def test_verification_shares_exact_claims_across_pairs_without_dropping_context():
    source = document(texts=("Atlas retains backups for nine days.", "This applies only to the approved pilot."))
    target = document("other", ("Atlas retains backups for nine days.", "The pilot is approved."))
    _, requests = judge(source, target)
    state = requests[1]["state"]
    assert len(state["selected_claims"]) == 4
    assert len(state["claims"]) == 4  # Eight endpoints, four unique original spans.
    assert state["documents"] == requests[0]["state"]["documents"]
    for key, refs in state["selected_claims"].items():
        _, si, ti = map(int, key.split("_"))
        for side, doc, index in (("source", source, si), ("target", target, ti)):
            question = requests[0]["questions"][f"{side}_claim_{key}"]
            assert f"FROM documents[0].evidence[{si}] TO documents[1].evidence[{ti}]" in question["instructions"]
            claim = supplied_claim(state, refs[side])
            original = doc["evidence"][index]
            assert claim["document_id"] == doc["document_id"]
            assert claim["version"] == doc["version"]
            assert claim["chunk_id"] == original["evidence_id"]
            assert claim["text"] == original["text"][claim["text_start"]:claim["text_end"]]
            assert claim["sha256"] == hashlib.sha256(claim["text"].encode()).hexdigest()


@pytest.mark.parametrize("change", ["unknown-context", "unselected-claim", "truncated"])
def test_missing_qualifiers_abstain_even_with_high_support(change):
    source, target = document(), document("other")
    choices, probabilities = {}, {"support_1_0_0": .99}
    if change == "unknown-context":
        probabilities["context_1_0_0"] = .01
    elif change == "unselected-claim":
        choices["target_claim_1_0_0"] = "insufficient"
    else:
        target["evidence"][0]["text"] = "This is a conditional claim. " * 180 + "Only in the rejected proposal."
    result, requests = judge(source, target, choices=choices, probabilities=probabilities)
    assert not result["links"]
    if change == "truncated":
        scope = result["context_assessment"][1]["supplied_ranges"][0]
        assert scope["truncated"] and scope["text_end"] < scope["original_text_length"]
        assert requests[1]["state"]["documents"][1]["evidence"][0]["truncated"]


def test_numeric_order_is_preserved_even_without_sampling():
    rows = [{"evidence_id": f"d:v1:t{n}", "text": f"Passage {n}.", "basis": "text"} for n in [10, 2, 0]]
    selected, scope = proof.organization_windows(rows)
    assert [r["evidence_id"] for r in selected] == ["d:v1:t0", "d:v1:t2", "d:v1:t10"]
    assert not scope["sampled"]
    docs = proof.documents([dict(document_id="d", version="v1", evidence=rows)])
    assert [r["chunk_id"] for r in docs[0]["evidence"]] == ["d:v1:t0", "d:v1:t2", "d:v1:t10"]


def resolved(source, target):
    return {(d["document_id"], d["version"], p["evidence_id"]): {"text": p["text"]}
            for d in (source, target) for p in d["evidence"]}


@pytest.mark.parametrize("field", ["text", "text_start", "sha256", "context"])
def test_publication_rejects_changed_claim_or_context(field):
    source, target = document(), document("other")
    result, _ = judge(source, target)
    link = result["links"][0]
    validate_link_proof(link, source["document_id"], resolved(source, target))
    changed = deepcopy(link)
    if field == "context":
        changed["proof"]["context"] = []
    else:
        changed["proof"]["source"][field] = {"text": "invented", "text_start": 1, "sha256": "0" * 64}[field]
    with pytest.raises(ValueError):
        validate_link_proof(changed, source["document_id"], resolved(source, target))


def test_duplicate_proof_requires_original_identity_and_bound_spans():
    source, target = document(), document("other")
    digest = hashlib.sha256(b"same original bytes").hexdigest()
    source["sha256"] = target["sha256"] = digest
    value = proof.identity_proof(source, source["evidence"], target)
    link = dict(document_id="other", version="v1", source_version="v1", relation="duplicate",
                source_chunk_id="d0:v1:t0", target_chunk_id="other:v1:t0", proof=value)
    validate_link_proof(link, "d0", resolved(source, target), {"d0": source, "other": target})
    with pytest.raises(ValueError, match="original identity"):
        validate_link_proof(link, "d0", resolved(source, target), {"d0": source, "other": dict(target, sha256="0" * 64)})


def test_explicit_reference_cannot_borrow_neighboring_template_anchor():
    source = document(texts=("Generic review limitations. See document other for the actual report.",))
    target = document("other", ("A specific report about device performance.",))
    reference = "document other"
    text = source["evidence"][0]["text"]
    target.update(candidate_source="explicit_reference", references=[{
        "source_evidence_id": "d0:v1:t0", "start": text.index(reference),
        "end": text.index(reference) + len(reference), "reference_text": reference,
    }])
    result, _ = judge(source, target, choices={"source_claim_1_0_0": "s0"})
    assert not result["links"]
    result, _ = judge(source, target, choices={"source_claim_1_0_0": "s1"})
    assert result["links"][0]["relation"] == "related"


@pytest.mark.parametrize("case", ["resolved", "semantic", "missing-context", "truncated-target"])
def test_truncated_reference_never_promotes_support_or_bypasses_missing_context(case):
    text = "See document other for the actual report. " + "Other collection context. " * 200
    source = document(texts=(text,))
    target = document("other", ("A complete report about device performance.",))
    reference = "document other"
    if case != "semantic":
        target.update(candidate_source="explicit_reference", references=[{
            "source_evidence_id": "d0:v1:t0", "start": text.index(reference),
            "end": text.index(reference) + len(reference), "reference_text": reference,
        }])
    if case == "truncated-target":
        target["evidence"][0]["text"] += " Additional target context." * 200
    result, _ = judge(source, target, choices={"source_claim_1_0_0": "s0"}, probabilities={
        "support_1_0_0": .99, "conflict_1_0_0": .01,
        "context_1_0_0": .01 if case == "missing-context" else .99,
    })
    if case == "resolved":
        link = result["links"][0]
        assert link["relation"] == "related"
        assert link["proof"]["checks"]["explicit_reference"] is True
        assert link["proof"]["checks"]["support"] == .99
        assert link["proof"]["context_scope"][0]["supplied_ranges"][0]["truncated"]
    else:
        assert not result["links"]


@pytest.mark.parametrize("bad", [[], "bad", {"context": ["bad"]}, {"context": [{}] * 201}])
def test_malformed_proof_rejected_before_reference_resolution(bad):
    with pytest.raises(ValueError):
        proof_references({"proof": bad})


def test_reviewed_proof_retains_exact_narrow_claim_and_review_provenance():
    source, target = document(), document("other", ("Other claim. The keeper is Noa.",))
    value = proof.make_reviewed_proof(source, target, source["evidence"][0], target["evidence"][0],
                                     relation="supports", actor="user", reason="Audited exact claim",
                                     target_range=(13, len(target["evidence"][0]["text"])))
    assert value["target"]["text"] == "The keeper is Noa."
    assert value["target_context"]["text"].startswith("Other claim.")
    assert value["review"] == {"actor": "user", "reason": "Audited exact claim"}
