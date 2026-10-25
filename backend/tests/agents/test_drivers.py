import asyncio
import os
from pathlib import Path
import sys

import pytest

from symbiknow.api.agents.bridge.claude import ClaudeDriver
from symbiknow.api.agents.bridge.codex import CodexDriver
from symbiknow.api.agents.bridge.gemini import GeminiDriver
from symbiknow.api.agents.bridge.driver import DriverConfig, DriverError, JsonRpc, Process


@pytest.fixture
def fake_cli(tmp_path):
    path = tmp_path / "agent"
    path.write_text(
        f"#!{sys.executable}\n"
        + """import json, sys, time, os
args = sys.argv[1:]
def emit(value):
    print(json.dumps(value), flush=True)
if "--input-format" in args:
    if '--model' in args:
        assert args[args.index('--model')+1] == 'sonnet'
        assert args[args.index('--effort')+1] == 'low'
    message = json.loads(sys.stdin.readline())["message"]["content"]
    tools = ["shell"] if message == "unsafe" else ["mcp__application__search"]
    emit({"type":"system", "subtype":"init", "session_id":"native-thread", "tools":tools})
    if message == "wait":
        child = os.fork()
        if child == 0:
            time.sleep(90)
        emit({"type":"child", "pid":child})
        time.sleep(90)
    if message == "crash":
        sys.exit(1)
    emit({"type":"stream_event", "event":{"delta":{"type":"text_delta", "text":"Hello "}}})
    emit({"type":"stream_event", "event":{"delta":{"type":"text_delta", "text":"again" if "--resume" in args else "world"}}})
    emit({"type":"result", "session_id":"native-thread", "is_error":False})
else:
    for line in sys.stdin:
        m = json.loads(line)
        if m.get("method") == "test":
            emit({"jsonrpc":"2.0", "id":900, "method":"session/request_permission", "params":{}})
            response = json.loads(sys.stdin.readline())
            emit({"jsonrpc":"2.0", "id":m["id"], "result":response["result"]})
        elif m.get("method") == "initialize":
            emit({"jsonrpc":"2.0", "id":m["id"], "result":{"protocolVersion":1}})
        elif m.get("method") == "session/new":
            emit({"jsonrpc":"2.0", "id":m["id"], "result":{"sessionId":"native-gemini"}})
        elif m.get("method") == "session/prompt":
            emit({"jsonrpc":"2.0", "method":"session/update", "params":{"update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"Gemini reply"}}}})
            emit({"jsonrpc":"2.0", "id":m["id"], "result":{"stopReason":"end_turn"}})
        elif "id" in m:
            emit({"jsonrpc":"2.0", "id":m["id"], "result":{}})
"""
    )
    path.chmod(0o700)
    return str(path)


async def driver(fake_cli, tmp_path):
    result = ClaudeDriver()
    events = []

    async def emit(kind, **kwargs):
        events.append((kind, kwargs))

    await result.start(
        DriverConfig(
            fake_cli,
            tmp_path,
            "http://127.0.0.1/mcp",
            "secret",
            ("search",),
            "Test",
            model="sonnet",
            effort="low",
        ),
        emit,
    )
    return result, events


async def test_claude_two_turns_and_resume(fake_cli, tmp_path):
    agent, events = await driver(fake_cli, tmp_path)
    await agent.send("First")
    await agent.send("Second")
    assert [e[1]["text"] for e in events] == ["Hello ", "world", "Hello ", "again"]
    assert agent.native_id == "native-thread" and agent.process is None


@pytest.mark.parametrize("message", ["unsafe", "crash"])
async def test_claude_fails_closed(fake_cli, tmp_path, message):
    agent, events = await driver(fake_cli, tmp_path)
    with pytest.raises(DriverError):
        await agent.send(message)
    assert not events and agent.process is None


async def test_native_permissions_always_denied(fake_cli, tmp_path):
    rpc = JsonRpc()
    await rpc.launch([fake_cli], tmp_path)
    rpc.reader = asyncio.create_task(rpc.listen())
    try:
        assert await rpc.request("test", {}) == {"outcome": {"outcome": "cancelled"}}
    finally:
        await rpc.stop()


async def test_process_group_cleanup_and_no_api_key_forwarding(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "do-not-forward")
    process = Process()
    script = """import os, time, json, signal
pid = os.fork()
if pid == 0:
    time.sleep(90)
else:
    def finish(*args):
        os.waitpid(pid, 0)
        sys_exit(0)
    from sys import exit as sys_exit
    signal.signal(signal.SIGTERM, finish)
    print(json.dumps({"child":pid, "key_forwarded":"ANTHROPIC_API_KEY" in os.environ}), flush=True)
    time.sleep(90)
"""
    await process.launch([sys.executable, "-c", script], tmp_path)
    value = await process.read()
    assert not value["key_forwarded"]
    parent = process.process.pid
    await process.stop()
    with pytest.raises(ProcessLookupError):
        os.kill(parent, 0)
    with pytest.raises(ProcessLookupError):
        os.kill(value["child"], 0)


async def test_codex_and_gemini_event_mapping():
    events = []

    async def emit(kind, **kwargs):
        events.append((kind, kwargs))

    codex = CodexDriver()
    codex.emit = emit
    codex.turn = asyncio.get_running_loop().create_future()
    await codex.on_notification({"method": "item/agentMessage/delta", "params": {"delta": "Codex"}})
    await codex.on_notification(
        {"method": "turn/completed", "params": {"turn": {"status": "completed"}}}
    )
    assert codex.turn.done()
    gemini = GeminiDriver()
    gemini.emit = emit
    await gemini.on_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "Gemini"},
                }
            },
        }
    )
    assert [e[1]["text"] for e in events] == ["Codex", "Gemini"]
    with pytest.raises(FileNotFoundError):
        await codex.start(DriverConfig("missing", Path("/tmp"), "", "", (), ""), emit)


async def test_gemini_candidate_acp_two_turns_and_resume(fake_cli, tmp_path):
    import json

    agent = GeminiDriver()
    events = []

    async def emit(kind, **kwargs):
        events.append((kind, kwargs))

    config = DriverConfig(
        fake_cli,
        tmp_path,
        "http://127.0.0.1/mcp",
        "private-token",
        ("search",),
        "Test instructions",
    )
    try:
        await agent.start(config, emit)
        await agent.send("First")
        await agent.cancel()
        await agent.send("Second")
        assert agent.native_id == "native-gemini"
        assert [event[1]["text"] for event in events] == ["Gemini reply", "Gemini reply"]
        settings = (tmp_path / "bridge-settings.json").read_text()
        assert "private-token" not in settings
        assert json.loads(settings)["tools"]["core"] == []
    finally:
        await agent.stop()
