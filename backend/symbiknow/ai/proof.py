"""Bounded joint-document proofs with versioned provenance and whole-context caching."""

import hashlib
import os
import re
import threading

from symbiknow.core.cache import ByteLRU, CoalescingCache, dependency_key, reuse_success
from symbiknow.ai.jev import ContextBudgetError
from symbiknow.ai.provider_errors import provider_failure
from symbiknow.search.metrics import add

VERSION = "joint-proof-4-fitted-windows/qualified-links-2/explicit-anchor-windows-1"
PER_DOCUMENT_VERSION = "per-document-proof-1"


def search_mode():
    """Experimental switch: SYMBIKNOW_JEV_SEARCH_MODE=per_document judges each file alone."""
    mode = os.getenv("SYMBIKNOW_JEV_SEARCH_MODE", "joint")
    if mode not in {"joint", "per_document"}:
        raise ValueError("SYMBIKNOW_JEV_SEARCH_MODE must be joint or per_document")
    return mode
MAX_PASSAGES = 12
MAX_DOCUMENT_TEXT = 16000
MAX_CONTEXT_TEXT = 50000
MAX_LINK_PAIRS = 45
_CACHE = ByteLRU(max_entries=128, max_bytes=2 * 1024**2)
_LOCK = threading.RLock()
_FLIGHTS = CoalescingCache(max_entries=0, max_bytes=0, max_inflight=32)


def organization_windows(evidence, budget=MAX_DOCUMENT_TEXT, *, priority_ids=()):
    """Sample original windows for long-file organization, never cleaned claim text.

    Search proof inputs are not sampled here: exceeding their budget fails closed.
    Explicit reference anchors take priority over the ordinary document sample.
    """
    from symbiknow.ai import jev

    rows = [r for r in evidence if jev._evidence({"evidence": [r]})]
    # Stored IDs sort lexically (t10 before t2). Sampling must use actual text
    # order to retain the last supplied passage rather than, for example, t99.
    ordinals = [re.search(r":t(\d+)$", str(r.get("evidence_id", r.get("chunk_id")))) for r in rows]
    if rows and all(ordinals):
        rows = [r for _, r in sorted(zip([int(m[1]) for m in ordinals], rows), key=lambda p: p[0])]
    anchors = {r.get("evidence_id", r.get("chunk_id")) for r in jev.representative_evidence(rows)}
    priority = [i for ref in priority_ids for i, row in enumerate(rows)
                if row.get("evidence_id", row.get("chunk_id")) == ref]
    priority += [0, len(rows) - 1]
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
    chosen = [r for i, r in enumerate(rows) if i in selected]
    windows = [jev._evidence({"evidence": [r]})[0] for r in chosen]
    return chosen, dict(
        available_windows=len(rows),
        selected_windows=len(selected),
        sampled=len(selected) != len(rows),
        supplied_ranges=[dict(chunk_id=w["chunk_id"], text_start=w["text_start"] + r.get("text_start", 0),
                              text_end=w["text_end"] + r.get("text_start", 0),
                              original_text_length=r.get("original_text_length", len(r["text"])),
                              truncated=bool(w["truncated"] or r.get("truncated")))
                         for r, w in zip(chosen, windows)],
        omitted_chunk_ids=[r.get("evidence_id", r.get("chunk_id")) for i, r in enumerate(rows) if i not in selected],
        scope="Selected original text windows; not a whole-file verification",
    )


