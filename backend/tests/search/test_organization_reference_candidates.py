"""Explicit identities bypass semantic ranking; templates never establish entities."""
import copy
import json

import pytest

from symbiknow.library import storage
from symbiknow.search import index


def indexed(root, filename, text, *, passages=None, **kwargs):
    metadata = storage.save_file(root, text.encode(), filename, **kwargs)
    index.register_document(root, metadata)
    index.put_chunks(root, metadata, [{
        "chunk_id": f"{metadata['document_id']}:{metadata['version']}:t{number:04d}",
        "text": passage, "basis": "text", "provenance_json": "{}", "vector": [1., 0., .1],
    } for number, passage in enumerate(passages or [text])], "test-only-fixture")
    index.set_document_status(root, metadata, status="indexed", indexed_version=metadata["version"])
    return metadata


def test_seventeen_explicit_targets_complete_bounded_batches_including_pending_originals(tmp_path, monkeypatch):
    reports = [indexed(tmp_path, f"Report_{number}.txt", f"Company {number} substantive report.") for number in range(15)]
    pending = storage.save_file(tmp_path, b"Waiting for extraction", "Pending.txt")
    index.register_document(tmp_path, pending)
    unregistered = storage.save_file(tmp_path, b"Stored without index registration", "Unregistered.txt")
    targets = [*reports, pending, unregistered]
    manifest = "\n".join(f"`{doc['document_id']}` [Report](./{doc['filename']}), Version = v1." for doc in targets)
    passages = ["Opening context."] * 3 + [manifest]
    source = indexed(tmp_path, "Index.txt", "\n".join(passages), passages=passages)
    evidence = index.document_evidence(tmp_path, source["document_id"], "v1")
    original = copy.deepcopy(evidence)
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: [])
    monkeypatch.setattr(index, "_REFERENCE_BATCH", 4)
    calls = []
    original_metadata = storage.metadata_many

    def bounded(root, identities):
        values = list(identities)
        calls.append(len(values))
        assert len(values) <= 4
        return original_metadata(root, values)

    monkeypatch.setattr(storage, "metadata_many", bounded)
    neighbors = index.organization_neighbors(tmp_path, source, evidence, folders=[])
    assert {row["document_id"] for row in neighbors} == {doc["document_id"] for doc in reports}
    assert all(row["candidate_source"] == "explicit_reference" for row in neighbors)
    by_id = {row["document_id"]: row for row in neighbors.references if row.get("document_id")}
    assert set(by_id) == {doc["document_id"] for doc in targets}
    assert by_id[pending["document_id"]]["status"] == "pending"
    assert by_id[unregistered["document_id"]]["status"] == "pending"
    assert len(calls) >= 5 and evidence == original
    for neighbor in neighbors:
        for reference in neighbor["references"]:
            assert reference["source_evidence_id"].endswith(":t0003")
            assert manifest[reference["start"]:reference["end"]] == reference["reference_text"]


def test_version_qualified_references_do_not_redirect_and_ambiguous_filenames_remain_unresolved(tmp_path, monkeypatch):
    older = indexed(tmp_path, "Versioned.txt", "Old original content.", document_id="versioned-target")
    current = indexed(tmp_path, "Versioned.txt", "New original content.", document_id=older["document_id"], expected_version="v1")
    twins = [indexed(tmp_path, "Ambiguous.txt", f"Different original {number}.") for number in range(2)]
    text = ('[Historical](/api/document?id=versioned-target&version=v1)\n'
            '[Missing old version](symbiknow://document/versioned-target?version=v99)\n'
            '[Current](symbiknow://document/versioned-target?version=v2)\n'
            '[Ambiguous](Ambiguous.txt)\n'
            'document_id="missing-target", version=v1')
    source = indexed(tmp_path, "Links.txt", text)
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: [])
    result = index.organization_neighbors(tmp_path, source, index.document_evidence(tmp_path, source["document_id"], "v1"), folders=[])
    assert [(row["document_id"], row["version"]) for row in result] == [(current["document_id"], "v2")]
    by_pin = {row["requested_version"]: row for row in result.references if row.get("document_id") == current["document_id"]}
    assert by_pin["v1"]["status"] == "historical"
    assert by_pin["v99"]["status"] == "missing_version"
    assert by_pin["v2"]["status"] == "resolved"
    ambiguous = next(row for row in result.references if row["status"] == "ambiguous")
    assert set(ambiguous["candidate_document_ids"]) == {row["document_id"] for row in twins}
    assert next(row for row in result.references if row.get("document_id") == "missing-target")["status"] == "missing"


