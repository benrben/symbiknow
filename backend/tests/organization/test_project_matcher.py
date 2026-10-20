"""Indexed recognition retains the previous Unicode regex candidate policy."""
import random
import re

import pytest

from symbiknow.organization.policy import project_candidates
from symbiknow.organization.store import ProjectCatalog
from symbiknow.organization.matcher import ProjectMatcher


def reference(canonical, text):
    return {name for alias, name in canonical.items()
            if re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text, re.I)}


@pytest.mark.parametrize("text", [
    "Atlas Search and Atlas, plus Search. AtlasSearch _Atlas Atlas_ 2Atlas Atlas2",
    "İ ı I i S ſ s K K k Σ ς σ Θ ϑ θ Β ϐ β Μ µ μ",
    "Straße STRASSE STRAẞE ﬀ ff FFI ﬃ Café CAFÉ Café",
    "אבגד Atlas / Search שלום 中文 ١٢३_Atlas_ ½Atlas ²Atlas",
    "a.b (a.b) a+b [x] \\a a-b A-B x / y x\ny (x) !",
    "", " ", "! !", "\n\n", "a", "aa aaa aaaa",
])
def test_overlaps_boundaries_unicode_and_empty_alias_match_previous_regex(text):
    aliases = ["Atlas", "Atlas Search", "Search", "i", "ı", "s", "ſ", "k", "K", "Σ", "ς",
               "Θ", "ϑ", "Β", "ϐ", "Μ", "µ", "Straße", "strasse", "ﬀ", "ffi", "Café", "Café",
               "אבגד", "שלום", "中文", "a.b", "a+b", "[x]", "\\a", "a-b", "x / y", "x\ny", "!", "", "aa", "aaa"]
    canonical = {alias.casefold(): alias for alias in aliases}
    assert ProjectMatcher(canonical).find(text) == reference(canonical, text)


def test_randomized_unicode_alias_recognition_matches_regex_reference():
    randomizer = random.Random(739)
    alphabet = "aAbBiIİıſsSKkKßẞΣςσΘϑθΒϐβµΜμéÉ中_012٣²́-. /()"
    for _ in range(100):
        aliases = ["".join(randomizer.choices(alphabet, k=randomizer.randint(1, 7))) for _ in range(40)]
        canonical = {alias.casefold(): str(index) for index, alias in enumerate(aliases)}
        text = " ".join([*randomizer.sample(aliases, 10), "".join(randomizer.choices(alphabet, k=150))])
        assert ProjectMatcher(canonical).find(text) == reference(canonical, text)


def test_complete_candidate_output_and_alias_precedence_match_reference(monkeypatch):
    projects = [{"id": "one", "name": "Atlas", "aliases": ["Shared", "Atlas Search", "İdea"]},
                {"id": "two", "name": "Cedar", "aliases": ["Shared", "C++", "ς"]},
                {"id": "three", "name": "Birch", "aliases": ["Search", "Kit"]}]
    catalog = ProjectCatalog(projects)
    evidence = [{"text": "Shared Atlas Search", "basis": "title"},
                {"text": "IDEA and C++ own this workflow. kit compares Σ against Atlas Search.", "basis": "text",
                 "provenance": {"headings": ["Atlas / Search / Notes"]}}]
    actual = project_candidates(evidence, projects=catalog)
    monkeypatch.setattr(ProjectMatcher, "find", lambda self, text: reference(catalog.canonical_names, text))
    assert actual == project_candidates(evidence, projects=catalog)
    assert "Cedar" in actual  # Shared alias still belongs to the last catalog record.


def test_indexed_recognition_never_iterates_catalog_per_document():
    catalog = ProjectCatalog([{"id": str(index), "name": f"Atlas {index}", "aliases": [f"Alias {index}"]}
                              for index in range(1000)])
    class LookupOnly(dict):
        def __iter__(self):
            raise AssertionError("per-document catalog iteration")
        def items(self):
            raise AssertionError("per-document catalog iteration")
        def values(self):
            raise AssertionError("per-document catalog iteration")
    catalog.canonical_names = LookupOnly(catalog.canonical_names)
    evidence = [{"text": "Alias 999 owns this workflow.", "basis": "text"}]
    assert "Atlas 999" in project_candidates(evidence, projects=catalog)
