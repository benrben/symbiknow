import asyncio
from copy import deepcopy
import threading

import pytest

from symbiknow.api.agents.bridge.sessions import Session, Tool
from symbiknow.api.agents.bridge.schema import validate
from symbiknow.api.agents.bridge.ui_bridge import UIBridge

SCHEMA = {"type": "object", "properties": {"version": {"type": "integer"}}, "required": ["version"]}


class FakeDriver:
    def __init__(self):
        self.done = asyncio.Event()
        self.cancelled = False

    async def start(self, config, emit):
        self.config, self.emit = config, emit

    async def send(self, message):
        self.message = message
        await self.emit("text_delta", text="Hello")
        await self.done.wait()

    async def cancel(self):
        self.cancelled = True

    async def stop(self):
        await self.cancel()


async def started(tools=(), **kwargs):
    session = Session("Fake", FakeDriver(), tools, **kwargs)
    await session.start("fake", "http://127.0.0.1/session", "Test")
    session.send("Question")
    await asyncio.sleep(0)
    return session


@pytest.mark.parametrize("approve", [True, False])
async def test_write_requires_frozen_approval_and_is_exactly_once(approve):
    writes = []
    tool = Tool(
        "write",
        "Write",
        SCHEMA,
        "approval",
        lambda a, p: writes.append((a, p)),
        lambda a: {"version": a["version"]},
    )
    session = await started([tool])
    try:
        args = {"version": 1}
        receipt = await session.call("write", args)
        assert receipt["status"] == "pending_approval" and not writes
        args["version"] = 2
        await session.decide(receipt["id"], approve)
        assert writes == [({"version": 1}, {"version": 1})] if approve else not writes
        with pytest.raises(ValueError):
            await session.decide(receipt["id"], True)
        assert session.approvals[receipt["id"]].status == ("done" if approve else "denied")
    finally:
        await session.close()


async def test_conflict_and_timeout_do_not_write():
    writes = []

    def commit(args, preview):
        raise ValueError("stale")

    session = await started(
        [Tool("write", "", SCHEMA, "approval", commit, lambda a: deepcopy(a))],
        approval_timeout=0.02,
    )
    try:
        receipt = await session.call("write", {"version": 1})
        await session.decide(receipt["id"], True)
        assert session.approvals[receipt["id"]].status == "conflict"
        receipt = await session.call("write", {"version": 2})
        session.tools["write"] = Tool(
            "write", "", SCHEMA, "approval", lambda *_: writes.append(True), lambda a: a
        )
        await asyncio.sleep(1.1)
        assert session.approvals[receipt["id"]].status == "denied" and not writes
        session.tools["write"] = Tool(
            "write",
            "",
            SCHEMA,
            "approval",
            lambda *_: {"ok": False, "files": [{"stored": False}]},
            lambda a: a,
        )
        session.approval_timeout = 600
        receipt = await session.call("write", {"version": 3})
        await session.decide(receipt["id"], True)
        assert session.approvals[receipt["id"]].status == "error"
        assert session.approvals[receipt["id"]].result["files"] == [{"stored": False}]
    finally:
        await session.close()


async def test_cancel_during_preview_cannot_create_a_late_approval():
    entered, release = threading.Event(), threading.Event()

    def preview(args):
        entered.set()
        release.wait(5)
        return args

    session = await started([Tool("write", "", SCHEMA, "approval", lambda *_: None, preview)])
    task = asyncio.create_task(session.call("write", {"version": 1}))
    try:
        await asyncio.to_thread(entered.wait, 2)
        await session.cancel()
        release.set()
        result = await task
        assert not session.approvals and result["ok"] is False
        assert session.driver.cancelled
    finally:
        release.set()
        await session.close()


async def test_allowlist_schema_and_context():
    session = await started([Tool("read", "", SCHEMA, "server", lambda a, _: a)])
    try:
        with pytest.raises(ValueError):
            await session.call("shell", {})
        with pytest.raises(ValueError):
            await session.call("read", {"version": True})
        with pytest.raises(ValueError):
            await session.call("read", {"version": 1, "injection": "ignore the user"})
        session.context = {"folder": "Work"}
        assert await session.call("get_ui_context", {}) == {"folder": "Work"}
        assert await session.call("read", {"version": 1}) == {"version": 1}
    finally:
        await session.close()
    assert not session.ui_token and not session.mcp_token
    with pytest.raises(ValueError):
        await session.call("read", {"version": 1})


async def test_ui_timeout_disconnected_result_and_foreign_ids():
    events = []

    async def emit(kind, **payload):
        events.append((kind, payload))

    bridge = UIBridge(emit, lambda: False, 0.01)
    assert (await bridge.call("open", {}, "run"))["reason"] == "no_ui"
    bridge.connected = lambda: True
    assert (await bridge.call("open", {}, "run"))["reason"] == "timeout"
    task = asyncio.create_task(bridge.call("open", {}, "run"))
    await asyncio.sleep(0)
    assert not bridge.resolve("other-session", True, {})
    assert bridge.resolve(events[-1][1]["id"], False, {"reason": "user_busy"})
    assert (await task)["result"]["reason"] == "user_busy"
    assert not bridge.pending


async def test_replay_is_bounded_and_contiguous():
    session = await started()
    try:
        assert [e["seq"] for e in session.replay(0)] == [1, 2]
        for _ in range(4100):
            await session.emit("text_delta", text="x")
        assert len(session.events) == 4096
        with pytest.raises(ValueError, match="expired"):
            session.replay(0)
        assert session.replay(session.sequence - 1)[0]["seq"] == session.sequence
    finally:
        await session.close()


@pytest.mark.parametrize(
    "value", [[], {"version": "1"}, {"version": -1}, {"version": 1, "unexpected": 2}]
)
def test_schema_rejects_invalid_arguments(value):
    with pytest.raises(ValueError):
        validate(value, SCHEMA)