def test_template_investor_fit_does_not_connect_different_businesses_and_keeps_original_evidence(tmp_path, monkeypatch):
    template = ("Investor-fit comparison\nMoat, Fit = Strong. Quality, Fit = Strong. "
                "Attractive conditions = Recurring cash generation covers maintenance, financing and reasonable reinvestment. "
                "Confidence = Medium. Small selected coverage universe prevents broad statistical claims.")
    source = indexed(tmp_path, "Lilly.txt", "Stock research — Eli Lilly (NYSE:LLY)\nClinical diabetes medicines and pharmaceutical manufacturing.\n" + template)
    related = indexed(tmp_path, "Lilly-manufacturing.txt", "Eli Lilly (NYSE:LLY)\nClinical diabetes medicines require pharmaceutical manufacturing capacity.\n" + template)
    unrelated = indexed(tmp_path, "Nvidia.txt", "Stock research — NVIDIA (NASDAQ:NVDA)\nAccelerator chips, networking and software ecosystem.\n" + template)
    peers = [{**doc, "evidence": index.document_evidence(tmp_path, doc["document_id"], "v1")} for doc in [unrelated, related]]
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: peers)
    neighbors = index.organization_neighbors(tmp_path, source, index.document_evidence(tmp_path, source["document_id"], "v1"), folders=[])
    assert [row["document_id"] for row in neighbors] == [related["document_id"]]
    assert template in neighbors[0]["evidence"][0]["text"]
    assert neighbors[0]["evidence"] == peers[1]["evidence"]


def test_explicit_targets_leave_five_independent_semantic_slots(tmp_path, monkeypatch):
    peers = [indexed(tmp_path, f"Storage-{number}.txt", f"Atlas storage checksum version recovery validates original file bytes {number}.") for number in range(7)]
    text = f"Atlas storage checksum version recovery validates original file bytes.\n document_id={peers[0]['document_id']} version=v1"
    source = indexed(tmp_path, "Manifest.txt", text)
    results = [{**doc, "evidence": index.document_evidence(tmp_path, doc["document_id"], "v1")} for doc in peers]
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: results)
    candidates = index.organization_neighbors(tmp_path, source, index.document_evidence(tmp_path, source["document_id"], "v1"), folders=[])
    assert len([row for row in candidates if row["candidate_source"] == "semantic"]) == 5
    assert candidates[0]["document_id"] == peers[0]["document_id"]
    assert candidates[0]["candidate_source"] == "explicit_reference"
    assert json.dumps(candidates.references)  # Diagnostics are durable wire-safe data.


