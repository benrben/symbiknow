"""Provider-neutral driver contract, process ownership and bounded JSON-RPC."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
from typing import Any, Protocol

Emit = Callable[..., Awaitable[None]]


class DriverError(RuntimeError):
    pass


@dataclass(frozen=True)
class DriverConfig:
    executable: str
    cwd: Path
    mcp_url: str
    token: str
    tools: tuple[str, ...]
    instructions: str
    model: str | None = None
    effort: str | None = None


class AgentDriver(Protocol):
    async def start(self, config: DriverConfig, emit: Emit) -> None: ...
    async def send(self, message: str) -> None: ...
    async def cancel(self) -> None: ...
    async def stop(self) -> None: ...
    async def resume(self) -> None: ...


def child_environment(overrides=None):
    allowed = {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "SYSTEMROOT",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    }
    return {
        **{key: value for key, value in os.environ.items() if key in allowed},
        **(overrides or {}),
    }


class Process:
    """One process group. Never run a shell or log the child's prompts/stderr."""

    def __init__(self):
        self.process = None

    async def launch(self, args: list[str], cwd: Path, env: dict[str, str] | None = None):
        await self.stop()
        self.process = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            env=child_environment(env),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            limit=2 * 1024 * 1024,
        )

    async def write(self, value: dict):
        if not self.process or self.process.returncode is not None:
            raise DriverError("Agent exited. Reconnect, or sign in using its CLI.")
        self.process.stdin.write(json.dumps(value).encode() + b"\n")
        await self.process.stdin.drain()

    async def read(self) -> dict:
        if not self.process:
            raise DriverError("Agent is not connected")
        line = await self.process.stdout.readline()
        if not line:
            raise DriverError("Agent exited. Check its CLI login and reconnect.")
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError) as exc:
            raise DriverError("Unsupported agent protocol; please update the CLI.") from exc

    async def stop(self):
        child, self.process = self.process, None
        if not child:
            return
        # Kill descendants even when their parent exited before cleanup.
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(child.wait(), 2)
        except TimeoutError:
            with suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            await child.wait()
        with suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)


class JsonRpc(Process):
    def __init__(self):
        super().__init__()
        self.sequence = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.reader: asyncio.Task | None = None
        self.on_event: Callable[[dict], Awaitable[None]] | None = None

    async def handle_request(self, method, params):
        if method.endswith("/requestApproval"):
            return {"decision": "decline"}
        if method == "session/request_permission":
            return {"outcome": {"outcome": "cancelled"}}
        return None

    async def request(self, method: str, params: dict, timeout=45) -> Any:
        self.sequence += 1
        identity = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        try:
            await self.write({"jsonrpc": "2.0", "id": identity, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(identity, None)

    async def listen(self):
        try:
            while True:
                message = await self.read()
                if "method" in message:
                    if "id" in message:
                        # Providers may ask for native file/shell/user permissions.
                        # No native mutation or credential interaction is ever approved.
                        result = await self.handle_request(
                            message["method"], message.get("params", {})
                        )
                        if result is None:
                            await self.write(
                                {
                                    "jsonrpc": "2.0",
                                    "id": message["id"],
                                    "error": {"code": -32601, "message": "Not allowed"},
                                }
                            )
                            continue
                        await self.write({"jsonrpc": "2.0", "id": message["id"], "result": result})
                    elif self.on_event:
                        await self.on_event(message)
                else:
                    future = self.pending.get(message.get("id"))
                    if future and not future.done():
                        if "error" in message:
                            future.set_exception(
                                DriverError(
                                    "Agent rejected the request. Check its version and login."
                                )
                            )
                        else:
                            future.set_result(message.get("result", {}))
        except (DriverError, OSError, ValueError) as exc:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(exc)
            if self.on_event:
                await self.on_event({"method": "bridge/error", "params": {"message": str(exc)}})

    async def stop(self):
        reader, self.reader = self.reader, None
        if reader and reader is not asyncio.current_task():
            reader.cancel()
            with suppress(asyncio.CancelledError):
                await reader
        for future in list(self.pending.values()):
            if not future.done():
                future.set_exception(DriverError("Agent stopped"))
        await super().stop()
