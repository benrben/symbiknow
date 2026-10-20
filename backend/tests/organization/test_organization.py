"""Ordinary-prose candidate regressions; these are not hosted-model quality claims."""

from pathlib import Path
import random
import pytest

from symbiknow.organization.policy import clean_text, prose_paths, rank_names, representative_evidence, shared_vocabulary

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ordinary-prose"


@pytest.mark.parametrize("project", ["Symbiknow", "Cedar Shop", "acme", "נאקר"])
@pytest.mark.parametrize("separator", ["—", "–", "-"])
def test_branded_root_title_discovers_owner_before_incidental_topics(project, separator):
    from symbiknow.organization.policy import heading_projects, project_candidates, project_scope

    title = f"{project} {separator} Run the app locally"
    rows = [{
        "evidence_id": "guide:v1:t0",
        "text": f"{title}\nMCP serves the library. Organization publishes folder assignments.",
        "basis": "text",
        "provenance": {"headings": [title]},
    }]
    roster = [{"id": name, "name": name, "aliases": []} for name in ("MCP", "Organization")]
    assert heading_projects(rows) == {project}
    assert project_scope(rows) == project
    # A known incidental topic must not consume the only available owner slot.
    assert project_candidates(rows, ["MCP", "Organization"], roster, limit=1) == [project]


def test_explicit_root_title_precedes_body_path_examples():
    from symbiknow.organization.policy import heading_projects, project_scope, topic_paths

    rows = [{
        "text": '# Cedar Shop — Store files\nOther / Storage / Example\n" / "',
        "basis": "text",
    }]
    assert heading_projects(rows) == {"Cedar Shop"}
    assert project_scope(rows) == "Cedar Shop"
    assert topic_paths(rows) == ["Other / Storage"]
    assert topic_paths([{"text": '" / "\n/ / /'}]) == []


def test_title_hints_and_generic_section_headings_are_not_project_titles():
    from symbiknow.organization.policy import heading_projects

    for row in [
        {"text": "Cedar Shop — Manual.md", "basis": "title"},
        {"text": "Reference to Cedar Shop — Store files in ordinary prose."},
        {"text": "# User guide — Store files"},
        {"text": "Store files", "provenance": {"headings": ["Introduction", "Cedar Shop — Store files"]}},
    ]:
        assert heading_projects([row]) == set()


def profiles():
    return {
        path.name: [
            {"evidence_id": path.name, "text": path.read_text(), "basis": "text", "provenance": {}}
        ]
        for path in sorted(FIXTURES.glob("*.txt"))
    }


def test_unstructured_topics_and_project_scope_survive_shuffle_and_renamed_entities():
    source = profiles()
    for project, garden in [("Vela Labs", "Oak Garden"), ("Aster Works", "Harbor Garden")]:
        transformed = {
            identity: [
                {
                    **row,
                    "text": row["text"].replace("Vela Labs", project).replace("Oak Garden", garden),
                }
                for row in rows
            ]
            for identity, rows in source.items()
        }
        expected = {
            f"QA-R3-{i:02}.txt": folder
            for i, folder in enumerate(
                [
                    f"{project} / Billing",
                    f"{project} / Billing",
                    f"{project} / Employee access",
                    f"{project} / Employee access",
                    f"{garden} / Rosemary",
                    f"{garden} / Rosemary",
                ],
                1,
            )
        }
        for seed in range(4):
            items = list(transformed.items())
            random.Random(seed).shuffle(items)
            assert prose_paths(dict(items)) == expected
            vocabulary, common = shared_vocabulary(
                dict(items), groups=["Fictional Test", "Policy", "Access"]
            )
            assert set(vocabulary["folders"]) == set(expected.values())
            assert vocabulary["groups"] == ["Access"]
            for identity, evidence in transformed.items():
                assert (
                    rank_names([*vocabulary["folders"], "Other Company / Billing"], evidence)[0]
                    == expected[identity]
                )
                assert prose_paths({identity: evidence})[identity] == expected[identity]
                assert (
                    "fictional" not in representative_evidence(evidence, common)[0]["text"].lower()
                )


