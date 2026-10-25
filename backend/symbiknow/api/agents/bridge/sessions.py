"""Generic session state: replay, tool execution, approval, cancellation and expiry."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import suppress
from copy import deepcopy
from dataclasses import dataclass
import json
import secrets
import tempfile
import time
from typing import Any, Callable
import uuid

from .driver import DriverConfig, DriverError
from .ui_bridge import UIBridge
from .schema import validate


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    schema: dict
    kind: str
    invoke: Callable
    preview: Callable | None = None


@dataclass
class Approval:
    tool: Tool
    args: dict
    preview: dict
    run_id: str
    expires: float
    status: str = "pending"
    result: Any = None


class Session:
    def __init__(
        self,
        provider,
        driver,
        tools,
        *,
        approval_timeout=600,
        ui_timeout=15,
        display=lambda value: value,
    ):
        self.id = uuid.uuid4().hex
        self.provider, self.driver = provider, driver
        self.ui_token, self.mcp_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.tools = {tool.name: tool for tool in tools}
        self.approval_timeout = approval_timeout
        self.display = display
        self.run_count = 0
        self.text_bytes = 0
        self.events = deque()
        self.event_bytes = 0
        self.sequence = 0
        self.run_id = ""
        self.context = {}
        self.approvals: dict[str, Approval] = {}
        self.task = None
        self.followups = []
        self.sink = None
        self.closed = False
        self.started = False
        self.generation = 0
        self.tool_count = 0
        self.decision_tasks = set()
        self.temporary = tempfile.TemporaryDirectory(prefix="local-agent-")
        self.ui = UIBridge(self.emit, lambda: self.sink is not None, ui_timeout)
        self.lock = asyncio.Lock()
        self.expiry = None
        self.housekeeping = asyncio.create_task(self._expire_approvals())

    async def start(self, executable, mcp_url, instructions, *, model=None, effort=None):
        from pathlib import Path

        config = DriverConfig(
            executable,
            Path(self.temporary.name),
            mcp_url,
            self.mcp_token,
            tuple(self.tools) + ("await_approval", "get_ui_context"),
            instructions,
            model,
            effort,
        )
        await self.driver.start(config, self.emit)
        self.started = True

    async def emit(self, event_type, *, run_id=None, **payload):
        if self.closed:
            return
        if event_type == "text_delta":
            self.text_bytes += len(payload.get("text", "").encode())
            if self.text_bytes > 256 * 1024:
                raise DriverError("Answer exceeded the size limit. Ask a narrower question.")
        self.sequence += 1
        event = {
            "type": event_type,
            "session_id": self.id,
            "run_id": self.run_id if run_id is None else run_id,
            "seq": self.sequence,
            "timestamp": int(time.time() * 1000),
            **deepcopy(self.display(payload)),
        }
        size = len(json.dumps(event).encode())
        if size > 512 * 1024:
            event = {k: v for k, v in event.items() if k not in {"result", "args"}}
            event.update(type="tool_call_error", message="Tool response exceeds the display limit")
            size = len(json.dumps(event).encode())
        self.events.append((event, size))
        self.event_bytes += size
        while len(self.events) > 4096 or self.event_bytes > 4 * 1024 * 1024:
            self.event_bytes -= self.events.popleft()[1]
        if self.sink:
            try:
                self.sink.put_nowait(event)
            except asyncio.QueueFull:
                # A slow socket must not block MCP or unboundedly retain data.
                self.sink = None

    def replay(self, after):
        if after < 0 or after > self.sequence:
            raise ValueError("Invalid replay position")
        if self.events and after < self.events[0][0]["seq"] - 1:
            raise ValueError("Chat history expired. Start a new chat.")
        return [event for event, _ in self.events if event["seq"] > after]

    @property
    def running(self):
        return self.task is not None and not self.task.done()

    def send(self, message, *, automatic=False):
        if self.closed or not self.started:
            raise ValueError("Reconnect the agent")
        if self.running:
            raise ValueError("Wait for the current answer or press Stop")
        if not isinstance(message, str) or not message.strip() or len(message) > 32000:
            raise ValueError("Send a message of 1–32000 characters")
        if self.run_count >= 100:
            raise ValueError("Chat limit reached. Start a new chat.")
        self.task = asyncio.create_task(self._run(message, automatic=automatic))

    async def _run(self, message, *, automatic=False):
        self.run_count += 1
        self.text_bytes = 0
        self.run_id = uuid.uuid4().hex
        run_id = self.run_id
        await self.emit(
            "run_started",
            message=message,
            automatic=automatic,
            model=getattr(self.driver, "model", ""),
        )
        try:
            summary = json.dumps(self.context, ensure_ascii=False)
            await self.driver.send(
                f"User interface context (view metadata, no document content): {summary}\n\n{message}"
            )
            await self.emit("text_done")
            await self.emit("run_finished", status="completed")
        except asyncio.CancelledError:
            # cancel() publishes the immediate terminal event.
            raise
        except Exception as exc:
            await self.emit(
                "run_error",
                message=str(exc)
                if isinstance(exc, DriverError)
                else "Agent disconnected or rejected the request. Check its CLI login, then reconnect.",
            )
            self.ui.cancel("agent_error")
            await self.driver.stop()
            await self._deny_pending("agent_error")
        finally:
            if self.run_id == run_id:
                self.task = None
            if self.followups and not self.closed:
                next_message = self.followups.pop(0)
                self.task = asyncio.create_task(self._run(next_message, automatic=True))

    async def call(self, name, args):
        if self.closed or not self.running:
            raise ValueError("No active agent run")
        if name == "get_ui_context":
            return deepcopy(self.context)
        if name == "await_approval":
            call = self.approvals.get(args.get("id"))
            if not call:
                return {"ok": False, "reason": "unknown_approval"}
            return {"status": call.status, "result": deepcopy(call.result)}
        tool = self.tools.get(name)
        if not tool:
            raise ValueError("Tool is not allowed for this session")
        validate(args, tool.schema)
        self.tool_count += 1
        if self.tool_count > 1000:
            raise ValueError("Tool limit reached; start a new chat")
        generation = self.generation
        args = deepcopy(args)
        identity, run_id = uuid.uuid4().hex, self.run_id
        await self.emit("tool_call_started", id=identity, name=name, kind=tool.kind)
        await self.emit("tool_call_args", id=identity, args=args)
        try:
            if tool.kind == "browser":
                args = await asyncio.to_thread(tool.invoke, args, None)
                if generation != self.generation or self.closed:
                    raise ValueError("Run cancelled")
                result = await self.ui.call(name, args, run_id)
            elif tool.kind == "approval":
                if (
                    len(self.approvals) >= 128
                    or sum(len(json.dumps(a.args)) for a in self.approvals.values())
                    + len(json.dumps(args))
                    > 4 * 1024 * 1024
                ):
                    raise ValueError("Approval limit reached; start a new chat")
                preview = await asyncio.to_thread(tool.preview, args)
                if generation != self.generation or self.closed:
                    raise ValueError("Run cancelled")
                self.approvals[identity] = Approval(
                    tool, args, preview, run_id, time.monotonic() + self.approval_timeout
                )
                await self.emit(
                    "tool_call_awaiting_approval", run_id=run_id, id=identity, preview=preview
                )
                return {
                    "status": "pending_approval",
                    "id": identity,
                    "instruction": "Tell the user approval is needed, then finish this turn. Do not repeat the write. Use await_approval for its receipt.",
                }
            else:
                result = await asyncio.to_thread(tool.invoke, args, None)
            await self.emit("tool_call_result", run_id=run_id, id=identity, result=result)
            return result
        except (ValueError, FileNotFoundError) as exc:
            await self.emit("tool_call_error", run_id=run_id, id=identity, message=str(exc)[:500])
            return {"ok": False, "reason": "invalid_request", "message": str(exc)[:500]}
        except asyncio.CancelledError:
            await self.emit("tool_call_error", run_id=run_id, id=identity, message="Cancelled")
            raise
        except Exception:
            await self.emit(
                "tool_call_error",
                run_id=run_id,
                id=identity,
                message="Tool failed. Refresh and try again.",
            )
            return {"ok": False, "reason": "tool_failed"}

    def request_decision(self, identity, approve):
        async def resolve():
            try:
                await self.decide(identity, approve)
            except ValueError as exc:
                await self.emit("request_error", message=str(exc))

        task = asyncio.create_task(resolve())
        self.decision_tasks.add(task)
        task.add_done_callback(self.decision_tasks.discard)

    async def decide(self, identity, approve):
        if not isinstance(identity, str) or type(approve) is not bool:
            raise ValueError("Invalid approval decision")
        generation = self.generation
        async with self.lock:
            call = self.approvals.get(identity)
            if self.closed or not call or call.status != "pending":
                raise ValueError("Approval is no longer pending")
            if call.expires <= time.monotonic():
                approve = False
            call.status = "approved" if approve else "denied"
            await self.emit(
                "tool_call_approved" if approve else "tool_call_denied",
                run_id=call.run_id,
                id=identity,
            )
            if approve:
                try:
                    # The product callback compares its frozen preview and writes
                    # under the application's lock, without releasing it between.
                    call.result = await asyncio.to_thread(
                        call.tool.invoke, deepcopy(call.args), deepcopy(call.preview)
                    )
                    failed = isinstance(call.result, dict) and call.result.get("ok") is False
                    call.status = "error" if failed else "done"
                    await self.emit(
                        "tool_call_error" if failed else "tool_call_result",
                        run_id=call.run_id,
                        id=identity,
                        result=call.result,
                        **(
                            {
                                "message": "The operation reported a failure. Inspect its receipt before retrying."
                            }
                            if failed
                            else {}
                        ),
                    )
                except (ValueError, FileNotFoundError):
                    call.status, call.result = "conflict", {"ok": False, "reason": "conflict"}
                    await self.emit(
                        "tool_call_error",
                        run_id=call.run_id,
                        id=identity,
                        message="Conflict: the preview is out of date. Ask for a new proposal.",
                    )
                except Exception:
                    call.status, call.result = "error", {"ok": False, "reason": "write_failed"}
                    await self.emit(
                        "tool_call_error",
                        run_id=call.run_id,
                        id=identity,
                        message="The operation failed. Check the library before retrying.",
                    )
            else:
                call.result = {"ok": False, "reason": "denied"}
            call.args, call.preview = {}, {}
            if self.started and not self.closed and generation == self.generation:
                followup = f"Approval {identity} is {call.status}. Retrieve its receipt with await_approval; do not repeat the write."
                if self.running:
                    self.followups.append(followup)
                else:
                    self.send(followup, automatic=True)
            return {"status": call.status}

    async def _deny_pending(self, reason):
        for identity, call in self.approvals.items():
            if call.status == "pending":
                call.status, call.result = "denied", {"ok": False, "reason": reason}
                call.args, call.preview = {}, {}
                await self.emit("tool_call_denied", run_id=call.run_id, id=identity, reason=reason)

    async def _expire_approvals(self):
        while True:
            await asyncio.sleep(1)
            for identity, call in list(self.approvals.items()):
                if call.status == "pending" and call.expires <= time.monotonic():
                    with suppress(ValueError):
                        await self.decide(identity, False)

    async def cancel(self):
        self.generation += 1
        self.followups.clear()
        await self._deny_pending("cancelled")
        self.ui.cancel()
        task, self.task = self.task, None
        if task and not task.done():
            await self.emit("run_finished", status="cancelled")
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await self.driver.cancel()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        await self.cancel()
        # An explicitly approved commit already in progress must finish once.
        async with self.lock:
            pass
        self.mcp_token = self.ui_token = ""
        await self.driver.stop()
        if self.decision_tasks:
            await asyncio.gather(*self.decision_tasks)
        self.housekeeping.cancel()
        with suppress(asyncio.CancelledError):
            await self.housekeeping
        self.temporary.cleanup()
        self.sink = None
