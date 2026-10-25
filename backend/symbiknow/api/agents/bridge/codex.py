"""Installed Codex app-server with only client-hosted application MCP tools.

Native model metadata disables built-ins, including model-forced patch/code-mode
tools. Client tools forward through the same token-scoped MCP endpoint, keeping
the session token out of Codex configuration and transcripts.
"""

import asyncio
import json
import re

from . import mcp_client
from .codex_config import restricted_catalog, restrictions
from .driver import DriverError, JsonRpc


class CodexDriver(JsonRpc):
    # Isolation was verified on 0.162.1. Later releases are accepted; the
    # restricted configuration is still applied and read back on every start.
    MINIMUM_VERSION = (0, 162, 1)

    @classmethod
    def supports_version(cls, version):
        match = re.fullmatch(r"(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)", version.strip())
        return bool(match) and tuple(map(int, match.groups())) >= cls.MINIMUM_VERSION

    def __init__(self):
        super().__init__()
        self.native_id = None
        self.turn = None
        self.turn_id = None

    async def start(self, config, emit):
        self.config, self.emit = config, emit
        try:
            await self.launch([config.executable, "--version"], config.cwd)
            output, _ = await asyncio.wait_for(self.process.communicate(), 5)
            await self.stop()
            if not self.supports_version(output.decode().strip()):
                raise DriverError("This Codex version has not passed the tool-isolation check")
            await self._connect(restrictions())
            effective = (await self.request("config/read", {"includeLayers": False}))["config"]
            names = list(effective.get("mcp_servers", {}))
            model = config.model or effective.get("model")
            del effective
            if any(not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in names):
                raise DriverError("Cannot isolate an inherited Codex MCP server name")
            # Without native MCP registrations even generic resource tools
            # disappear. The bridge owns the HTTP MCP connection instead.
            self.overrides = restrictions() | {
                f"mcp_servers.{name}.enabled": False for name in names
            }
            models = (await self.request("model/list", {})).get("data", [])
            if not model:
                model = next((m["model"] for m in models if m.get("isDefault")), None)
            if not model:
                raise DriverError("Choose a model in Codex, then reconnect")
            self.model = model
            catalog = config.cwd / "bridge-models.json"
            catalog.write_text(json.dumps(restricted_catalog(model)))
            self.overrides.update(model=model, model_catalog_json=str(catalog))
            if config.effort:
                self.overrides["model_reasoning_effort"] = config.effort
            listing = await mcp_client.request(config, "tools/list")
            tools = listing.get("tools", [])
            if {t["name"] for t in tools} != set(config.tools):
                raise DriverError("Application tool catalog changed; reconnect")
            self.dynamic_tools = [
                {
                    "type": "function",
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": t["inputSchema"],
                }
                for t in tools
            ]
            await self.stop()
            await self.resume()
        except Exception:
            await self.stop()
            raise

    async def _connect(self, overrides):
        args = [self.config.executable, "app-server"]
        for key, value in overrides.items():
            args.extend(["-c", f"{key}={json.dumps(value)}"])
        await self.launch(args, self.config.cwd)
        self.on_event = self.on_notification
        self.reader = asyncio.create_task(self.listen())
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "local_agent_bridge", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
        )
        await self.write({"method": "initialized", "params": {}})

    async def resume(self):
        await self._connect(self.overrides)
        params = {
            "cwd": str(self.config.cwd),
            "model": self.model,
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "environments": [],
            "baseInstructions": self.config.instructions,
            "config": self.overrides,
        }
        if self.native_id:
            params["threadId"] = self.native_id
            method = "thread/resume"
        else:
            params["dynamicTools"] = self.dynamic_tools
            method = "thread/start"
        result = await self.request(method, params)
        self.native_id = result["thread"]["id"]

    async def handle_request(self, method, params):
        if method != "item/tool/call":
            return await super().handle_request(method, params)
        try:
            if (
                params.get("tool") not in self.config.tools
                or params.get("namespace") not in (None, "functions")
                or params.get("threadId") != self.native_id
                or not isinstance(params.get("arguments"), dict)
                or self.turn is None
                or self.turn.done()
            ):
                raise DriverError("Tool is not allowed for this session")
            result = await mcp_client.request(
                self.config,
                "tools/call",
                {
                    "name": params["tool"],
                    "arguments": params["arguments"],
                },
            )
            return {
                "success": not result.get("isError", False),
                "contentItems": [
                    {"type": "inputText", "text": item["text"]}
                    for item in result.get("content", [])
                    if item.get("type") == "text"
                ],
            }
        except Exception:
            return {
                "success": False,
                "contentItems": [
                    {"type": "inputText", "text": "Application tool unavailable or not allowed"}
                ],
            }

    async def on_notification(self, event):
        method, params = event.get("method"), event.get("params", {})
        if method == "item/agentMessage/delta":
            await self.emit("text_delta", text=params.get("delta", ""))
        elif method == "turn/completed" and self.turn is not None and not self.turn.done():
            turn = params.get("turn", {})
            if turn.get("status") == "failed":
                error = turn.get("error") or {}
                message = (
                    "Codex reported a usage limit. Check its CLI, then reconnect."
                    if error.get("codexErrorInfo") == "usageLimitExceeded"
                    else "Codex turn failed. Check its CLI login and connection."
                )
                self.turn.set_exception(DriverError(message))
            else:
                self.turn.set_result(None)
        elif method == "bridge/error" and self.turn is not None and not self.turn.done():
            self.turn.set_exception(DriverError("Codex exited. Reconnect to resume."))

    async def send(self, message):
        if not self.process:
            await self.resume()
        self.turn = asyncio.get_running_loop().create_future()
        try:
            result = await self.request(
                "turn/start",
                {
                    "threadId": self.native_id,
                    "environments": [],
                    "input": [{"type": "text", "text": message}],
                },
            )
            self.turn_id = result["turn"]["id"]
            await asyncio.wait_for(self.turn, 180)
        finally:
            self.turn_id = None

    async def cancel(self):
        # The next turn resumes the provider-owned thread with the same policy.
        await self.stop()
