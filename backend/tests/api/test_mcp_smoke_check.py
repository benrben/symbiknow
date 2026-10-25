"""The optional live smoke probe independently follows the durable MCP contract."""

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location(
    "mcp_smoke_check", Path(__file__).resolve().parents[3] / "scripts/checks/mcp.py"
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Session:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return SimpleNamespace(is_error=False, structured_content=next(self.responses))


@pytest.mark.parametrize("tool,initial,expected", [
    ("search", {"job_id": "query", "status": "queued"}, {"matches": [{"version": "v2"}]}),
    ("upload", {"files": [{"job_id": "query", "status": "queued"}]},
     {"files": [{"stored": True, "document_id": "original", "version": "v1"}]}),
])
def test_live_probe_polls_queued_running_and_completed_without_result(tool, initial, expected):
    result = expected["files"][0] if tool == "upload" else expected
    session = Session([initial, {"job_id": "query", "status": "running"},
                       {"job_id": "query", "status": "completed"},
                       {"job_id": "query", "status": "completed", "result": result}])
    assert asyncio.run(probe.call(session, tool, {})) == expected
    assert all(args == {"job_id": "query", "detail": "full"}
               for _, args in session.calls[1:])


def test_live_probe_reports_terminal_failure_without_polling_forever():
    session = Session([{"job_id": "failed", "status": "failed", "error": "disk full"}])
    with pytest.raises(RuntimeError, match="disk full"):
        asyncio.run(probe.call(session, "search", {}))
    assert len(session.calls) == 1


def test_live_probe_has_a_deadline_for_jobs_that_never_finish():
    session = Session([{"job_id": "queued", "status": "queued"}])
    with pytest.raises(TimeoutError):
        asyncio.run(probe.call(session, "search", {}, timeout=0.001))


def test_live_probe_can_be_invoked_by_path_without_shadowing_sdk():
    import subprocess
    import sys

    script = Path(__file__).resolve().parents[3] / "scripts/checks/mcp.py"
    result = subprocess.run([sys.executable, str(script), "--help"],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert "--output" in result.stdout
