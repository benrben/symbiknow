"""Real original/index services remain responsive while expensive work is held."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "http_contention", Path(__file__).resolve().parents[3] / "benchmarks/http_contention.py"
)
contention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contention)


@pytest.mark.parametrize(
    "scenario", ["history", "evidence-scan", "csv-card", "extraction", "preview"]
)
async def test_unrelated_http_reads_complete_during_slow_work(tmp_path, scenario):
    result = await contention.probe(tmp_path, hold_seconds=2, scenarios=(scenario,))
    blocked = [
        name
        for name, response in result[scenario].items()
        if not response["completed_while_work_blocked"]
    ]
    assert not blocked, f"{scenario} serialized unrelated HTTP reads: {blocked}; {result[scenario]}"
