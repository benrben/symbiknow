import pytest
from symbiknow.search.evaluation import answerability_metrics, grouping_metrics, grouping_stability


def test_per_class_metrics_include_unrelated_and_missing_class_support():
    metrics = answerability_metrics(
        [
            {"expected": "partial", "predicted": "partial"},
            {"expected": "unrelated", "predicted": "related"},
        ]
    )
    assert metrics["classes"]["partial"] == {"support": 1, "precision": 1, "recall": 1}
    assert metrics["classes"]["unrelated"]["recall"] == 0
    assert metrics["classes"]["direct"]["recall"] is None
    with pytest.raises(ValueError):
        answerability_metrics([{"expected": "unrelated", "predicted": "invented"}])


def test_unavailable_uncertain_prediction_is_an_abstention_not_a_correct_label():
    metrics = answerability_metrics([
        {"expected": "uncertain", "predicted": "uncertain", "status": "unavailable"},
        {"expected": "direct", "predicted": "uncertain", "status": "not_evaluated"},
        {"expected": "uncertain", "predicted": "uncertain", "status": "evaluated"},
    ])
    assert metrics["count"] == 3 and metrics["evaluated_count"] == 1
    assert metrics["abstention_count"] == 2
    assert metrics["evaluation_statuses"] == {"unavailable": 1, "not_evaluated": 1, "evaluated": 1}
    assert metrics["classes"]["uncertain"] == {"support": 2, "precision": 1, "recall": .5}
    assert metrics["classes"]["direct"] == {"support": 1, "precision": None, "recall": 0}
    assert metrics["confusion"]["uncertain"]["uncertain"] == 1


def test_pairwise_grouping_penalizes_cross_project_merges_and_fragmentation():
    gold = {"a": "one", "b": "one", "c": "two", "d": "two"}
    assert (
        grouping_metrics(gold, {"a": "Renamed", "b": "Renamed", "c": "Other", "d": "Other"})[
            "pairwise_recall"
        ]
        == 1
    )
    assert grouping_metrics(gold, dict.fromkeys(gold, "Mixed"))[
        "pairwise_precision"
    ] == pytest.approx(1 / 3)
    fragmented = grouping_metrics(gold, {k: k for k in gold})
    assert fragmented["pairwise_recall"] == 0 and fragmented["singleton_document_rate"] == 1
    assert grouping_metrics(gold, dict.fromkeys(gold, ""))["pairwise_recall"] == 0
    with pytest.raises(ValueError):
        grouping_metrics(gold, {"a": "one"})


def test_shuffle_stability_ignores_names_but_detects_pair_assignment_changes():
    a = {"x": "One", "y": "One", "z": "Two"}
    assert grouping_stability(a, {"x": "Uno", "y": "Uno", "z": "Dos"})["pair_agreement"] == 1
    assert grouping_stability(a, {"x": "Uno", "y": "Dos", "z": "Dos"})[
        "pair_agreement"
    ] == pytest.approx(1 / 3)
    assert grouping_stability({"x": "", "y": ""}, {"x": "A", "y": "B"})["pair_agreement"] == 1


def test_premise_scores_keep_abstentions_and_reference_errors_separate():
    from symbiknow.search.evaluation import premise_metrics

    rows = [
        {
            "expected_correction": True,
            "judgment": {
                "status": "evaluated",
                "conflicting_chunk_ids": ["known"],
                "evaluated_evidence": [{"chunk_id": "known"}],
            },
        },
        {
            "expected_correction": True,
            "judgment": {
                "status": "evaluated",
                "possible_conflicting_chunk_ids": ["known"],
                "evaluated_evidence": [{"chunk_id": "known"}],
            },
        },
        {
            "expected_correction": False,
            "judgment": {
                "status": "evaluated",
                "conflicting_chunk_ids": ["invented"],
                "evaluated_evidence": [],
            },
        },
    ]
    m = premise_metrics(rows)
    assert m["accepted_correction_recall"] == 0.5
    assert m["false_conflict_rate"] == 1
    assert m["abstentions"] == m["possible_only"] == 1
    assert m["valid_reference_occurrences"] == 2 and m["reference_occurrences"] == 3


