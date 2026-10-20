#!/usr/bin/env python3
"""Isolated catalog cold/hit/identity costs; no originals, models or providers.

Run separately from capacity/model measurements. max_rss_bytes includes fixture
creation; retained_bytes is the shared cache's owned Python-object accounting.
"""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import platform
import resource
import statistics
import sys
import tempfile
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from symbiknow.organization.policy import project_candidates, project_identity  # noqa: E402
from symbiknow.organization.store import catalog, _catalog_reference, _CATALOG_CACHE  # noqa: E402


def run(count, trials):
    with tempfile.TemporaryDirectory(prefix="symbiknow-catalog-") as temporary:
        root = Path(temporary)
        projects = [project_identity(f"Atlas {i:06d}") for i in range(count)]
        for i, project in enumerate(projects):
            project["aliases"] = [f"Alias {i:06d}"]
        expected = projects[-1]["id"]
        reference = _catalog_reference(root, {}, {item["id"]: item for item in projects})
        del projects
        gc.collect()
        publication = {"catalog": reference}
        with _CATALOG_CACHE.lock:
            _CATALOG_CACHE.values.clear()
        started = perf_counter()
        roster = catalog(root, publication)
        cold_ms = (perf_counter() - started) * 1000
        hits, lookups = [], []
        for _ in range(trials):
            started = perf_counter()
            assert catalog(root, publication) is roster
            hits.append((perf_counter() - started) * 1000)
            started = perf_counter()
            assert project_identity(f"Alias {count - 1:06d}", roster)["id"] == expected
            lookups.append((perf_counter() - started) * 1000)
        started = perf_counter()
        candidates = project_candidates(
            [{"text": f"Alias {count - 1:06d} owns the search workflow", "basis": "text"}], projects=roster)
        candidate_ms = (perf_counter() - started) * 1000
        assert f"Atlas {count - 1:06d}" in candidates and len(candidates) <= 16
        candidate_hits, matching = [], []
        evidence = [{"text": f"Alias {count - 1:06d} owns the search workflow", "basis": "text"}]
        for _ in range(trials):
            started = perf_counter()
            assert project_candidates(evidence, projects=roster) == candidates
            candidate_hits.append((perf_counter() - started) * 1000)
            started = perf_counter()
            assert roster.matcher.find(evidence[0]["text"]) == {f"Atlas {count - 1:06d}"}
            matching.append((perf_counter() - started) * 1000)
        retained = _CATALOG_CACHE.stats()
        # Exact precedence remains the existing public policy: first matching
        # record for identity lookup; last matching alias for candidate hypotheses.
        source = [{"id": "first", "name": "Atlas", "aliases": ["Shared"]},
                  {"id": "last", "name": "Cedar", "aliases": ["Shared"]}]
        from symbiknow.organization.store import ProjectCatalog
        indexed = ProjectCatalog(source)
        evidence = [{"text": "Shared owns the search workflow", "basis": "text"}]
        assert project_identity("Shared", indexed)["id"] == "first"
        assert project_candidates(evidence, projects=indexed) == project_candidates(evidence, projects=source)
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {"projects": count, "aliases": count, "trials": trials, "cold_ms": cold_ms,
                "hit_p50_ms": statistics.median(hits), "hit_max_ms": max(hits),
                "identity_p50_ms": statistics.median(lookups), "identity_max_ms": max(lookups),
                "candidate_ms": candidate_ms,
                "candidate_hit_p50_ms": statistics.median(candidate_hits), "candidate_hit_max_ms": max(candidate_hits),
                "matcher_p50_ms": statistics.median(matching), "matcher_max_ms": max(matching),
                "matching_policy": "Compact Aho-Corasick transitions; no per-document alias scan; exact re.I/boundary parity",
                "pattern_characters": sum(len(alias) for alias in roster.canonical_names),
                "matching_states": len(roster.matcher._fail),
                "retained_bytes": retained["bytes"], "cache_entries": retained["entries"],
                "cache_budget_bytes": _CATALOG_CACHE.values.max_bytes,
                "artifact_bytes": (root / "temp/organization-catalogs" / reference).stat().st_size,
                "max_rss_bytes_including_setup": peak if sys.platform == "darwin" else peak * 1024,
                "alias_precedence_parity": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--projects", type=int, nargs="+", default=[1000, 10000, 100000])
    parser.add_argument("--trials", type=int, default=100)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if min(args.projects) < 1 or args.trials < 1:
        parser.error("projects and trials must be positive")
    result = {"kind": "isolated-organization-catalog", "python": sys.version,
              "platform": platform.platform(), "memory_note": __doc__.strip(),
              "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                 for name in ("backend/symbiknow/organization/store.py", "backend/symbiknow/organization/policy.py", "backend/symbiknow/organization/matcher.py", "backend/symbiknow/core/cache.py")},
              "samples": [run(count, args.trials) for count in args.projects]}
    content = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content)
    print(content, end="")


if __name__ == "__main__":
    main()
