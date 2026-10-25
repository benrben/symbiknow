"""Installed Claude Code, isolated built-ins and one explicit HTTP MCP server."""

import asyncio
import json

from .driver import DriverError, Process


class ClaudeDriver(Process):
    def __init__(self):
        super().__init__()
        self.native_id = None
        self.diagnostics = {}

    async def start(self, config, emit):
        self.config, self.emit = config, emit

    async def send(self, message):
        c = self.config
        mcp = {
            "mcpServers": {
                "application": {
                    "type": "http",
                    "url": c.mcp_url,
                    "headers": {"Authorization": "Bearer ${LOCAL_AGENT_MCP_TOKEN}"},
                }
            }
        }
        args = [
            c.executable,
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--restricted",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps(mcp),
            "--setting-sources",
            "",
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
            "--disable-slash-commands",
            "--no-chrome",
            "--allowedTools",
            *[f"mcp__application__{name}" for name in c.tools],
            "--system-prompt",
            c.instructions,
        ]
        if c.model:
            args += ["--model", c.model]
        if c.effort:
            args += ["--effort", c.effort]
        if self.native_id:
            if (
                not isinstance(self.native_id, str)
                or self.native_id.startswith("-")
                or len(self.native_id) > 200
            ):
                raise DriverError("Unsupported Claude session identifier")
            args += ["--resume", self.native_id]
        await self.launch(args, c.cwd, {"LOCAL_AGENT_MCP_TOKEN": c.token})
        await self.write(
            {
                "type": "user",
                "message": {"role": "user", "content": message},
                "parent_tool_use_id": None,
                "session_id": self.native_id or "",
            }
        )
        initialized, streamed = False, False
        try:
            while True:
                event = await asyncio.wait_for(self.read(), 180)
                if event.get("type") == "system" and event.get("subtype") == "init":
                    allowed = {f"mcp__application__{name}" for name in c.tools}
                    if not set(event.get("tools", [])) <= allowed:
                        raise DriverError("CLI exposed unexpected tools; update Claude Code")
                    if not event.get("tools"):
                        raise DriverError("The application's MCP tools did not connect")
                    initialized = True
                    self.native_id = event.get("session_id")
                    if isinstance(event.get("model"), str):
                        self.model = event["model"]
                        await self.emit("run_metadata", model=self.model)
                elif event.get("type") == "stream_event":
                    if not initialized:
                        raise DriverError("CLI did not confirm its tool restrictions")
                    delta = event.get("event", {}).get("delta", {})
                    if delta.get("type") == "text_delta":
                        streamed = True
                        await self.emit("text_delta", text=delta.get("text", ""))
                elif event.get("type") == "result":
                    if event.get("is_error") or not initialized:
                        errors = str(event.get("errors", event.get("result", ""))).lower()
                        categories = [
                            word
                            for word in (
                                "auth",
                                "login",
                                "rate",
                                "limit",
                                "quota",
                                "credit",
                                "billing",
                                "api key",
                                "permission",
                                "subscription",
                                "expired",
                                "network",
                                "connect",
                                "timeout",
                                "model",
                            )
                            if word in errors
                        ]
                        self.diagnostics = {
                            "subtype": event.get("subtype", ""),
                            "categories": categories,
                        }
                        if any(
                            word in categories for word in ("auth", "login", "api key", "expired")
                        ):
                            raise DriverError(
                                "Claude Code login is unavailable. Sign in through the CLI, then reconnect."
                            )
                        if any(
                            word in categories
                            for word in ("rate", "limit", "quota", "credit", "billing")
                        ):
                            raise DriverError(
                                "Claude Code reported an account or usage limit. Check the CLI, then reconnect."
                            )
                        raise DriverError(
                            "Claude Code could not complete the request. Check its CLI login and account."
                        )
                    if not streamed and isinstance(event.get("result"), str):
                        await self.emit("text_delta", text=event["result"])
                    self.native_id = event.get("session_id", self.native_id)
                    return
        finally:
            await self.stop()

    async def cancel(self):
        await self.stop()

    async def resume(self):
        # Each turn reopens the provider-owned transcript with --resume.
        pass
