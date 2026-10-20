"""Bounded joint-document proofs with versioned provenance and whole-context caching."""

import hashlib
import re
import threading

from symbiknow.core.cache import ByteLRU, CoalescingCache, dependency_key, reuse_success
from symbiknow.ai.jev import ContextBudgetError
from symbiknow.search.metrics import add

VERSION = "joint-proof-2"
MAX_PASSAGES = 12
MAX_DOCUMENT_TEXT = 16000
MAX_CONTEXT_TEXT = 50000
MAX_LINK_PAIRS = 45
_CACHE = ByteLRU(max_entries=128, max_bytes=2 * 1024**2)
_LOCK = threading.RLock()
_FLIGHTS = CoalescingCache(max_entries=0, max_bytes=0, max_inflight=32)


def organization_windows(evidence, budget=MAX_DOCUMENT_TEXT):
    """Sample original windows for long-file organization, never cleaned claim text.

    Search proof inputs are not sampled here: exceeding their budget fails closed.
    Organization already receives a bounded sample from document_evidence().
    """
    from symbiknow.ai import jev

    rows = [r for r in evidence if jev._evidence({"evidence": [r]})]
    # Stored IDs sort lexically (t10 before t2). Sampling must use actual text
    # order to retain the last supplied passage rather than, for example, t99.
    ordinals = [re.search(r":t(\d+)$", str(r.get("evidence_id", r.get("chunk_id")))) for r in rows]
    needs_sample = (
        len(rows) > MAX_PASSAGES
        or sum(len(jev._evidence({"evidence": [r]})[0]["text"]) for r in rows) > budget
    )
    if needs_sample and all(ordinals):
        rows = [r for _, r in sorted(zip([int(m[1]) for m in ordinals], rows), key=lambda p: p[0])]
    anchors = {r.get("evidence_id", r.get("chunk_id")) for r in jev.representative_evidence(rows)}
    priority = [0, len(rows) - 1]
    priority += [
        i for i, r in enumerate(rows) if r.get("evidence_id", r.get("chunk_id")) in anchors
    ]
    priority += [int(i * max(0, len(rows) - 1) / (MAX_PASSAGES - 1)) for i in range(MAX_PASSAGES)]
    priority += list(range(len(rows)))
    selected, used = set(), 0
    for i in dict.fromkeys(priority):
        if not 0 <= i < len(rows) or len(selected) >= MAX_PASSAGES:
            continue
        size = len(jev._evidence({"evidence": [rows[i]]})[0]["text"])
        if used + size <= budget:
            selected.add(i)
            used += size
    return [r for i, r in enumerate(rows) if i in selected], dict(
        available_windows=len(rows),
        selected_windows=len(selected),
        sampled=len(selected) != len(rows),
        scope="Selected original text windows; not a whole-file verification",
    )


class Provider:
    def __init__(self, client=None):
        self.client = client
        self.model = None
        self.calls = 0

    def system_one(self, **kwargs):
        from symbiknow.ai import jev

        response = jev._call(kwargs["state"], kwargs["questions"], self.client)
        self.model = response.model
        self.calls += 1
        return response


def documents(matches, query=None):
    from symbiknow.ai import jev

    docs, identities, references = [], set(), set()
    for match in matches[: jev.MAX_MATCHES]:
        identity = (match["document_id"], match["version"])
        if identity in identities:
            raise ValueError("Duplicate evidence document")
        identities.add(identity)
        raw = match.get("evidence", [])
        if isinstance(raw, (str, dict)):
            raw = [{"text": raw}] if isinstance(raw, str) else [raw]
        if not raw and match.get("text"):
            raw = [match]
        evidence = []
        for original in raw:
            windows = jev._evidence({"evidence": [original]}, query)
            if not windows:
                continue
            window = windows[0]
            ref = window["chunk_id"]
            if (
                not isinstance(ref, str)
                or not ref.startswith(f"{identity[0]}:{identity[1]}:")
                or ref in references
            ):
                raise ValueError("Evidence needs a unique versioned reference")
            references.add(ref)
            evidence.append(window)
        if (
            len(evidence) > MAX_PASSAGES
            or sum(len(e["text"]) for e in evidence) > MAX_DOCUMENT_TEXT
        ):
            raise ContextBudgetError("Document context budget")
        if evidence:
            docs.append(
                dict(
                    document_id=identity[0],
                    version=identity[1],
                    filename=str(match.get("filename", ""))[:240],
                    evidence=evidence,
                )
            )
    if sum(len(e["text"]) for d in docs for e in d["evidence"]) > MAX_CONTEXT_TEXT:
        raise ContextBudgetError("Request context budget")
    return docs