def test_failed_provider_and_possible_disagreement_are_not_accepted_successes():
    from symbiknow.search.evaluation import premise_metrics
    m = premise_metrics([
        {"expected_correction": True, "expected_disagreement": True,
         "judgment": {"status": "unavailable", "conflicting_chunk_ids": ["a"],
                      "evidence_disagreement": "accepted"}},
        {"expected_correction": False, "expected_disagreement": True,
         "judgment": {"status": "evaluated", "evidence_disagreement": "possible",
                      "coverage": "unknown"}},
    ])
    assert m["accepted_corrections"] == m["accepted_expected_disagreements"] == 0
    assert m["abstentions"] == m["unavailable"] == m["unknown_coverage"] == 1
    assert m["disagreement_cases"] == 2 and m["possible_disagreements"] == 1


def test_evaluator_cli_preserves_legacy_label_replay_and_raw_judgments(tmp_path):
    import json
    from pathlib import Path
    import subprocess
    import sys

    corpus = {
        "provenance": {"annotator": "test-author", "split": "regression", "independent": False},
        "answerability": [
            {
                "id": "c",
                "question": "Q",
                "documents": [
                    {
                        "document_id": "d",
                        "version": "v1",
                        "expected_label": "related",
                        "expected_correction": True,
                    }
                ],
            }
        ],
    }
    predictions = {"answerability": {"c": {"d": "related"}}, "grouping": {}}
    c, p, output = [tmp_path / name for name in ["corpus.json", "pred.json", "out.json"]]
    c.write_text(json.dumps(corpus))
    for raw in [False, True]:
        if raw:
            predictions["judgments"] = {
                "c": {
                    "status": "evaluated",
                    "matches": [
                        {
                            "document_id": "d",
                            "jev": {
                                "status": "evaluated",
                                "policy_version": "pinned",
                                "conflicting_chunk_ids": ["d:v1:t0"],
                                "evaluated_evidence": [{"chunk_id": "d:v1:t0"}],
                            },
                        }
                    ],
                }
            }
        p.write_text(json.dumps(predictions))
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[3] / "scripts/evaluation/jev.py"),
                "--corpus",
                str(c),
                "--predictions",
                str(p),
                "--output",
                str(output),
            ],
            check=True,
            capture_output=True,
            timeout=10,
        )
        report = json.loads(output.read_text())
        assert report["answerability"]["classes"]["related"]["recall"] == 1
        assert report["premise"]["accepted_correction_recall"] == (1 if raw else 0)
        if raw:
            assert (
                report["predictions"]["judgments"]["c"]["matches"][0]["jev"]["policy_version"]
                == "pinned"
            )


def test_evaluator_cli_counts_provider_failure_against_uncertain_gold(tmp_path):
    import json
    from pathlib import Path
    import subprocess
    import sys

    corpus = {
        "provenance": {"annotator": "test-author", "split": "regression", "independent": False},
        "answerability": [{"id": "c", "question": "Q", "documents": [
            {"document_id": "d", "version": "v1", "expected_label": "uncertain"},
        ]}],
    }
    predictions = {
        "answerability": {"c": {"d": "uncertain"}}, "grouping": {},
        "judgments": {"c": {"status": "unavailable", "matches": [
            {"document_id": "d", "jev": {"status": "unavailable", "reason": "provider_unavailable"}},
        ]}},
    }
    source, saved, output = [tmp_path / name for name in ("corpus.json", "predictions.json", "report.json")]
    source.write_text(json.dumps(corpus))
    saved.write_text(json.dumps(predictions))
    subprocess.run([
        sys.executable, str(Path(__file__).resolve().parents[3] / "scripts/evaluation/jev.py"),
        "--corpus", str(source), "--predictions", str(saved), "--output", str(output),
    ], check=True, capture_output=True, timeout=10)
    metrics = json.loads(output.read_text())["answerability"]
    assert metrics["count"] == metrics["abstention_count"] == 1
    assert metrics["evaluated_count"] == metrics["confusion"]["uncertain"]["uncertain"] == 0
    assert metrics["classes"]["uncertain"] == {"support": 1, "precision": None, "recall": 0}
    assert metrics["evaluation_statuses"] == {"unavailable": 1}
