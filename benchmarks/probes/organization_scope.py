#!/usr/bin/env python3
"""Profile broad organization scopes on an existing capacity fixture, without original writes.

Uses current publication, evidence epochs and manual placement. Full Library
profiles require an existing library identity so progress performs no setup write.
Run separately from ingestion/GPU/other CPU benchmarks.
"""
import argparse
import cProfile
import hashlib
import io
import json
from pathlib import Path
import platform
import pstats
import resource
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from symbiknow.organization import store as organization_store  # noqa: E402
from symbiknow.search import index as search  # noqa: E402
from symbiknow.core.application import ApplicationContext  # noqa: E402


def measured(function):
    profile = cProfile.Profile()
    started = perf_counter()
    profile.enable()
    value = function()
    profile.disable()
    elapsed = perf_counter() - started
    stream = io.StringIO()
    pstats.Stats(profile, stream=stream).sort_stats("cumtime").print_stats(18)
    return value, {"seconds_including_profiler": elapsed, "profile": stream.getvalue()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--folder", default="Project")
    parser.add_argument("--group", default="all")
    parser.add_argument("--full-library", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if not (root / "benchmark-owner.json").is_file():
        parser.error("Refusing to profile a library without a capacity-fixture owner receipt")
    if args.full_library and not (root / "temp/library-identity.json").is_file():
        parser.error("Full Library profiling requires an existing library identity")
    source_files = ("backend/symbiknow/organization/store.py", "backend/symbiknow/organization/edits.py", "backend/symbiknow/search/index.py", "backend/symbiknow/library/service.py")
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files}
    table = search._table(root, "documents")
    if table is None:
        parser.error("Missing capacity documents table")
    result = {"kind": "organization-scope-profile", "fixture": str(root), "python": sys.version,
              "platform": platform.platform(), "source_sha256": hashes, "documents": table.count_rows(),
              "folder": args.folder, "group": args.group,
              "indices": {"documents": [index.name for index in table.list_indices()],
                          "organization": [index.name for index in organization_store.published_table(root).list_indices()]}}
    condition, result["cold_group_scope"] = measured(lambda: organization_store._scope_condition(root, group=args.group))
    result["membership_sql_bytes"] = len(condition.encode())
    count, result["native_membership_count"] = measured(lambda: table.count_rows(condition))
    result["group_total"] = count
    for label in ("cold_group_browse", "warm_group_browse"):
        page, result[label] = measured(lambda: search.browse_documents(root, group=args.group))
        result[label].update(total=page["total"], rows=len(page["documents"]))
        assert page["total"] == count
    if args.full_library:
        library = ApplicationContext(root).library
        for label, params in (("library_all", {}), ("library_folder", {"folder": args.folder}),
                              ("library_folder_warm", {"folder": args.folder})):
            page, result[label] = measured(lambda: library.library(params).to_wire())
            result[label].update(total=page["total"], rows=len(page["documents"]))
    assert hashes == {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files}, "Source changed during profile"
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result["max_rss_bytes_including_profiler"] = peak if sys.platform == "darwin" else peak * 1024
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    summary = {key: ({field: item for field, item in value.items() if field != "profile"}
                     if isinstance(value, dict) else value) for key, value in result.items() if key != "source_sha256"}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
