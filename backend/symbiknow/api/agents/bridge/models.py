"""Discover model choices through installed CLIs, without starting an inference turn."""

import asyncio
import json
from pathlib import Path
import re
import tempfile

from .codex_config import restrictions
from .driver import DriverError, JsonRpc, Process


def model_choice(identity, name, description, *, default=False, efforts=(), default_effort=""):
    if not isinstance(identity, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,199}", identity
    ):
        return None
    return {
        "id": identity,
        "name": str(name or identity)[:200],
        "description": str(description or "")[:1000],
        "default": bool(default),
        "efforts": [
            e
            for e in efforts
            if e in {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
        ],
        "default_effort": str(default_effort or "")[:20],
    }


async def claude_models(executable, cwd):
    owner = Process()
    try:
        await owner.launch(
            [
                executable,
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--restricted",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--setting-sources",
                "",
                "--permission-mode",
                "dontAsk",
                "--permission-prompts",
                "none",
                "--disable-slash-commands",
                "--no-chrome",
            ],
            cwd,
        )
        await owner.write(
            {
                "type": "control_request",
                "request_id": "models",
                "request": {"subtype": "initialize"},
            }
        )
        for _ in range(100):
            event = await owner.read()
            response = event.get("response", {})
            if event.get("type") == "control_response" and response.get("request_id") == "models":
                # Deliberately project only model metadata; initialize also returns account info.
                return [
                    model_choice(
                        m.get("value"),
                        m.get("displayName"),
                        m.get("description"),
                        default=m.get("value") == "default",
                        efforts=m.get("supportedEffortLevels", []),
                    )
                    for m in response.get("response", {}).get("models", [])[:200]
                ]
        raise DriverError("Claude Code did not return its model catalog")
    finally:
        await owner.stop()


async def codex_models(executable, cwd):
    owner = JsonRpc()
    try:
        args = [executable, "app-server"]
        for key, value in restrictions().items():
            args.extend(["-c", f"{key}={json.dumps(value)}"])
        await owner.launch(args, cwd)
        owner.reader = asyncio.create_task(owner.listen())
        await owner.request(
            "initialize", {"clientInfo": {"name": "local_agent_models", "version": "1"}}
        )
        await owner.write({"method": "initialized", "params": {}})
        config = (await owner.request("config/read", {"includeLayers": False})).get("config", {})
        preferred = config.get("model")
        del config
        result, cursor = [], None
        for _ in range(10):
            page = await owner.request(
                "model/list", {"limit": 100, **({"cursor": cursor} if cursor else {})}
            )
            for m in page.get("data", []):
                if m.get("hidden"):
                    continue
                result.append(
                    model_choice(
                        m.get("model"),
                        m.get("displayName"),
                        m.get("description"),
                        default=m.get("model") == preferred if preferred else m.get("isDefault"),
                        efforts=[
                            e.get("reasoningEffort") for e in m.get("supportedReasoningEfforts", [])
                        ],
                        default_effort=m.get("defaultReasoningEffort"),
                    )
                )
            cursor = page.get("nextCursor")
            if not cursor:
                return result
        raise DriverError("Codex returned too many model choices")
    finally:
        await owner.stop()


async def antigravity_models(executable, cwd):
    """The installed CLI's metadata catalogue; never start a chat/inference turn."""
    owner = Process()
    try:
        await owner.launch([executable, "models"], cwd)
        output, _ = await owner.process.communicate()
        if owner.process.returncode:
            raise DriverError(
                "Unable to load Antigravity models. Check its CLI login and connection, then retry."
            )
        if len(output) > 1024 * 1024:
            raise DriverError(
                "Antigravity returned too much model metadata. Update the CLI and retry."
            )
        result = []
        for line in output.decode("utf-8").splitlines():
            if not line.strip():
                continue
            columns = line.split("\t")
            if len(columns) != 2 or not all(column.strip() for column in columns):
                raise DriverError(
                    "Antigravity returned an unsupported model catalogue. Update the CLI and retry."
                )
            choice = model_choice(columns[0].strip(), columns[1].strip(), "")
            if choice is None:
                raise DriverError(
                    "Antigravity returned an unsupported model catalogue. Update the CLI and retry."
                )
            result.append(choice)
            if len(result) > 200:
                raise DriverError(
                    "Antigravity returned too many model choices. Update the CLI and retry."
                )
        return result
    finally:
        await owner.stop()


async def discover_models(provider, executable):
    loader = {
        "claude": claude_models,
        "codex": codex_models,
        "antigravity": antigravity_models,
    }.get(provider)
    if not loader:
        raise DriverError("Model selection is not available for this CLI yet")
    try:
        with tempfile.TemporaryDirectory(prefix="agent-models-") as directory:
            async with asyncio.timeout(30):
                choices = await loader(executable, Path(directory))
        result = list({m["id"]: m for m in choices if m}.values())
        if not result:
            raise DriverError("The CLI returned no models. Check its login, then refresh models.")
        return result
    except (TimeoutError, OSError, ValueError, KeyError, TypeError) as exc:
        raise DriverError(
            "Unable to load models. Check the CLI login and connection, then retry."
        ) from exc


def select_model(choices, model, effort):
    selected = next((m for m in choices if m["id"] == model), None)
    if selected is None:
        raise DriverError("This model is no longer available. Refresh models and choose again.")
    if effort and effort not in selected["efforts"]:
        raise DriverError("This model does not support that effort level")
    return selected