def fit_search_windows(matches, query):
    """Choose retrieved windows breadth-first by retrieval rank within proof budgets.

    Retrieval keeps up to twelve windows per document, more than one joint proof
    can carry for several long documents. Every candidate's best-ranked window
    enters first, then every candidate's next one, so each document is judged on
    its strongest evidence. Omitted windows are named in context_scope and the
    judgment covers only the selected windows; it is never a whole-document check.
    """
    from symbiknow.ai import jev

    plans = []
    for match in matches[: jev.MAX_MATCHES]:
        raw = match.get("evidence", [])
        if isinstance(raw, (str, dict)):
            raw = [{"text": raw}] if isinstance(raw, str) else [raw]
        if not raw and match.get("text"):
            raw = [match]
        rows = [(row, windows[0]) for row in raw if isinstance(row, dict)
                for windows in [jev._evidence({"evidence": [row]}, query)] if windows]
        plans.append((match, rows, []))
    total, used = 0, [0] * len(plans)
    for depth in range(max((len(rows) for _, rows, _ in plans), default=0)):
        for i, (_, rows, chosen) in enumerate(plans):
            if depth >= len(rows) or len(chosen) >= MAX_PASSAGES:
                continue
            size = len(rows[depth][1]["text"])
            if used[i] + size <= MAX_DOCUMENT_TEXT and total + size <= MAX_CONTEXT_TEXT:
                chosen.append(rows[depth][0])
                used[i] += size
                total += size
    fitted = []
    for match, rows, chosen in plans:
        if len(chosen) == len(rows):
            fitted.append(match)
            continue
        kept = {id(row) for row in chosen}
        fitted.append(dict(match, evidence=chosen, context_scope=dict(
            available_windows=len(rows), selected_windows=len(chosen), sampled=True,
            omitted_chunk_ids=[window["chunk_id"] for row, window in rows if id(row) not in kept],
            scope="Selected retrieved windows by retrieval rank; not a whole-document check")))
    return fitted


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
            base = original.get("text_start", 0)
            if type(base) is not int or base < 0:
                raise ValueError("Evidence needs a valid original text offset")
            window["text_start"] += base
            window["text_end"] += base
            window["original_text_length"] = original.get("original_text_length", base + len(original.get("text", "")))
            window["truncated"] = bool(window["truncated"] or original.get("truncated")
                                       or base or window["text_end"] < window["original_text_length"])
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
            positions = [re.search(r":([tv])(\d+)$", e["chunk_id"]) for e in evidence]
            if all(positions):
                evidence = [e for _, e in sorted(zip([(m[1], int(m[2])) for m in positions], evidence), key=lambda pair: pair[0])]
            docs.append(
                dict(
                    document_id=identity[0],
                    version=identity[1],
                    filename=str(match.get("filename", ""))[:240],
                    evidence=evidence,
                    **{key: match[key] for key in ("candidate_source", "references", "context_scope") if key in match},
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
            truncated=e["truncated"],
            original_text_length=e.get("original_text_length", e["text_end"]),
        )
        for d in docs
        for e in d["evidence"]
    ]


