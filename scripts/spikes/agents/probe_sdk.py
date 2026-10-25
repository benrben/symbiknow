"""Inspect SDK command construction without starting an agent or reading auth.

Run: uv run --no-project --with claude-agent-sdk==0.2.168 python scripts/spikes/agents/probe_sdk.py
This optional spike uses a private SDK transport for inspection only. Production
has no SDK dependency; upgrading this probe may require adapting private APIs.
"""

import importlib.metadata
import json
import shutil
import tempfile

from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

with tempfile.TemporaryDirectory(prefix="sdk-probe-") as cwd:
    installed = shutil.which("claude")
    if not installed:
        raise SystemExit("Claude Code must already be installed")
    options = ClaudeAgentOptions(
        cli_path=installed,
        cwd=cwd,
        tools=[],
        allowed_tools=["mcp__application__search"],
        setting_sources=[],
        permission_mode="dontAsk",
        mcp_servers={},
        extra_args={"restricted": None, "strict-mcp-config": None, "permission-prompts": "none"},
    )
    command = SubprocessCLITransport(
        prompt="Synthetic inspection only", options=options
    )._build_command()
    assert command[0] == installed
    assert command[command.index("--tools") + 1] == ""
    assert "--restricted" in command and "--strict-mcp-config" in command
    print(
        json.dumps(
            {
                "sdk_version": importlib.metadata.version("claude-agent-sdk"),
                "uses_installed_cli": True,
                "empty_builtin_tools": True,
                "restriction_flags_preserved": True,
                "login_runtime_verified": False,
            }
        )
    )
