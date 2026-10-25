"""Antigravity native NDJSON bridge, using a session-owned private profile."""

import asyncio

from . import antigravity_config as settings
from .driver import DriverError, Process


class AntigravityDriver(Process):
    supports_version = staticmethod(settings.supports_version)

    def __init__(self):
        super().__init__()
        self.native_id = None
        self.model = ""

    async def _output(self, args):
        owner = Process()
        try:
            await owner.launch(args, self.workspace)
            output, _ = await asyncio.wait_for(owner.process.communicate(), 15)
            if owner.process.returncode or len(output) > 50000:
                raise DriverError("Antigravity could not verify the private chat profile")
            return output.decode(errors="replace").strip()
        finally:
            await owner.stop()

    async def start(self, config, emit):
        self.config, self.emit = config, emit
        self.profile, self.workspace = settings.prepare(config)
        version = await self._output([config.executable, "--version"])
        if not self.supports_version(version):
            raise DriverError("This Antigravity version has not passed the chat isolation check")
        self.args = [config.executable, "--gemini_dir=" + str(self.profile)]
        if await self._output([*self.args, "agents"]) != settings.AGENT:
            raise DriverError("Antigravity did not discover the private chat agent")
        await self.resume()

    async def resume(self):
        if self.process is not None and self.process.returncode is None:
            return
        c = self.config
        args = [
            *self.args,
            "--agent",
            settings.AGENT,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--disable-slash-commands",
        ]
        if c.model:
            args += ["--model", c.model]
        if c.effort:
            args += ["--effort", c.effort]
        if self.native_id:
            args += ["--conversation", self.native_id]
        await self.launch(args, self.workspace)
        try:
            event = await asyncio.wait_for(self.read(), 30)
            self.native_id = settings.validate_init(event, self.workspace, self.native_id)
            self.model = event["init"].get("model") or c.model or ""
            if self.model:
                await self.emit("run_metadata", model=self.model)
        except BaseException:
            await self.stop()
            raise

    async def send(self, message):
        await self.resume()
        await self.write({"event": "user", "message": {"content": message}})
        streamed = False
        try:
            async with asyncio.timeout(180):
                while True:
                    event = await self.read()
                    if event.get("event") == "step_update":
                        step = event.get("step_update")
                        if (
                            not isinstance(step, dict)
                            or step.get("conversation_id") != self.native_id
                        ):
                            raise DriverError("Antigravity returned an unexpected conversation")
                        if step.get("step_type") == "tool":
                            # Defense in depth: native execution is excluded by
                            # the custom profile, not by this post-event check.
                            allowed = {"finish", *(f"mcp__{t}" for t in self.config.tools)}
                            if step.get("tool_name") not in allowed:
                                raise DriverError(
                                    "Antigravity attempted a tool outside the application"
                                )
                        if step.get("step_type") == "agent_response":
                            delta = step.get("text_delta")
                            if isinstance(delta, str) and delta:
                                streamed = True
                                await self.emit("text_delta", text=delta)
                    elif event.get("event") == "result":
                        result = event.get("result")
                        if (
                            not isinstance(result, dict)
                            or result.get("conversation_id") != self.native_id
                        ):
                            raise DriverError("Antigravity returned an unexpected conversation")
                        if result.get("status") != "SUCCESS":
                            # Provider errors can include prompts/tool payloads.
                            # Keep diagnostics private and never mark partial output complete.
                            raise DriverError(
                                "Antigravity could not complete this request. Check its CLI login, model availability or usage limits, then retry."
                            )
                        if not streamed and isinstance(result.get("response"), str):
                            await self.emit("text_delta", text=result["response"])
                        return
                    else:
                        raise DriverError(
                            "Unsupported Antigravity stream event; reconnect the agent"
                        )
        except BaseException:
            await self.stop()
            raise

    async def cancel(self):
        await self.stop()