def search_decision(query, docs, provider, scope=None):
    from symbiknow.ai import decisions as rules
    from symbiknow.ai import jev

    row = dict(action="search", question=query, _documents=docs, scope=scope)
    response = provider.system_one(
        state=rules.search_state(query, docs, scope),
        questions=rules.build_questions(row, docs),
    )
    first = rules.decode(row, docs, response)
    confidences = [first["confidence"], *[r["confidence"] for r in first["roles"].values()]]
    off = rules.off_subject(first["roles"], docs, response)
    if off:
        # A cited passage concerns a different (lookalike) entity: re-decide the
        # whole answer without it rather than trusting the first coverage.
        add("proof_off_subject_passages", len(off))
        kept = rules.without(docs, off)
        if not kept:
            return dict(first, answer_status="none", references=[], coverage="missing", off_subject=sorted(off))
        row = dict(row, _documents=kept)
    # A correction always gets the targeted denial check below.
    elif min(confidences) >= jev.PROOF_CONFIDENCE and first["coverage"] != "correction":
        return first
    second = rules.verify_search(row, provider)
    if off:
        second["off_subject"] = sorted(off)
    if second["coverage"] == "correction" and second["confidence"] >= jev.VERIFY_CONFIDENCE:
        # The generic citation can also pick the passage asserting the premise.
        check = rules.check_correction(row, provider)
        if check["denials"]:
            return dict(second, references=check["denials"], correction_check=check)
        return dict(second, answer_status="needs_context", references=[], correction_check=check)
    distribution = second["coverage_distribution"]
    top = sorted(distribution, key=distribution.get, reverse=True)[:2]
    answer_kind = next((k for k in top if k in {"complete", "partial"} and distribution[k] > 0), None)
    if "conflicting" in top and answer_kind and second["cited"] and distribution["conflicting"] > 0 and (
            second["confidence"] < jev.VERIFY_CONFIDENCE or second["coverage"] == "conflicting"):
        # The answer hinges on a suspected conflict: settle it pair by pair, since
        # lookalike scopes and injected instructions often read as disagreement.
        check = rules.check_conflict(row, second["cited"], provider)
        if check["conflict_probability"] < jev.CONFLICT_CLEAR_PROBABILITY:
            return dict(second, coverage=answer_kind, references=second["cited"], conflict_check=check,
                        answer_status={"complete": "answered", "partial": "partial"}[answer_kind])
        return dict(second, coverage="conflicting", answer_status="needs_context", references=[], conflict_check=check)
    if second["confidence"] >= jev.VERIFY_CONFIDENCE:
        return second
    if (second["coverage"] in {"complete", "partial"} and second["cited"]
            and second["confidence"] >= jev.BORDERLINE_CONFIDENCE):
        # Just under the gate on the coarse coverage choice: a focused yes/no per
        # cited passage decides, and only a strong yes for every one publishes.
        check = rules.check_answer(row, second["cited"], provider)
        if check["answer_probability"] >= jev.STATES_ANSWER_PROBABILITY:
            return dict(second, references=second["cited"], answer_check=check,
                        answer_status={"complete": "answered", "partial": "partial"}[second["coverage"]])
        return dict(second, answer_status="needs_context", references=[], answer_check=check)
    # The first pass already failed its acceptance gate. An uncertain check
    # cannot revive that preliminary answer (or establish a negative answer).
    return dict(second, answer_status="needs_context", references=[])


def per_document_decision(query, docs, provider):
    """Ask each document alone whether it fully or partly answers the question.

    No document sees another, so cross-document joins (rule plus condition,
    alias plus fact) can only surface as separate partial answers.
    """
    from symbiknow.ai import decisions as rules

    judged = {}
    for doc in docs:
        response = provider.system_one(state=rules.document_state(query, doc),
                                       questions=rules.document_questions(doc))
        judged[doc["document_id"]] = rules.decode_document(doc, response)
    found = {r["coverage"] for r in judged.values()}
    status = next((s for c, s in (("full", "answered"), ("partial", "partial"),
                                  ("correction", "corrected_premise")) if c in found), "none")
    return dict(
        status="evaluated",
        answer_status=status,
        references=[ref for r in judged.values() for ref in r["references"]],
        coverage={"answered": "complete", "partial": "partial",
                  "corrected_premise": "correction"}.get(status, "missing"),
        returned=[d for d, r in judged.items() if r["coverage"] != "none"],
        confidence=max(r["confidence"] for r in judged.values()),
        documents=judged,
    )