def dependencies(docs):
    return [
        dict(
            document_id=d["document_id"],
            version=d["version"],
            chunk_id=e["chunk_id"],
            text_start=e["text_start"],
            text_end=e["text_end"],
            sha256=hashlib.sha256(e["text"].encode()).hexdigest(),
        )
        for d in docs
        for e in d["evidence"]
    ]


def search_decision(query, docs, provider):
    from symbiknow.ai import decisions as rules

    row = dict(action="search", question=query, _documents=docs)
    response = provider.system_one(
        state=dict(user_question=query, documents=docs, policy=rules.POLICY),
        questions=rules.build_questions(row, docs),
    )
    first = rules.decode(row, docs, response)
    if min([first["confidence"], *[r["confidence"] for r in first["roles"].values()]]) >= 0.8:
        return first
    second = rules.verify_search(row, provider)
    if second["confidence"] >= 0.6:
        return second
    # The first pass already failed its acceptance gate. An uncertain check
    # cannot revive that preliminary answer (or establish a negative answer).
    return dict(second, answer_status="needs_context", references=[])


def judge(query, matches, *, client=None, cache_namespace=None):
    from symbiknow.ai import jev

    try:
        if len(query) > 4000:
            raise ContextBudgetError("Question budget")
        docs = documents(matches, query)
        if not docs:
            return dict(
                status="not_evaluated",
                matches=[
                    dict(m, jev=dict(status="not_evaluated", reason="no_text")) for m in matches
                ],
            )
        key = dependency_key("proof-judgment", library=cache_namespace, query=query,
                             documents=docs, version=VERSION, descriptor=jev.judgment_descriptor())
        cached = None

        def compute():
            provider = Provider(client)
            decision = search_decision(query, docs, provider)
            return dict(decision=decision, model=provider.model, calls=provider.calls)

        if client is None and cache_namespace is not None:
            assessment, hit = reuse_success(_CACHE, key, compute, lock=_LOCK, flights=_FLIGHTS)
            if hit:
                cached = assessment
                add("proof_cache_hits", 1)
        else:
            assessment = compute()
    except ContextBudgetError:
        return dict(
            status="not_evaluated",
            reason="context_budget",
            matches=[
                dict(m, jev=dict(status="not_evaluated", reason="context_budget")) for m in matches
            ],
        )
    except Exception as error:
        return dict(
            status="unavailable",
            error=f"Jev unavailable ({type(error).__name__})",
            matches=[
                dict(m, jev=dict(status="unavailable", reason="provider_unavailable"))
                for m in matches
            ],
        )
    decision = assessment["decision"]
    refs = set(decision["references"])
    deps = dependencies(docs)
    by_id = {d["document_id"]: d for d in docs}
    coverage = {"answered": "complete", "partial": "partial"}.get(decision["answer_status"], "none")
    correction = decision["answer_status"] == "corrected_premise"
    uncertain = decision["answer_status"] == "needs_context"
    conflicting = decision["coverage"] == "conflicting" and not uncertain
    output = []
    for match in matches:
        doc = by_id.get(match["document_id"])
        if doc is None:
            output.append(
                dict(match, jev=dict(status="not_evaluated", reason="no_text_or_candidate_limit"))
            )
            continue
        citations = [e["chunk_id"] for e in doc["evidence"] if e["chunk_id"] in refs]
        label = (
            "uncertain"
            if uncertain or conflicting
            else ("direct" if coverage == "complete" else "partial")
            if citations and not correction
            else "related"
        )
        judgment = dict(
            status="evaluated",
            label=label,
            policy_label=label,
            model_label=label,
            model_confidence=decision["confidence"],
            confidence_meaning="Choice distribution concentration; not measured probability of correctness",
            model=assessment["model"],
            coverage="unknown" if uncertain or conflicting else coverage if citations else "none",
            supporting_chunk_ids=citations if not correction else [],
            conflicting_chunk_ids=citations if correction else [],
            possible_conflicting_chunk_ids=[],
            disagreement_chunk_ids=[],
            premise_correction_status="accepted" if correction and citations else "none_accepted",
            evidence_disagreement="accepted" if conflicting else "none_detected",
            decision_reason="proof_requires_verification"
            if uncertain
            else "conflicting_evidence"
            if conflicting
            else "premise_corrected"
            if correction and citations
            else "verified_joint_proof"
            if citations
            else "no_joint_proof",
            evaluated_evidence=doc["evidence"],
            evaluated_evidence_complete=not any(e["truncated"] for e in doc["evidence"]),
            basis=sorted({e["basis"] for e in doc["evidence"]}),
            verification_dependencies=deps if citations else [],
            context_policy=VERSION,
            prompt_version=jev.PROMPT_VERSION,
            policy_version=jev.POLICY_VERSION,
            explanation="Answer coverage was checked jointly against supplied original windows. Citations include required rules and observed facts; context dependencies are verified before publication. This is not a check of the complete library.",
        )
        output.append(dict(match, jev=judgment))
    return dict(
        status="evaluated",
        matches=output,
        cached=len(docs) if cached is not None else 0,
        proof_assessment=dict(**assessment, context_policy=VERSION, cache_hit=cached is not None),
        cross_document_assessment=dict(
            status="evaluated",
            context_policy=VERSION,
            compared_chunk_ids=[d["chunk_id"] for d in deps],
            scope="All supplied proof windows; not the complete library",
        ),
    )


