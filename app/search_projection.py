"""Useful compact pages of a bounded, fully validated result window."""

import copy
import json

COMPACT_BYTES = 32 * 1024
# Complete SDK CallToolResult (JSON text + structuredContent), not HTTP wire bytes.
SDK_RESULT_BYTES = 128 * 1024
_PAYLOAD_BYTES = COMPACT_BYTES - 3072  # metrics and bounded continuation token


def _bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def _short(value, budget):
    return str(value).encode()[:budget].decode("utf-8", errors="ignore")


def _entry(original):
    match = {
        k: copy.deepcopy(original[k])
        for k in (
            "document_id",
            "version",
            "filename",
            "mime_type",
            "folder",
            "groups",
            "status",
            "organization_status",
            "retrieval",
        )
        if k in original
    }
    for key in ("filename", "folder", "mime_type"):
        if key in match:
            match[key] = _short(match[key], 512)
    match["groups"] = [_short(g, 120) for g in match.get("groups", [])[:8]]
    j = original.get("jev", {})
    match["jev"] = {
        k: copy.deepcopy(j[k])
        for k in (
            "status",
            "label",
            "policy_label",
            "coverage",
            "evidence_presence",
            "decision_reason",
            "policy_version",
            "prompt_version",
            "model",
            "model_label",
            "basis",
            "reason",
            "supporting_chunk_ids",
            "conflicting_chunk_ids",
            "possible_conflicting_chunk_ids",
            "conflict_status",
            "possible_conflict_reasons",
            "evaluated_evidence_complete",
            "premise_correction_status",
            "evidence_disagreement",
            "disagreement_chunk_ids",
            "disagreement_scope",
        )
        if k in j
    }
    if j.get("explanation"):
        match["jev"]["explanation"] = _short(j["explanation"], 384)
    if not j:
        match["jev"].update(status="not_evaluated", reason="not_requested")
    match["jev"]["assessment_scope"] = "supplied text windows; not the complete original"
    evaluated = {r["chunk_id"]: r for r in j.get("evaluated_evidence", [])}
    roles = (
        ("supporting_chunk_ids", "support"),
        ("conflicting_chunk_ids", "conflict"),
        ("possible_conflicting_chunk_ids", "possible_conflict"),
        ("disagreement_chunk_ids", "disagreement"),
    )
    rows = {r["evidence_id"]: r for r in original.get("evidence", [])}
    for ref, window in evaluated.items():
        rows.setdefault(ref, dict(window, evidence_id=ref))
    refs = list(dict.fromkeys(ref for key, _ in roles for ref in j.get(key, [])))
    selected = [r for ref in refs if (r := rows.get(ref))][:8]
    if not selected and rows:
        selected = [
            next(
                (row for ref, row in rows.items() if (evaluated.get(ref) or row).get("text")),
                next(iter(rows.values())),
            )
        ]
    match["evidence"] = []
    for row in selected:
        ref = row["evidence_id"]
        window = evaluated.get(ref)
        text = (window or row).get("text", "")
        excerpt = _short(text, 384)
        match["evidence"].append(
            {
                "evidence_id": ref,
                "version": original["version"],
                "basis": row.get("basis"),
                "roles": [role for key, role in roles if ref in j.get(key, [])],
                "text": excerpt,
                "text_start": (window or {}).get("text_start", 0),
                "excerpt_truncated": len(excerpt) < len(text),
                "assessment": "evaluated_window" if window else "not_evaluated",
            }
        )
    included = {r["evidence_id"] for r in match["evidence"]}
    omitted = {}
    for key, _ in roles:
        if key in match["jev"]:
            values = j[key]
            match["jev"][key] = [ref for ref in values if ref in included]
            if len(values) != len(match["jev"][key]):
                omitted[key] = len(values) - len(match["jev"][key])
    if "possible_conflict_reasons" in match["jev"]:
        match["jev"]["possible_conflict_reasons"] = {
            ref: _short(reason, 120)
            for ref, reason in j["possible_conflict_reasons"].items()
            if ref in included
        }
    match["omissions"] = {
        "passages": len(rows) - len(included),
        "citations": omitted,
        "metadata_bounded": True,
    }
    if omitted:
        match["omissions"]["diagnostics"] = "use detail=full for all citation roles and evidence"
    return match


def project_search(result, detail="compact", *, offset=0, continuation=None):
    if detail == "full":
        return copy.deepcopy(result)
    if detail != "compact":
        raise ValueError("detail must be compact or full")
    out = {k: copy.deepcopy(v) for k, v in result.items() if k != "matches"}
    out.update(detail="compact", matches=[])
    originals = result.get("matches", [])
    if not 0 <= offset <= len(originals):
        raise ValueError("Invalid continuation offset; restart search")
    out["page"] = {
        "offset": offset,
        "returned_count": 0,
        "window_count": len(originals),
        "has_more": False,
        "continuation": None,
        "consistency": "restart on index/organization change or changed OCFL heads",
    }
    out["omissions"] = {
        "diagnostics": "use detail=full for raw probabilities and evaluated text",
        "passages": 0,
        "matches": 0,
        "metadata_bounded": True,
        "response_budget_bytes": COMPACT_BYTES,
        "sdk_result_budget_bytes": SDK_RESULT_BYTES,
    }
    for original in originals[offset:]:
        entry = _entry(original)
        out["matches"].append(entry)
        if _bytes(out) > _PAYLOAD_BYTES:
            out["matches"].pop()
            if out["matches"]:
                break
            # Pathological entry: explicit diagnostic with consistent bounded citations.
            for row in entry["evidence"]:
                row["text"] = _short(row["text"], 128)
                row["excerpt_truncated"] = True
            entry["omissions"]["diagnostics"] = "oversized entry; use detail=full"
            out["matches"].append(entry)
            if _bytes(out) > _PAYLOAD_BYTES:
                raise ValueError("Compact entry exceeds budget; repeat with detail=full")
        out["omissions"]["passages"] += entry["omissions"]["passages"]
    next_offset = offset + len(out["matches"])
    remaining = len(originals) - next_offset
    out["omissions"]["matches"] = remaining
    out["page"].update(returned_count=len(out["matches"]), has_more=bool(remaining))
    if remaining:
        out["page"]["continuation"] = continuation(next_offset) if continuation else None
        if continuation is None:
            out["page"]["instructions"] = "use search continuation or detail=full"
    return out