def judge(query, matches, *, client=None, cache_namespace=None, scope=None):
    from symbiknow.ai import jev

    mode = search_mode()
    policy = VERSION if mode == "joint" else f"{VERSION}/{PER_DOCUMENT_VERSION}"
    try:
        if len(query) > 4000:
            raise ContextBudgetError("Question budget")
        docs = documents(fit_search_windows(matches, query), query)
        if not docs:
            return dict(
                status="not_evaluated",
                matches=[
                    dict(m, jev=dict(status="not_evaluated", reason="no_text")) for m in matches
                ],
            )
        key = dependency_key("proof-judgment", library=cache_namespace, query=query,
                             documents=docs, version=policy, scope=scope, descriptor=jev.judgment_descriptor())
        cached = None

        def compute():
            provider = Provider(client)
            if mode == "joint":
                decision = search_decision(query, docs, provider, scope)
            else:
                decision = per_document_decision(query, docs, provider)
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
            **provider_failure(error),
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
        if "documents" in decision:
            # Per-document mode: each file keeps its own answers, not the joint one.
            own = decision["documents"][doc["document_id"]]["coverage"]
            coverage = {"full": "complete", "partial": "partial"}.get(own, "none")
            correction = own == "correction"
            label = {"full": "direct", "partial": "partial", "none": "unrelated"}.get(own, "related")
        else:
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
            evaluated_evidence_complete=not any(e["truncated"] for e in doc["evidence"])
            and "context_scope" not in doc,
            **({"context_scope": doc["context_scope"]} if "context_scope" in doc else {}),
            basis=sorted({e["basis"] for e in doc["evidence"]}),
            verification_dependencies=deps if citations else [],
            context_policy=policy,
            prompt_version=jev.PROMPT_VERSION,
            policy_version=jev.POLICY_VERSION,
            explanation="Answer coverage was checked jointly against supplied original windows. Citations include required rules and observed facts; context dependencies are verified before publication. This is not a check of the complete library.",
        )
        output.append(dict(match, jev=judgment))
    return dict(
        status="evaluated",
        matches=output,
        cached=len(docs) if cached is not None else 0,
        proof_assessment=dict(**assessment, context_policy=policy, cache_hit=cached is not None),
        cross_document_assessment=dict(
            status="evaluated",
            context_policy=policy,
            compared_chunk_ids=[d["chunk_id"] for d in deps],
            scope="All supplied proof windows; not the complete library",
        ),
    )


def _reference_source_windows(evidence, neighbors):
    """Keep one exact stored reference per target inside the bounded source window."""
    from symbiknow.ai import jev

    by_id = {row.get("evidence_id", row.get("chunk_id")): row for row in evidence}
    anchors, ranges = {}, {}
    for neighbor in neighbors:
        if neighbor.get("candidate_source") != "explicit_reference":
            continue
        for reference in neighbor.get("references", []):
            identity = reference.get("source_evidence_id")
            row = by_id.get(identity)
            start, end = reference.get("start"), reference.get("end")
            if (row is not None and type(start) is int and type(end) is int
                    and 0 <= start < end <= len(row.get("text", ""))
                    and row["text"][start:end] == reference.get("reference_text")):
                anchors[neighbor["document_id"]] = identity
                ranges.setdefault(identity, []).append((start, end))
                break
        if neighbor["document_id"] not in anchors:
            raise ValueError("Explicit reference needs its exact source evidence span")
    prepared = []
    for identity, row in by_id.items():
        if identity in ranges and len(row["text"]) > jev.MAX_TEXT:
            first, last = min(start for start, _ in ranges[identity]), max(end for _, end in ranges[identity])
            if last - first > jev.MAX_TEXT:
                raise ContextBudgetError("Explicit reference anchors need separate link batches")
            start = max(0, first - 400, last - jev.MAX_TEXT)
            prepared.append(dict(row, text=row["text"][start:start + jev.MAX_TEXT], text_start=start,
                                 original_text_length=len(row["text"]), truncated=True))
        else:
            prepared.append(row)
    return prepared, anchors


