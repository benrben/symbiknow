"""Private agy 1.4.6 profile; no ambient hooks, plugins or MCP configuration."""

import json
from pathlib import Path
import re

from .driver import DriverError

AGENT = "symbiknow"
# In 1.4.6 init.tools describes the native registry, NOT the selected agent.
# The custom-agent tools/excludeDefaultComponents configuration is the boundary.
# Pin this registry as an additional protocol/version drift check before input.
NATIVE_REGISTRY = frozenset(
    """
ask_custom_permission ask_permission ask_question browser_click_element
browser_drag_pixel_to_pixel browser_get_dom browser_get_network_request browser_input
browser_list_network_requests browser_mouse_down browser_mouse_up browser_move_mouse
browser_press_key browser_refresh_page browser_resize_window browser_scroll browser_scroll_dom
browser_select_option browser_subagent call_mcp_tool capture_browser_console_logs
capture_browser_screenshot click_browser_pixel command_status define_subagent delete_knowledge
execute_browser_javascript find_by_name finish generate_image grep_search invoke_subagent
list_browser_pages list_dir list_permissions list_plugin_accounts list_resources manage_inbox
manage_subagents manage_task multi_replace_file_content notebook_edit notebook_execution
open_browser_url read_browser_page read_resource read_url_content replace_file_content
run_command run_workflow schedule search_marketplace search_web sed_file send_command_input
send_message view_file wait wait_5_seconds write_to_file
""".split()
)


# Isolation was verified on 1.4.6. Later releases are accepted; the pinned
# native registry above still detects drift before any input is sent.
MINIMUM_VERSION = (1, 4, 6)


def supports_version(value):
    match = re.fullmatch(r"(?:agy(?: version)?\s+)?(\d+)\.(\d+)\.(\d+)", value.strip())
    return bool(match) and tuple(map(int, match.groups())) >= MINIMUM_VERSION


def private_file(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(value)
    path.chmod(0o600)


def prepare(config):
    if not config.tools or any(not re.fullmatch(r"[A-Za-z0-9_]+", t) for t in config.tools):
        raise DriverError("Invalid application tool catalog")
    profile = config.cwd / "antigravity-profile"
    workspace = config.cwd / "workspace"
    profile.mkdir(mode=0o700, exist_ok=True)
    workspace.mkdir(mode=0o700, exist_ok=True)
    root = profile / "config"
    # Seed migration state before agy starts: a fresh profile must not import
    # user/global integrations. HOME stays unchanged for the CLI's own login.
    private_file(root / ".migrated", "")
    private_file(root / "mcp_config.json", '{"mcpServers":{}}')
    private_file(root / "hooks.json", "{}")
    for kind in ("plugins", "skills", "rules", "sidecars"):
        private_file(root / f"{kind}.json", '{"entries":[],"inherits":[]}')
    private_file(
        profile / "antigravity-cli" / "settings.json",
        json.dumps(
            {
                "permissions": {
                    "allow": [f"mcp(application/{t})" for t in config.tools],
                    "deny": [
                        f"{action}(*)"
                        for action in (
                            "command",
                            "read_file",
                            "write_file",
                            "read_url",
                            "execute_url",
                        )
                    ],
                }
            }
        ),
    )
    spec = {
        "name": AGENT,
        "description": "Symbiknow application chat",
        "tools": ["finish"],
        "excludeDefaultComponents": True,
        "inheritCustomizations": False,
        "inheritMcp": False,
        "mainAgent": True,
        "subagent": False,
        "commandExecutionPolicy": "off",
        "skills": [],
        "plugins": [],
        "rules": [],
        "agents": [],
        "hooks": [],
        "mcpServers": [
            {
                "serverName": "application",
                "serverUrl": config.mcp_url,
                "headers": {"Authorization": "Bearer " + config.token},
                "enabledTools": list(config.tools),
                "forceAllToolsEager": True,
                "timeoutSeconds": 120,
            }
        ],
    }
    # JSON is valid YAML and cannot accidentally turn instructions into fields.
    private_file(
        root / "agents" / f"{AGENT}.md",
        "---\n" + json.dumps(spec) + "\n---\n# System Prompt\n" + config.instructions + "\n",
    )
    return profile.resolve(), workspace.resolve()


def validate_init(event, workspace: Path, native_id=None):
    init = event.get("init")
    identity = event.get("conversation_id")
    if (
        event.get("event") != "init"
        or not isinstance(init, dict)
        or init.get("agent") != AGENT
        or init.get("cwd") != str(workspace)
        or init.get("permission_mode") != "request-review"
        or not isinstance(identity, str)
        or not re.fullmatch(r"[a-f0-9-]{36}", identity)
        or (native_id and identity != native_id)
        or not isinstance(init.get("tools"), list)
        or any(not isinstance(t, str) for t in init["tools"])
        or set(init["tools"]) != NATIVE_REGISTRY
    ):
        raise DriverError(
            "Antigravity did not confirm the isolated chat profile; reconnect or update the integration."
        )
    return identity
