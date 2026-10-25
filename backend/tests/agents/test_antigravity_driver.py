import asyncio
import json
import os
import sys

import pytest

from symbiknow.api.agents.bridge.antigravity import AntigravityDriver
from symbiknow.api.agents.bridge.antigravity_config import NATIVE_REGISTRY, prepare
from symbiknow.api.agents.bridge.driver import DriverConfig, DriverError


@pytest.fixture
def native_cli(tmp_path):
    path = tmp_path / "agy-fixture"
    path.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json, sys, pathlib, os, select, time
args=sys.argv[1:]
root=pathlib.Path.cwd().parent
case=(root/'case').read_text() if (root/'case').exists() else ''
if '--version' in args:
    print('1.4.5' if case=='version' else '1.4.6');sys.exit()
profile=pathlib.Path(next(a.split('=',1)[1] for a in args if a.startswith('--gemini_dir=')))
spec=json.loads((profile/'config/agents/symbiknow.md').read_text().split('---')[1])
assert spec['tools']==['finish'] and spec['excludeDefaultComponents'] is True
assert spec['inheritCustomizations'] is False and spec['inheritMcp'] is False
assert spec['hooks']==spec['plugins']==spec['rules']==spec['agents']==[]
assert (profile/'config/.migrated').exists()
assert json.loads((profile/'config/mcp_config.json').read_text())=={'mcpServers':{}}
if args[-1]=='agents':
    print('unexpected-agent' if case=='catalog' else 'symbiknow');sys.exit()
assert '--dangerously-skip-permissions' not in args
assert '--disable-slash-commands' in args
assert '--model' in args and args[args.index('--model')+1]=='fixture-model'
assert args[args.index('--effort')+1]=='low'
assert 'ANTHROPIC_API_KEY' not in os.environ
assert not select.select([sys.stdin],[],[],.02)[0], 'input before init verification'
identity='f9aa5171-1b2c-45c8-968f-0c76c110c31c'
def emit(value): print(json.dumps(value),flush=True)
tools=json.loads((root/'registry.json').read_text())
if case=='registry':tools.append('unknown-native-tool')
emit({'event':'init','conversation_id':identity,'init':{
    'agent':'wrong-agent' if case=='agent' else 'symbiknow',
    'cwd':str(pathlib.Path.cwd()),'permission_mode':'request-review','tools':tools,'model':'fixture-model'}})
for line in sys.stdin:
    event=json.loads(line);assert event['event']=='user'
    text=event['message']['content']
    with (root/'prompts.jsonl').open('a') as f:f.write(json.dumps({'text':text,'resumed':'--conversation' in args})+'\n')
    if text=='wait':time.sleep(60)
    if text=='crash':sys.exit(1)
    if text=='native':
        emit({'event':'step_update','step_update':{'conversation_id':identity,'step_type':'tool','tool_name':'run_command'}});continue
    if text=='other-conversation':
        emit({'event':'result','result':{'conversation_id':'other','status':'SUCCESS','response':'leak'}});continue
    if text=='mcp':
        emit({'event':'step_update','step_update':{'conversation_id':identity,'step_type':'tool','tool_name':'mcp__search'}})
    if text!='fallback':
        for delta in ['Hello ',text]:emit({'event':'step_update','step_update':{'conversation_id':identity,'step_type':'agent_response','text_delta':delta}})
    emit({'event':'result','result':{'conversation_id':identity,'status':'ERROR' if text=='error' else 'SUCCESS','response':'fallback' if text=='fallback' else 'Hello '+text,'error':'private-token must not leak'}})
"""
    )
    path.chmod(0o700)
    (tmp_path / "registry.json").write_text(json.dumps(sorted(NATIVE_REGISTRY)))
    return str(path)


def config(executable, tmp_path):
    return DriverConfig(
        executable,
        tmp_path,
        "http://127.0.0.1/mcp",
        "private-token",
        ("search", "propose_write"),
        "Application instructions",
        model="fixture-model",
        effort="low",
    )


async def start(executable, tmp_path):
    events = []

    async def emit(kind, **payload):
        events.append((kind, payload))

    driver = AntigravityDriver()
    await driver.start(config(executable, tmp_path), emit)
    return driver, events


async def test_native_stream_two_turns_cancel_resume_and_result_fallback(
    native_cli, tmp_path, monkeypatch
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "never-forward")
    driver, events = await start(native_cli, tmp_path)
    try:
        await driver.send("first")
        await driver.send("mcp")
        await driver.cancel()
        await driver.send("fallback")
        assert [p["text"] for k, p in events if k == "text_delta"] == [
            "Hello ",
            "first",
            "Hello ",
            "mcp",
            "fallback",
        ]
        rows = [json.loads(s) for s in (tmp_path / "prompts.jsonl").read_text().splitlines() if s]
        assert [r["resumed"] for r in rows] == [False, False, True]
    finally:
        await driver.stop()


@pytest.mark.parametrize("case", ["version", "catalog", "registry", "agent"])
async def test_rejects_unverified_provider_before_any_user_input(native_cli, tmp_path, case):
    (tmp_path / "case").write_text(case)
    with pytest.raises(DriverError):
        await start(native_cli, tmp_path)
    assert not (tmp_path / "prompts.jsonl").exists()


@pytest.mark.parametrize("message", ["native", "other-conversation", "crash", "error"])
async def test_fails_closed_on_native_tools_foreign_results_and_provider_errors(
    native_cli, tmp_path, message
):
    driver, _ = await start(native_cli, tmp_path)
    with pytest.raises(DriverError) as exc:
        await driver.send(message)
    assert "private-token" not in str(exc.value)
    assert driver.process is None


async def test_cancel_stops_process_without_waiting_for_provider(native_cli, tmp_path):
    driver, _ = await start(native_cli, tmp_path)
    task = asyncio.create_task(driver.send("wait"))
    await asyncio.sleep(0.05)
    pid = driver.process.pid
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert driver.process is None
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_profile_has_only_exact_application_tools_and_private_credentials(tmp_path):
    profile, workspace = prepare(config("unused", tmp_path))
    assert profile.parent == workspace.parent == tmp_path
    agent = profile / "config/agents/symbiknow.md"
    assert agent.stat().st_mode & 0o777 == 0o600
    spec = json.loads(agent.read_text().split("---")[1])
    assert spec["mcpServers"] == [
        {
            "serverName": "application",
            "serverUrl": "http://127.0.0.1/mcp",
            "headers": {"Authorization": "Bearer private-token"},
            "enabledTools": ["search", "propose_write"],
            "forceAllToolsEager": True,
            "timeoutSeconds": 120,
        }
    ]
    permissions = json.loads((profile / "antigravity-cli/settings.json").read_text())["permissions"]
    assert permissions["allow"] == ["mcp(application/search)", "mcp(application/propose_write)"]
    assert "command(*)" in permissions["deny"]
    assert not list(workspace.iterdir())
    assert AntigravityDriver.supports_version("1.4.7")
    assert AntigravityDriver.supports_version("agy version 1.5.0")
    assert not AntigravityDriver.supports_version("1.4.5")
    assert not AntigravityDriver.supports_version("1.4.6 malicious")
