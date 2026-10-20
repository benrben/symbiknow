"""Warm document/scoped reuse agrees with full feature recomputation after changes."""
from copy import deepcopy

import pytest

from symbiknow.organization import policy as organization


def clear_features():
    for cache in (organization._ANALYSIS, organization._CORPUS):
        with cache.lock:
            cache.values.clear()


@pytest.mark.parametrize("change", ["source", "catalog", "common_lines", "corpus"])
def test_warm_document_and_scoped_features_match_cache_cleared_recomputation(monkeypatch, change):
    notice = "Archival retention authorization classification compliance distribution governance confidentiality notice"
    evidence = [
        {"evidence_id": "atlas:v1:t0", "text": "Atlas Labs builds bounded retrieval.", "basis": "text",
         "provenance": {"headings": ["Atlas Labs / Search / Design"]}},
        {"evidence_id": "atlas:v1:t1", "text": notice, "basis": "text"},
        {"evidence_id": "atlas:v1:t2", "text": "Documentalpha preserves original integrity.", "basis": "text"},
        {"evidence_id": "atlas:v1:t3", "text": "Documentbeta retrieves vectors with bounded cache memory.", "basis": "text"},
    ]
    profiles = {
        "atlas-one": [{"text": "Atlas Labs preserves bounded retrieval and indexes original document text.", "basis": "text"}],
        "atlas-two": [{"text": "Atlas Labs retrieves document evidence through bounded indexes.", "basis": "text"}],
        "cedar-one": [{"text": "Cedar Labs accounts for employee invoices and payment balances.", "basis": "text"}],
        "cedar-two": [{"text": "Cedar Labs retains invoice payment balances for employees.", "basis": "text"}],
    }
    projects, common = organization.ProjectNames(["Atlas Labs", "Cedar Labs"]), ()
    computed_scopes = []
    cluster = organization._topic_clusters
    def measured(documents, scope):
        computed_scopes.append(scope)
        return cluster(documents, scope)
    monkeypatch.setattr(organization, "_topic_clusters", measured)

    def features():
        return {
            "paths": organization.topic_paths(evidence, projects),
            "heading_projects": organization.heading_projects(evidence),
            "project": organization.project_scope(evidence, projects),
            "representatives": organization.representative_evidence(evidence, common, limit=2),
            "common": organization.common_lines(profiles),
            "generated": organization.prose_paths(profiles, common),
            "vocabulary": organization.shared_vocabulary(profiles, common=common)[0],
        }

    clear_features()
    before = features()
    assert set(computed_scopes) == {"Atlas Labs", "Cedar Labs"}
    computed_scopes.clear()
    computations = organization._ANALYSIS.stats()["computations"]
    assert features() == before
    assert not computed_scopes
    assert organization._ANALYSIS.stats()["computations"] == computations

    if change == "source":
        evidence[0] = {**evidence[0], "text": evidence[0]["text"] + " Updated extraction detail.",
                       "provenance": {"headings": ["Atlas Labs / Access / Design"]}}
        profiles["atlas-two"][0]["text"] += " Updated extraction adds retention semantics."
    elif change == "catalog":
        projects = organization.ProjectNames(["ATLAS LABS", "Cedar Labs"])
    elif change == "common_lines":
        common = (notice,)
    else:
        profiles["atlas-three"] = [{"text": "Atlas Labs checks retrieval indexes for evidence integrity.", "basis": "text"}]

    warm = features()
    assert organization._ANALYSIS.stats()["computations"] > computations
    # Reuse is scoped: only changed Atlas text/membership recomputes clustering;
    # catalog/common-line inputs here do not change either scope's clustered text.
    assert computed_scopes == (["Atlas Labs"] if change in {"source", "corpus"} else [])
    if change == "source":
        assert warm["paths"] != before["paths"]
    elif change == "catalog":
        assert warm["project"] != before["project"]
    elif change == "common_lines":
        assert warm["representatives"] != before["representatives"]
    else:
        assert "atlas-three" in warm["generated"]

    retained = deepcopy(warm)
    clear_features()
    computed_scopes.clear()
    assert features() == retained
    assert set(computed_scopes) == {"Atlas Labs", "Cedar Labs"}
