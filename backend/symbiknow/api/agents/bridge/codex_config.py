"""Native Codex model/tool configuration, scoped to a single child process.

Only public model metadata is read; auth files and cache identity are never used.
Tool capability fields are replaced, not inherited from the selected model.
"""

from copy import deepcopy
import json
from pathlib import Path

from .driver import DriverError


def restrictions():
    disabled = (
        "shell_tool",
        "unified_exec",
        "shell_snapshot",
        "shell_snapshot_v2",
        "apply_patch_freeform",
        "apps",
        "connectors",
        "plugins",
        "remote_plugin",
        "browser_use",
        "browser_use_external",
        "computer_use",
        "in_app_browser",
        "js_repl",
        "code_mode",
        "code_mode_only",
        "code_mode_host",
        "multi_agent",
        "multi_agent_v2",
        "collab",
        "image_generation",
        "imagegenext",
        "view_image",
        "memories",
        "memory_tool",
        "hooks",
        "codex_hooks",
        "plugin_hooks",
        "web_search",
        "web_search_cached",
        "web_search_request",
        "standalone_web_search",
        "skill_search",
        "skill_mcp_dependency_install",
        "workspace_dependencies",
        "goals",
        "tool_suggest",
        "request_permissions",
        "request_permissions_tool",
        "incremental_tools",
        "deferred_tool_world_state",
        "tool_search",
        "current_time_reminder",
        "sleep_tool",
        "token_budget",
        "deferred_executor",
        "send_message_to_user_async",
        "experimental_context_management",
    )
    return {
        **{f"features.{key}": False for key in disabled},
        "features.skip_host_skill_discovery": True,
        "features.tool_registry.turn_metadata_includes_tool_info": True,
        "web_search": "disabled",
        "agents.enabled": False,
        "skills.include_instructions": False,
        "skills.bundled.enabled": False,
        "plugins._default.enabled": False,
        "apps._default.enabled": False,
        "project_doc_max_bytes": 0,
        "history.persistence": "none",
        "tools.update_plan.enabled": False,
        "tools.experimental_request_user_input.enabled": False,
        "include_environment_context": False,
    }


def restricted_catalog(model, cache=None):
    cache = cache or Path.home() / ".codex" / "models_cache.json"
    try:
        if cache.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Model catalog too large")
        models = json.loads(cache.read_text())["models"]
        source = next(m for m in models if m.get("slug") == model)
    except (OSError, ValueError, KeyError, StopIteration, TypeError) as exc:
        raise DriverError("Open Codex once to refresh its model catalog, then reconnect.") from exc
    # Do not inherit newly introduced capability fields. Preserve the selected
    # model's transport/context/effort metadata without copying account identity.
    fields = (
        "slug",
        "display_name",
        "description",
        "default_reasoning_level",
        "supported_reasoning_levels",
        "visibility",
        "supported_in_api",
        "priority",
        "additional_speed_tiers",
        "service_tiers",
        "default_service_tier",
        "availability_nux",
        "support_verbosity",
        "default_verbosity",
        "truncation_policy",
        "context_window",
        "max_context_window",
        "auto_compact_token_limit",
        "comp_hash",
        "effective_context_window_percent",
        "input_modalities",
        "use_responses_lite",
        "supports_reasoning_effort_updates",
        "supports_reasoning_summary_parameter",
        "default_reasoning_summary",
        "supports_image_detail_original",
        "prefer_websockets",
    )
    entry = {key: deepcopy(source[key]) for key in fields if key in source}
    entry.update(
        base_instructions="Use only the application's tools to help the user.",
        shell_type="disabled",
        apply_patch_tool_type=None,
        experimental_supported_tools=[],
        tool_mode="direct",
        supports_search_tool=False,
        include_apps_usage_instructions=False,
        include_plugin_usage_instructions=False,
        include_skills_usage_instructions=False,
        node_repl_disabled=True,
    )
    return {"models": [entry]}