def links(document, evidence, neighbors, client=None):
    from symbiknow.ai import decisions as rules

    budget = min(MAX_DOCUMENT_TEXT, MAX_CONTEXT_TEXT // (len(neighbors) + 1))
    inputs, scopes = [], []
    for item in [dict(document, evidence=evidence), *neighbors]:
        selected, scope = organization_windows(item.get("evidence", []), budget)
        inputs.append(dict(item, evidence=selected))
        scopes.append(dict(document_id=item["document_id"], **scope))
    docs = documents(inputs)
    if not docs or docs[0]["document_id"] != document["document_id"]:
        raise ValueError("Missing source text")
    pairs = len(docs[0]["evidence"]) * sum(len(d["evidence"]) for d in docs[1:])
    row = dict(action="links", document=document, neighbors=neighbors, _documents=docs)
    if pairs > MAX_LINK_PAIRS:
        # Bound semantic candidate pairs while preserving every supplied window
        # as context. The original representative selector chooses claim anchors.
        from symbiknow.ai import jev

        selected = [
            {e["chunk_id"] for e in jev.representative_evidence(d["evidence"])} for d in docs
        ]
        row["pair_keys"] = {
            f"{ni}_{si}_{ti}"
            for ni, n in enumerate(docs[1:], 1)
            for si, s in enumerate(docs[0]["evidence"])
            for ti, t in enumerate(n["evidence"])
            if s["chunk_id"] in selected[0] and t["chunk_id"] in selected[ni]
        }
        if len(row["pair_keys"]) > MAX_LINK_PAIRS:
            raise ContextBudgetError("Link pair budget")
    provider = Provider(client)
    response = provider.system_one(
        state=dict(documents=docs, policy=rules.POLICY), questions=rules.build_questions(row, docs)
    )
    result = rules.decode(row, docs, response)
    if any(link.get("confidence", 1) < 0.8 for link in result["links"]):
        result = rules.verify_links(row, provider)
    by_id = {d["document_id"]: d for d in docs}
    for link in result["links"]:
        link.update(
            version=by_id[link["document_id"]]["version"], source_version=document["version"]
        )

    def pair_key(item):
        return (
            item["document_id"],
            item["source_chunk_id"],
            item["target_chunk_id"],
            item["relation"],
        )

    accepted = {pair_key(link) for link in result["links"]}
    audits = [
        dict(
            item, accepted=pair_key(item) in accepted, version=by_id[item["document_id"]]["version"]
        )
        for item in result["evaluations"]
    ]
    return dict(
        status="evaluated",
        links=result["links"],
        link_evaluations=audits,
        model=provider.model,
        context_assessment=scopes,
    )
