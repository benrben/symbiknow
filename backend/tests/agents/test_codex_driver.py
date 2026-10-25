import asyncio
import json
import sys

import pytest

from symbiknow.api.agents.bridge import codex, mcp_client
from symbiknow.api.agents.bridge.codex_config import restricted_catalog
from symbiknow.api.agents.bridge.driver import DriverConfig, DriverError


@pytest.fixture
def native_cli(tmp_path):
    executable = tmp_path / "codex-fixture"
    executable.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json, sys, pathlib, os
if '--version' in sys.argv:
    print('codex-cli 0.162.1')
    sys.exit(0)
config={}
for i, arg in enumerate(sys.argv[:-1]):
    if arg=='-c':
        key,value=sys.argv[i+1].split('=',1);config[key]=json.loads(value)
def emit(value):
    print(json.dumps(value),flush=True)
def reply(message,result):
    emit({'id':message['id'],'result':result})
for line in sys.stdin:
    m=json.loads(line); method=m.get('method')
    if method=='initialize': reply(m,{'userAgent':'fixture'})
    elif method=='config/read':reply(m,{'config':{'model':'fixture','mcp_servers':{'unrelated':{}}}})
    elif method=='model/list':reply(m,{'data':[{'model':'fixture','isDefault':True}]})
    elif method in ('thread/start','thread/resume'):
        with open('observed.jsonl','a') as f:
            f.write(json.dumps({'method':method,'params':m['params'],'config':config,'token_in_env':'LOCAL_AGENT_MCP_TOKEN' in os.environ})+'\n')
        reply(m,{'thread':{'id':'native-thread'}})
    elif method=='turn/start':
        reply(m,{'turn':{'id':'turn'}})
        text=m['params']['input'][0]['text']
        emit({'id':900,'method':'item/tool/call','params':{'tool':text,'arguments':{},'threadId':'native-thread','turnId':'turn','callId':'call'}})
        result=json.loads(sys.stdin.readline())['result']
        emit({'method':'item/agentMessage/delta','params':{'delta':'ok' if result['success'] else 'denied'}})
        emit({'method':'turn/completed','params':{'turn':{'id':'turn','status':'completed'}}})
"""
    )
    executable.chmod(0o700)
    return str(executable)


async def test_codex_two_turns_proxy_and_resume_without_exposing_token(
    native_cli, tmp_path, monkeypatch
):
    catalog = {"models": [{"slug": "fixture", "shell_type": "disabled"}]}
    monkeypatch.setattr(codex, "restricted_catalog", lambda model: catalog)
    requests = []

    async def mcp(config, method, params=None):
        requests.append((method, params))
        if method == "tools/list":
            return {
                "tools": [
                    {"name": "search", "description": "Search", "inputSchema": {"type": "object"}}
                ]
            }
        return {"content": [{"type": "text", "text": "result"}]}

    monkeypatch.setattr(mcp_client, "request", mcp)
    events = []

    async def emit(kind, **payload):
        events.append((kind, payload))

    driver = codex.CodexDriver()
    config = DriverConfig(
        native_cli,
        tmp_path,
        "http://127.0.0.1/mcp",
        "secret-token",
        ("search",),
        "Test",
        model="chosen-model",
        effort="high",
    )
    try:
        await driver.start(config, emit)
        await driver.send("search")
        await driver.cancel()
        await driver.send("exec_command")
        assert [e[1]["text"] for e in events] == ["ok", "denied"]
        assert requests == [
            ("tools/list", None),
            ("tools/call", {"name": "search", "arguments": {}}),
        ]
        observed = [json.loads(s) for s in (tmp_path / "observed.jsonl").read_text().splitlines()]
        assert [o["method"] for o in observed] == ["thread/start", "thread/resume"]
        for item in observed:
            assert item["params"]["model"] == "chosen-model"
            assert item["config"]["model_reasoning_effort"] == "high"
            assert item["config"]["mcp_servers.unrelated.enabled"] is False
            assert item["params"]["environments"] == []
            assert item["params"]["sandbox"] == "read-only"
            assert not item["token_in_env"]
            assert "secret-token" not in json.dumps(item)
        assert "secret-token" not in (tmp_path / "bridge-models.json").read_text()
    finally:
        await driver.stop()


def test_catalog_preserves_model_protocol_but_removes_all_native_capabilities(tmp_path):
    cache = tmp_path / "models.json"
    cache.write_text(
        json.dumps(
            {
                "identity": "private-account",
                "models": [
                    {
                        "slug": "fixture",
                        "display_name": "Fixture",
                        "shell_type": "unified_exec",
                        "apply_patch_tool_type": "freeform",
                        "experimental_supported_tools": ["clock"],
                        "tool_mode": "code_mode_only",
                        "use_responses_lite": True,
                        "model_messages": {"instructions_template": "Do not copy"},
                        "future_dangerous_feature": True,
                    }
                ],
            }
        )
    )
    result = restricted_catalog("fixture", cache)
    model = result["models"][0]
    assert model["slug"] == "fixture" and model["use_responses_lite"]
    assert model["shell_type"] == "disabled" and model["apply_patch_tool_type"] is None
    assert model["tool_mode"] == "direct" and model["experimental_supported_tools"] == []
    assert "future_dangerous_feature" not in model and "model_messages" not in model
    assert "private-account" not in json.dumps(result)
    with pytest.raises(DriverError, match="catalog"):
        restricted_catalog("missing", cache)


@pytest.mark.parametrize(
    "changes",
    [
        {"tool": "exec_command"},
        {"namespace": "other"},
        {"threadId": "other"},
        {"arguments": []},
    ],
)
async def test_client_tools_fail_closed(changes, tmp_path, monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("No HTTP call allowed")

    monkeypatch.setattr(mcp_client, "request", forbidden)
    driver = codex.CodexDriver()
    driver.config = DriverConfig("unused", tmp_path, "", "", ("search",), "")
    driver.native_id = "thread"
    driver.turn = asyncio.get_running_loop().create_future()
    response = await driver.handle_request(
        "item/tool/call",
        {
            "tool": "search",
            "threadId": "thread",
            "arguments": {},
            **changes,
        },
    )
    assert response["success"] is False
    assert await driver.handle_request("item/commandExecution/requestApproval", {}) == {
        "decision": "decline"
    }


def test_unknown_codex_versions_are_not_assumed_safe():
    assert codex.CodexDriver.supports_version("codex-cli 0.162.1")
    assert codex.CodexDriver.supports_version("codex-cli 0.164.0")
    assert codex.CodexDriver.supports_version("codex-cli 1.0.0")
    assert not codex.CodexDriver.supports_version("codex-cli 0.162.0")
    assert not codex.CodexDriver.supports_version("codex-cli 0.164.0 malicious")
    assert not codex.CodexDriver.supports_version("unknown")