def test_reference_outside_128_passage_sample_keeps_exact_stored_proof_anchor(tmp_path, monkeypatch):
    peer = indexed(tmp_path, "Late-report.txt", "Substantive company research.")
    passages = [f"Research context paragraph {number}." for number in range(300)]
    passages[257] = f"Late manifest: document_id={peer['document_id']}, version=v1."
    source = indexed(tmp_path, "Large-manifest.txt", "\n".join(passages), passages=passages)
    sampled = index.document_evidence(tmp_path, source["document_id"], "v1", limit=128)
    anchor_id = f"{source['document_id']}:v1:t0257"
    assert len(sampled) == 128 and anchor_id not in {row["evidence_id"] for row in sampled}
    original_batches = index.evidence_batches
    batch_sizes = []

    def bounded(*args, **kwargs):
        for batch in original_batches(*args, **kwargs):
            assert not index.INDEX_LOCK._is_owned()
            batch_sizes.append(len(batch))
            yield batch

    monkeypatch.setattr(index, "evidence_batches", bounded)
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: [])
    candidates = index.organization_neighbors(tmp_path, source, sampled, folders=[])
    assert [row["document_id"] for row in candidates] == [peer["document_id"]]
    assert sum(batch_sizes) == 300 and max(batch_sizes) <= 32
    assert len(candidates.source_evidence) == 1
    anchor = candidates.source_evidence[0]
    assert anchor["evidence_id"] == anchor_id and anchor["text"] == passages[257]
    assert anchor["document_id"] == source["document_id"] and anchor["version"] == "v1"
    for reference in candidates[0]["references"]:
        assert reference["source_evidence_id"] == anchor_id
        assert anchor["text"][reference["start"]:reference["end"]] == reference["reference_text"]
    # Caller samples are ranking hints; fabricated IDs/text cannot become proof.
    fabricated = [{"evidence_id": "invented", "text": "document_id=not-a-stored-reference"}]
    same = index.organization_neighbors(tmp_path, source, fabricated, folders=[])
    assert same.references == candidates.references and same.source_evidence == candidates.source_evidence
    from symbiknow.ai import proof
    from symbiknow.ai.jev import organize_document
    from tests.ai.test_jev import sdk_client

    requests = []
    original_call = proof.Provider.system_one

    def observed(self, **kwargs):
        requests.append(copy.deepcopy(kwargs))
        return original_call(self, **kwargs)

    monkeypatch.setattr(proof.Provider, "system_one", observed)
    with sdk_client() as client:
        decision = organize_document(source, sampled, candidates, client=client, links_only=True)
    assert decision["status"] == "evaluated", decision
    pair_request = next(request for request in requests if "pair_1_" in " ".join(request["questions"]))
    supplied = pair_request["state"]["documents"][0]["evidence"]
    position = next(i for i, row in enumerate(supplied) if row["chunk_id"] == anchor_id)
    assert supplied[position]["text"] == passages[257]
    assert f"pair_1_{position}_0" in pair_request["questions"]
    assert all(row["source_chunk_id"] == anchor_id for row in decision["link_evaluations"])


def test_long_manifest_reference_window_keeps_original_offsets_and_exact_ref(tmp_path, monkeypatch):
    from symbiknow.ai import proof

    peer = indexed(tmp_path, "Report.txt", "Company report details.")
    text = "Opening context. " * 300 + f"document_id={peer['document_id']} version=v1."
    source = indexed(tmp_path, "Long-manifest.txt", text)
    evidence = index.document_evidence(tmp_path, source["document_id"], "v1")
    monkeypatch.setattr(index, "find_documents", lambda *args, **kwargs: [])
    candidates = index.organization_neighbors(tmp_path, source, evidence, folders=[])
    prepared, anchors = proof._reference_source_windows(evidence, candidates)
    assert anchors[peer["document_id"]] == evidence[0]["evidence_id"]
    assert prepared[0]["text_start"] > 0
    assert text[prepared[0]["text_start"]:prepared[0]["text_start"] + len(prepared[0]["text"])] == prepared[0]["text"]
    assert peer["document_id"] in prepared[0]["text"]
    docs = proof.documents([{**source, "evidence": prepared}])
    window = docs[0]["evidence"][0]
    assert text[window["text_start"]:window["text_end"]] == window["text"]
    assert peer["document_id"] in window["text"]


def test_source_head_change_during_reference_scan_aborts_discovery(tmp_path, monkeypatch):
    peer = indexed(tmp_path, "Peer.txt", "Original target.")
    source = indexed(tmp_path, "Source.txt", f"document_id={peer['document_id']}")
    original_batches = index.evidence_batches

    def changed(*args, **kwargs):
        for batch in original_batches(*args, **kwargs):
            yield batch
            storage.save_file(tmp_path, b"Replacement without reference", source["filename"],
                              document_id=source["document_id"], expected_version="v1")

    monkeypatch.setattr(index, "evidence_batches", changed)
    with pytest.raises(ValueError, match="changed during discovery"):
        index.organization_neighbors(tmp_path, source, [], folders=[])