def test_boilerplate_removed_from_opening_middle_and_closing_without_changing_source():
    text = (
        "Synthetic QA fixture.\n# Atlas / Search / Design\nHybrid retrieval combines keywords and meaning. "
        "This is a fictional test procedure.\nExact identifiers stay searchable."
    )
    row = {"evidence_id": "d:v1:t2", "text": text, "basis": "text", "provenance": {"page": 2}}
    cleaned = representative_evidence([row])[0]
    assert "synthetic" not in cleaned["text"].lower() and "fictional" not in cleaned["text"].lower()
    assert "Hybrid retrieval" in cleaned["text"] and "Exact identifiers" in cleaned["text"]
    assert (
        cleaned["evidence_id"] == row["evidence_id"] and cleaned["provenance"] == row["provenance"]
    )
    assert row["text"] == text
    assert (
        clean_text("A current billing policy governs refunds.")
        == "A current billing policy governs refunds."
    )


def test_batch_review_retains_repeated_project_headers_and_policy_evidence():
    from symbiknow.organization.policy import common_lines

    header = "ATLAS / IMPLEMENTATION DIAGRAM / 13 OCT 2026"
    policy = "Atlas reset preserves version history."
    source = {
        str(i): [
            {
                "evidence_id": f"{i}:v1:t0",
                "text": header,
                "basis": "ocr",
                "provenance": {"page": 1},
            },
            {"evidence_id": f"{i}:v1:t1", "text": f"Diagram number {i}.", "basis": "ocr"},
            {"evidence_id": f"{i}:v1:t2", "text": policy, "basis": "ocr"},
        ]
        for i in range(3)
    }
    common = common_lines(source)
    assert header.casefold() in common and policy.casefold() in common
    for evidence in source.values():
        selected = representative_evidence(evidence, common)
        assert selected[0] == evidence[0]
        assert any(row["text"] == policy for row in selected)


def test_existing_subject_headings_and_new_project_do_not_share_project_folders():
    source = profiles()
    source["existing"] = [
        {
            "evidence_id": "existing",
            "text": "# Cedar Shop / Billing / Invoices\nCorrect retail invoices with receipts.",
        }
    ]
    vocabulary, _ = shared_vocabulary(source)
    assert "Cedar Shop / Billing" in vocabulary["folders"]
    choices = rank_names(vocabulary["folders"], source["QA-R3-02.txt"])
    assert choices == ["Vela Labs / Billing", "Vela Labs / Employee access"]


def review_profiles():
    return {
        path.name: [{"evidence_id": path.name, "text": path.read_text(), "basis": "text"}]
        for path in sorted((FIXTURES.parent / "review-4").glob("*.txt"))
    }


def test_single_word_entities_keep_distinct_topics_and_exclude_other_companies():
    from symbiknow.organization.policy import project_scope

    for name in ("Nacre", "Oriole", "Kestrel"):
        source = {
            key: [{**row, "text": row["text"].replace("Nacre", name)} for row in rows]
            for key, rows in {**profiles(), **review_profiles()}.items()
        }
        expected = [f"{name} / Commerce"] * 2 + [f"{name} / Employee access"] * 2
        for seed in range(3):
            items = list(source.items())
            random.Random(seed).shuffle(items)
            generated = prose_paths(dict(items))
            assert [generated[f"QA-R4-{i:02}.txt"] for i in range(1, 5)] == expected
            vocabulary, _ = shared_vocabulary(dict(items))
            for i, folder in enumerate(expected, 1):
                rows = source[f"QA-R4-{i:02}.txt"]
                assert project_scope(rows) == name
                assert rank_names(vocabulary["folders"], rows)[0] == folder
                assert all(
                    path.startswith(name + " / ")
                    for path in rank_names(vocabulary["folders"], rows)
                )
        cross_reference = [
            {"text": f"{name} disables employee accounts. Vela Labs uses a similar process."}
        ]
        assert project_scope(cross_reference, ["Vela Labs"]) == name
        assert rank_names(["Vela Labs / Employee access"], cross_reference) == []
    assert (
        rank_names(["Vela Labs / Employee access"], [{"text": "disable accounts after departure"}])
        == []
    )


