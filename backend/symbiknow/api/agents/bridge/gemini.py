"""Candidate Gemini ACP driver. Product detection keeps it disabled until verified.

No Gemini is installed on the development machine. The native protocol and
configuration are exercised with fixtures, not claimed as live compatibility.
"""

import asyncio
import json

from .driver import DriverError, JsonRpc


class GeminiDriver(JsonRpc):
    async def start(self, config, emit):
        self.config, self.emit = config, emit
        self.native_id = None
        await self.resume()

    async def resume(self):
        c = self.config
        # Highest-precedence system settings, scoped to this child only. No token
        # or credential is written. This leaves the CLI's own login store alone.
        settings = c.cwd / "bridge-settings.json"
        settings.write_text(
            json.dumps(
                {
                    "tools": {"core": [], "discoveryCommand": "", "callCommand": ""},
                    "mcp": {"allowed": ["application"]},
                    "hooks": {"enabled": False},
                    "telemetry": {"enabled": False},
                    "security": {"enablePermanentToolApproval": False},
                }
            )
        )
        system = c.cwd / "bridge-system.txt"
        system.write_text(c.instructions)
        await self.launch(
            [c.executable, "--acp", "--allowed-mcp-server-names", "application"],
            c.cwd,
            {"GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(settings), "GEMINI_SYSTEM_MD": str(system)},
        )
        self.on_event = self.on_notification
        self.reader = asyncio.create_task(self.listen())
        try:
            capabilities = await self.request(
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {"name": "local-agent-bridge", "version": "1"},
                },
            )
            if capabilities.get("protocolVersion") != 1:
                raise DriverError("Please update Gemini CLI; unsupported ACP version")
            params = {
                "cwd": str(c.cwd),
                "mcpServers": [
                    {
                        "type": "http",
                        "name": "application",
                        "url": c.mcp_url,
                        "headers": [{"name": "Authorization", "value": "Bearer " + c.token}],
                    }
                ],
            }
            if self.native_id:
                await self.request("session/load", {**params, "sessionId": self.native_id})
            else:
                self.native_id = (await self.request("session/new", params))["sessionId"]
        except Exception:
            await self.stop()
            raise

    async def on_notification(self, event):
        update = event.get("params", {}).get("update", {})
        if (
            event.get("method") == "session/update"
            and update.get("sessionUpdate") == "agent_message_chunk"
        ):
            content = update.get("content", {})
            if content.get("type") == "text":
                await self.emit("text_delta", text=content.get("text", ""))

    async def send(self, message):
        if not self.process:
            await self.resume()
        await self.request(
            "session/prompt",
            {"sessionId": self.native_id, "prompt": [{"type": "text", "text": message}]},
            timeout=180,
        )

    async def cancel(self):
        if self.process:
            await self.write(
                {
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": self.native_id},
                }
            )
        await self.stop()