def links(document, evidence, neighbors, client=None):
    from symbiknow.ai import decisions as rules

    budget = min(MAX_DOCUMENT_TEXT, MAX_CONTEXT_TEXT // (len(neighbors) + 1))
    source_evidence, reference_anchors = _reference_source_windows(evidence, neighbors)
    inputs, scopes = [], []
    for position, item in enumerate([dict(document, evidence=source_evidence), *neighbors]):
        selected, scope = organization_windows(item.get("evidence", []), budget,
                                               priority_ids=reference_anchors.values() if position == 0 else ())
        inputs.append(dict(item, evidence=selected, context_scope=scope))
        scopes.append(dict(document_id=item["document_id"], **scope))
    docs = documents(inputs)
    if not docs or docs[0]["document_id"] != document["document_id"]:
        raise ValueError("Missing source text")
    if not set(reference_anchors.values()) <= {row["chunk_id"] for row in docs[0]["evidence"]}:
        raise ContextBudgetError("Explicit reference anchors need separate link batches")
    pairs = len(docs[0]["evidence"]) * sum(len(d["evidence"]) for d in docs[1:])
    row = dict(action="links", document=document, neighbors=neighbors, _documents=docs, context_scope=scopes)
    if pairs > MAX_LINK_PAIRS or reference_anchors:
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
            if s["chunk_id"] in ({reference_anchors[n["document_id"]]}
                                  if n["document_id"] in reference_anchors else selected[0])
            and t["chunk_id"] in selected[ni]
        }
        if len(row["pair_keys"]) > MAX_LINK_PAIRS:
            raise ContextBudgetError("Link pair budget")
    provider = Provider(client)
    response = provider.system_one(
        state=rules.link_state(docs), questions=rules.build_questions(row, docs)
    )
    rules.decode(row, docs, response)
    # Confidence is not a proof. Every semantic pair faces the same independent
    # subject, context, and exact-claim verification before publication.
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


def identity_proof(document, evidence, neighbor):
    """Byte identity is the explicit duplicate criterion, not a model opinion."""
    from symbiknow.ai.link_evidence import span
    digest = document.get("sha256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or neighbor.get("sha256") != digest:
        raise ValueError("Duplicate proof requires matching SHA-256 originals")
    inputs, scopes = [], []
    for item in [dict(document, evidence=evidence), neighbor]:
        selected, scope = organization_windows(item.get("evidence", []))
        inputs.append(dict(item, evidence=selected))
        scopes.append(dict(document_id=item["document_id"], **scope))
    docs = documents(inputs)
    if len(docs) != 2:
        raise ValueError("Duplicate endpoints need source evidence")
    source, target = [span(doc, doc["evidence"][0]) for doc in docs]
    return dict(policy=VERSION, criterion="sha256_identity", source=source, target=target,
                source_context=source, target_context=target, context=dependencies(docs),
                context_scope=scopes, identity={"sha256": digest}, checks={"byte_identity": True})


def make_reviewed_proof(source, target, source_chunk, target_chunk, *, relation,
                        actor, reason, source_range=None, target_range=None):
    """Represent an explicit human-reviewed correction without a model call.

    Chunks contain evidence_id/chunk_id and full original text. Optional ranges
    are (start, end) character offsets into those original chunks. Authorization
    and current source/evidence/manual guards belong to the correction service.
    """
    from symbiknow.ai.link_evidence import link_proof, span
    if not actor or not reason:
        raise ValueError("A reviewed proof needs its actor and reason")
    docs = documents([dict(source, evidence=[source_chunk]), dict(target, evidence=[target_chunk])])
    if len(docs) != 2 or any(d["evidence"][0]["truncated"] for d in docs):
        raise ValueError("Review needs complete bounded original claim context")
    windows = [d["evidence"][0] for d in docs]
    claims = []
    for doc, window, bounds in zip(docs, windows, (source_range, target_range)):
        start, end = bounds or (window["text_start"], window["text_end"])
        if type(start) is not int or type(end) is not int or not window["text_start"] <= start < end <= window["text_end"]:
            raise ValueError("Reviewed claim is outside its original chunk")
        claims.append(span(doc, window, start - window["text_start"], end - window["text_start"]))
    result = link_proof(docs, *windows, *claims, relation, {"human_review": True})
    result["review"] = {"actor": actor, "reason": reason}
    return result


# Publication owners resolve authoritative passages and call this shared guard.
from symbiknow.ai.link_evidence import validate_link_proof  # noqa: E402,F401