def test_ocr_possessive_alias_uses_established_root_without_editing_evidence(tmp_path):
    from copy import deepcopy
    from symbiknow.organization.policy import embedding_candidates, project_scope

    text = [
        {
            "text": "# Atlas / Search / Design\nHybrid retrieval combines keywords and vectors.",
            "basis": "text",
        }
    ]
    ocr = [
        {
            "evidence_id": "flow:v1:ocr",
            "basis": "ocr",
            "text": "Atlas s / Search / F Retrieval f flow",
            "provenance": {"pages": [1]},
        }
    ]
    original = deepcopy(ocr)
    vocabulary, _ = shared_vocabulary({"design": text, "flow": ocr})
    assert vocabulary["folders"] == ["Atlas / Search"]
    assert project_scope(ocr, ["Atlas"]) == "Atlas"
    assert rank_names(vocabulary["folders"], ocr) == ["Atlas / Search"]
    assert embedding_candidates(tmp_path, {"flow": ocr}, vocabulary)["flow"] == ["Atlas / Search"]
    assert shared_vocabulary({"flow": ocr}, folders=["Atlas / Search"])[0] == vocabulary
    assert ocr == original
    # No established match, text authored by a person, or distinct capital S:
    for rows, known, root in (
        (ocr, [], "Atlas s"),
        (ocr, ["Atlas", "Atlas s"], "Atlas s"),
        ([{**ocr[0], "basis": "text"}], ["Atlas"], "Atlas s"),
        ([{**ocr[0], "text": "Atlas S / Search / Flow"}], ["Atlas"], "Atlas S"),
    ):
        assert project_scope(rows, known) == root


def test_large_unscoped_preparation_never_densifies_document_feature_matrix(monkeypatch):
    from scipy.sparse import csr_matrix
    from symbiknow.organization.policy import TOPIC_BUDGET

    original = csr_matrix.toarray

    def bounded_dense(matrix, *args, **kwargs):
        assert not (matrix.shape[0] > TOPIC_BUDGET and matrix.shape[1] > TOPIC_BUDGET), matrix.shape
        return original(matrix, *args, **kwargs)

    monkeypatch.setattr(csr_matrix, "toarray", bounded_dense)
    rng = random.Random(4)
    source = {
        str(i): [
            {
                "text": "refund orders undergo warehouse inspection. reference "
                + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)),
                "evidence_id": str(i),
            }
        ]
        for i in range(TOPIC_BUDGET * 4 + 1)
    }
    assigned = prose_paths(source)
    assert set(assigned) == set(source)
    assert all(" / " not in name for name in assigned.values())


def test_sentence_paths_cross_project_ownership_and_readable_unicode():
    from symbiknow.organization.policy import topic_paths, project_scope, _subject

    for text in [
        "Use refunds / invoices when a charge is wrong.",
        "https://host/path / documents",
        "We must reset / rebuild the library",
        "read backend/symbiknow/api/mcp.py / apply fixes",
    ]:
        assert topic_paths([{"text": text}]) == []
    assert topic_paths([{"text": "# נאקר / חיובים / החזרים"}]) == ["נאקר / חיובים"]
    evidence = [
        {
            "text": "Unlike Vela Labs, Nacre refunds invoices. Nacre billing owns the workflow. Nacre checks receipts."
        }
    ]
    assert project_scope(evidence, ["Vela Labs", "Nacre"]) == "Nacre"
    assert _subject(["תהליכי חיוב החזרים תהליכי חיוב"], "נאקר")
    assert _subject(["Processes govern storage processes."], "") != "Processe"


def test_isolated_project_details_offer_parent_without_imperative_labels():
    from symbiknow.organization.policy import project_scope

    source = {
        "x": [
            {
                "text": "Oriole keeps a freight ledger for overseas shipments. Match the receipt before paying.",
                "evidence_id": "x:v1:0",
            }
        ],
        "y": [
            {
                "text": "Oriole revokes departing employees' credentials on their final shift.",
                "evidence_id": "y:v1:0",
            }
        ],
    }
    assert prose_paths(source) == {"x": "Oriole", "y": "Oriole"}
    candidates, _ = shared_vocabulary(source)
    assert candidates["folders"] == ["Oriole"]
    assert project_scope(source["x"]) == "Oriole"
    assert rank_names(
        ["Oriole", "Oriole / Match", "Oriole / Freight", "Other / Freight"], source["x"]
    ) == ["Oriole / Freight", "Oriole"]
