"""Exact, bounded claim spans and their retained interpretation context."""
import hashlib
import re


def span(document, window, start=0, end=None):
    end = len(window["text"]) if end is None else end
    text = window["text"][start:end]
    return dict(document_id=document["document_id"], version=document["version"],
                chunk_id=window["chunk_id"], text_start=window["text_start"] + start,
                text_end=window["text_start"] + end, text=text,
                sha256=hashlib.sha256(text.encode()).hexdigest())


def claim_options(window):
    """Candidates are exact complete spans, never generated or cleaned claims."""
    text = window["text"]
    options = {"whole": (0, len(text))}
    boundaries = [0, *(m.end() for m in re.finditer(r"(?<=[.!?])\s+|\n\s*\n", text)), len(text)]
    ranges = []
    for start, end in zip(boundaries, boundaries[1:]):
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end and (start, end) != (0, len(text)):
            ranges.append((start, end))
    # A whole-passage choice always remains available. No candidate ends in the
    # middle of a sentence merely to fit a request budget.
    for i, (start, end) in enumerate(ranges[:12]):
        options[f"s{i}"] = (start, end)
    return options


def claim_criteria(window):
    return {**{key: window["text"][start:end] for key, (start, end) in claim_options(window).items()},
            "insufficient": "No concrete claim or explicit reference can be selected without losing essential qualifiers."}


def link_proof(docs, source, target, source_claim, target_claim, relation, checks, scopes=()):
    from symbiknow.ai import proof
    selected_docs = [docs[0], next(d for d in docs if d["document_id"] == target_claim["document_id"])]
    return dict(
        policy=proof.VERSION,
        criterion={"supports": "entails_target_claim", "contradicts": "incompatible_claims",
                   "related": "shared_subject"}[relation],
        source=source_claim, target=target_claim,
        source_context=span(selected_docs[0], source), target_context=span(selected_docs[1], target),
        context=proof.dependencies(docs),
        context_scope=list(scopes), checks=checks,
    )


def proof_references(link):
    """Validate untrusted proof structure before resolving bounded references."""
    value = link.get("proof") if isinstance(link, dict) else None
    if not isinstance(value, dict):
        raise ValueError("Relationship requires an evidence proof")
    context = value.get("context")
    if not isinstance(context, list) or not 1 <= len(context) <= 200:
        raise ValueError("Relationship proof context exceeds its budget")
    refs = []
    for item in [value.get(key) for key in ("source", "target", "source_context", "target_context")] + context:
        if not isinstance(item, dict):
            raise ValueError("Relationship proof needs span objects")
        ref = tuple(item.get(key) for key in ("document_id", "version", "chunk_id"))
        if not all(isinstance(part, str) and part and len(part) <= 512 for part in ref):
            raise ValueError("Relationship proof has an invalid reference")
        start, end = item.get("text_start"), item.get("text_end")
        digest = item.get("sha256")
        if (type(start) is not int or type(end) is not int or not 0 <= start < end
                or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or ("text" in item and (not isinstance(item["text"], str) or len(item["text"]) > 16000))):
            raise ValueError("Relationship proof has an invalid span")
        refs.append(ref)
    return list(dict.fromkeys(refs))


def validate_link_proof(link, source_id, resolved, metadata=None):
    """Validate every copied character against current authoritative passages.

    `resolved` is keyed by (document_id, version, chunk_id). Callers resolve ALL
    proof.context references under their final source/evidence publication guard.
    `metadata`, when supplied, maps document IDs to authoritative metadata.
    """
    proof_references(link)
    value = link["proof"]
    required = {"related": "shared_subject", "supports": "entails_target_claim",
                "contradicts": "incompatible_claims", "duplicate": "sha256_identity"}
    if value.get("criterion") != required.get(link.get("relation")):
        raise ValueError("Relationship proof criterion does not match its relation")
    expected = [(source_id, link["source_version"], link["source_chunk_id"]),
                (link["document_id"], link["version"], link["target_chunk_id"])]

    def check(item):
        key = (item.get("document_id"), item.get("version"), item.get("chunk_id"))
        original = resolved.get(key)
        start, end = item.get("text_start"), item.get("text_end")
        if (original is None or type(start) is not int or type(end) is not int
                or not 0 <= start < end <= len(original["text"])):
            raise ValueError("Relationship proof range is unavailable")
        text = original["text"][start:end]
        if (hashlib.sha256(text.encode()).hexdigest() != item.get("sha256")
                or ("text" in item and item["text"] != text)):
            raise ValueError("Relationship proof text changed")
        return key

    for name, key in zip(("source", "target"), expected):
        if check(value.get(name, {})) != key or check(value.get(name + "_context", {})) != key:
            raise ValueError("Relationship proof refers to a different endpoint")
        claim, context = value[name], value[name + "_context"]
        if not context["text_start"] <= claim["text_start"] < claim["text_end"] <= context["text_end"]:
            raise ValueError("Relationship claim is outside its supplied context")
    context = value.get("context")
    if not isinstance(context, list) or not 1 <= len(context) <= 200:
        raise ValueError("Relationship proof context exceeds its budget")
    references = {check(item) for item in context}
    if not set(expected) <= references:
        raise ValueError("Relationship proof omits endpoint context")
    if link["relation"] == "duplicate":
        identity = value.get("identity", {})
        if not isinstance(identity, dict):
            raise ValueError("Duplicate proof requires a SHA-256 identity")
        digest = identity.get("sha256", "")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Duplicate proof requires a SHA-256 identity")
        if metadata is not None and any((metadata.get(key[0]) or {}).get("sha256") != digest for key in expected):
            raise ValueError("Duplicate proof does not match original identity")
