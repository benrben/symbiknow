"""Label-agnostic, linear-memory quality metrics; no provider accuracy assumptions."""

from collections import Counter

LABELS = ("direct", "partial", "related", "unrelated", "uncertain")


def answerability_metrics(rows):
    confusion = {label: {other: 0 for other in LABELS} for label in LABELS}
    abstentions = Counter()
    statuses = Counter()
    for row in rows:
        expected, predicted = row["expected"], row["predicted"]
        if expected not in LABELS or predicted not in LABELS:
            raise ValueError("Expected and predicted verdicts must be recognized labels")
        # Legacy label-only replays have no receipt. When a receipt exists,
        # failure to judge is an abstention, never a correct 'uncertain' label.
        status = row.get("status", "evaluated")
        statuses[status] += 1
        if status != "evaluated":
            abstentions[expected] += 1
            continue
        confusion[expected][predicted] += 1
    classes = {}
    for label in LABELS:
        true_positive = confusion[label][label]
        actual = sum(confusion[label].values()) + abstentions[label]
        predicted = sum(values[label] for values in confusion.values())
        classes[label] = {
            "support": actual,
            "precision": true_positive / predicted if predicted else None,
            "recall": true_positive / actual if actual else None,
        }
    return {"count": len(rows), "confusion": confusion, "classes": classes,
            "evaluated_count": statuses["evaluated"],
            "abstention_count": sum(abstentions.values()),
            "abstentions_by_expected_class": dict(abstentions),
            "evaluation_statuses": dict(statuses)}


def grouping_metrics(expected, predicted):
    if set(expected) != set(predicted):
        raise ValueError("Grouping predictions must cover exactly the labeled document IDs")
    choose2 = lambda n: n * (n - 1) // 2  # noqa: E731
    actual = Counter(expected.values())
    guessed = Counter(predicted.values())
    intersection = Counter((expected[identity], predicted[identity]) for identity in expected)
    true_positive = sum(choose2(n) for n in intersection.values())
    actual_pairs = sum(choose2(n) for n in actual.values())
    guessed_pairs = sum(choose2(n) for label, n in guessed.items() if label)
    # Unfiled is absence of an assignment, never evidence that two items belong together.
    true_positive -= sum(choose2(n) for (_, label), n in intersection.items() if not label)
    return {
        "documents": len(expected),
        "pairwise_precision": true_positive / guessed_pairs if guessed_pairs else None,
        "pairwise_recall": true_positive / actual_pairs if actual_pairs else None,
        "singleton_document_rate": sum(n for label, n in guessed.items() if label and n == 1)
        / len(expected)
        if expected
        else None,
        "unfiled_rate": guessed.get("", 0) / len(expected) if expected else None,
        "true_positive_pairs": true_positive,
        "predicted_pairs": guessed_pairs,
        "expected_pairs": actual_pairs,
    }


def grouping_stability(first, second):
    """Compare co-membership rather than exact folder strings across shuffled runs."""
    if set(first) != set(second):
        raise ValueError("Stability runs must cover the same document IDs")
    # Unfiled identities are separate singletons for comparison.
    first = {k: v or ("unfiled", k) for k, v in first.items()}
    second = {k: v or ("unfiled", k) for k, v in second.items()}
    pair = lambda n: n * (n - 1) // 2  # noqa: E731
    a, b = Counter(first.values()), Counter(second.values())
    overlap = Counter((first[k], second[k]) for k in first)
    total = pair(len(first))
    disagreements = (
        sum(pair(n) for n in a.values())
        + sum(pair(n) for n in b.values())
        - 2 * sum(pair(n) for n in overlap.values())
    )
    return {"pairs": total, "pair_agreement": 1 - disagreements / total if total else None}


def premise_metrics(rows):
    """Score accepted decisions, never count a possible correction as success."""
    def accepted(row):
        return row["judgment"].get("status") == "evaluated" and bool(
            row["judgment"].get("conflicting_chunk_ids")
        )

    positives = sum(r["expected_correction"] for r in rows)
    negatives = len(rows) - positives
    accepted_count = sum(accepted(r) for r in rows)
    true_positive = sum(
        r["expected_correction"] and accepted(r) for r in rows
    )
    false_positive = accepted_count - true_positive
    refs, valid = 0, 0
    for row in rows:
        j = row["judgment"]
        supplied = {r["chunk_id"] for r in j.get("evaluated_evidence", [])}
        for key in (
            "supporting_chunk_ids",
            "conflicting_chunk_ids",
            "possible_conflicting_chunk_ids",
            "disagreement_chunk_ids",
        ):
            for ref in j.get(key, []):
                refs += 1
                valid += ref in supplied
    return {
        "count": len(rows),
        "positive_cases": positives,
        "negative_cases": negatives,
        "accepted_corrections": accepted_count,
        "true_positive_corrections": true_positive,
        "false_corrections": false_positive,
        "accepted_correction_recall": true_positive / positives if positives else None,
        "false_conflict_rate": false_positive / negatives if negatives else None,
        "abstentions": sum(
            r["expected_correction"] and not accepted(r)
            for r in rows
        ),
        "possible_only": sum(
            r["judgment"].get("status") == "evaluated"
            and not r["judgment"].get("conflicting_chunk_ids")
            and bool(r["judgment"].get("possible_conflicting_chunk_ids"))
            for r in rows
        ),
        "unavailable": sum(r["judgment"].get("status") != "evaluated" for r in rows),
        "reference_occurrences": refs,
        "valid_reference_occurrences": valid,
        "evidence_id_correctness": valid / refs if refs else None,
        "expected_support_cases": sum(r.get("expected_support", False) for r in rows),
        "accepted_expected_support": sum(
            r.get("expected_support", False) and bool(r["judgment"].get("supporting_chunk_ids"))
            for r in rows
        ),
        "false_support_cases": sum(
            not r.get("expected_support", False) and bool(r["judgment"].get("supporting_chunk_ids"))
            for r in rows
            if "expected_support" in r
        ),
        "unknown_coverage": sum(r["judgment"].get("coverage") == "unknown" for r in rows),
        "disagreement_cases": sum(r.get("expected_disagreement", False) for r in rows),
        "accepted_expected_disagreements": sum(
            r.get("expected_disagreement", False)
            and r["judgment"].get("status") == "evaluated"
            and r["judgment"].get("evidence_disagreement") == "accepted"
            for r in rows
        ),
        "false_disagreement_cases": sum(
            not r["expected_disagreement"]
            and r["judgment"].get("evidence_disagreement") == "accepted"
            for r in rows if "expected_disagreement" in r
        ),
        "possible_disagreements": sum(
            r["judgment"].get("evidence_disagreement") == "possible" for r in rows
        ),
    }
