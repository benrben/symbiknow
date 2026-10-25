"""The paired hosted-quality report identifies every measured change; never calls Jev."""

import importlib.util
from pathlib import Path
import subprocess
import sys

REPO = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("hosted_quality", REPO / "benchmarks/hosted_quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


def row(variant, case, passed, status="answered", calls=1, tokens=100):
    return dict(variant=variant, case=case, passed=passed, provider_error=False, seconds=.3,
                answer={"status": status},
                metrics={"provider_calls": calls, "provider_input_tokens": tokens})


def test_effects_flag_regressions_and_keep_every_attempt():
    cases = [{"id": "kept", "category": "proof"}, {"id": "lost", "category": "proof"},
             {"id": "fixed", "category": "numeric"}]
    rows = [row("baseline", "kept", True), row("current", "kept", True, tokens=60),
            row("baseline", "lost", True), row("current", "lost", True),
            row("current", "lost", False, status="needs_context", calls=2),
            row("baseline", "fixed", False, status="partial"), row("current", "fixed", True)]
    report = quality.effects(rows, cases)
    assert report["regressed_cases"] == ["lost"]
    assert report["improved_cases"] == ["fixed"] and report["unchanged_cases"] == ["kept"]
    assert report["per_case"]["lost"]["samples"] == [1, 2]  # The failed attempt still counts.
    assert report["per_case"]["kept"]["provider_input_tokens_delta"] == -40
    assert report["provider_calls_delta"] == 5 - 3


def test_source_identity_covers_every_judgment_module(tmp_path):
    package = tmp_path / "backend/symbiknow"
    (package / "ai").mkdir(parents=True)
    (package / "core").mkdir()
    for name in ("ai/jev.py", "ai/decisions.py", "core/cache.py"):
        (package / name).write_text(name)
    before = quality.source_hash(tmp_path)
    (package / "ai/decisions.py").write_text("changed prompt")
    assert quality.source_hash(tmp_path) != before


def test_paired_run_must_record_what_changed(tmp_path):
    result = subprocess.run(
        [sys.executable, str(REPO / "benchmarks/hosted_quality.py"),
         "--baseline", str(tmp_path), "--output", str(tmp_path / "out.json")],
        capture_output=True, text=True)
    assert result.returncode == 2 and "--change" in result.stderr
    assert not (tmp_path / "out.json").exists()
