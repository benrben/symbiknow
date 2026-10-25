import json
from pathlib import Path
import sys

import pytest

from symbiknow.api.agents.bridge.models import discover_models, model_choice, select_model
from symbiknow.api.agents.bridge.driver import DriverError


@pytest.mark.parametrize("provider", ["claude", "codex"])
async def test_catalog_discovery_is_metadata_only_and_projects_no_account_fields(
    tmp_path, provider
):
    executable = tmp_path / "catalog"
    observed = tmp_path / "calls.jsonl"
    executable.write_text(
        f"#!{sys.executable}\nOBSERVED={str(observed)!r}\n"
        + r"""
import json,sys
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
    m=json.loads(line)
    with open(OBSERVED,'a') as f: f.write(json.dumps(m)+'\n')
    if m.get('type')=='control_request':
        assert '--restricted' in sys.argv and '--strict-mcp-config' in sys.argv
        assert sys.argv[sys.argv.index('--tools')+1]==''
        emit({'type':'control_response','response':{'request_id':m['request_id'],'response':{
            'account':{'email':'private@example.invalid'},
            'models':[{'value':'default','displayName':'Recommended','description':'Quick',
                       'supportedEffortLevels':['low','high'],'secret':'private'}]}}})
    elif m.get('method')=='initialize': emit({'id':m['id'],'result':{}})
    elif m.get('method')=='config/read': emit({'id':m['id'],'result':{'config':{'model':'fast','private':'secret'}}})
    elif m.get('method')=='model/list':
        if m['params'].get('cursor'):
            emit({'id':m['id'],'result':{'data':[{'model':'hidden','hidden':True}]}})
        else:
            emit({'id':m['id'],'result':{'data':[{'model':'fast','displayName':'Fast','description':'Quick',
                'defaultReasoningEffort':'low','supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'high'}],
                'private':'secret'}],'nextCursor':'page2'}})
    elif m.get('method')!='initialized': raise AssertionError('Unexpected inference call')
"""
    )
    executable.chmod(0o700)
    models = await discover_models(provider, str(executable))
    assert len(models) == 1 and models[0]["efforts"] == ["low", "high"]
    assert models[0]["default"]
    assert "private" not in json.dumps(models) and "secret" not in json.dumps(models)
    calls = [json.loads(line) for line in observed.read_text().splitlines()]
    assert not any(
        c.get("type") == "user" or c.get("method", "").startswith(("thread/", "turn/"))
        for c in calls
    )


def test_model_selection_validates_identity_and_per_model_effort():
    assert model_choice("--model", "bad", "") is None
    model = model_choice("valid", "Valid", "", efforts=["low", "bad", "high"])
    assert model["efforts"] == ["low", "high"]
    assert select_model([model], "valid", "high") == model
    with pytest.raises(Exception, match="effort"):
        select_model([model], "valid", "ultra")
    with pytest.raises(Exception, match="available"):
        select_model([model], "missing", "low")


def antigravity_cli(tmp_path, output, *, returncode=0):
    executable = tmp_path / "agy"
    observed = tmp_path / "agy-call.json"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import json,os,sys\n"
        f"with open({str(observed)!r},'w') as f:\n"
        "    json.dump({'args':sys.argv[1:],'cwd':os.getcwd(),'input':sys.stdin.read()},f)\n"
        "sys.stderr.write('Fetching available models\\nprivate-account-error@example.invalid\\n')\n"
        f"sys.stdout.buffer.write({output!r})\n"
        f"sys.exit({returncode})\n"
    )
    executable.chmod(0o700)
    return executable, observed


async def test_antigravity_models_parse_installed_catalogue_without_inference(tmp_path):
    rows = [
        ("gemini-3.8-flash-high", "Gemini 3.8 Flash High"),
        ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
        ("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking"),
        ("gpt-oss-120b-medium", "GPT OSS 120B Medium"),
        ("new-model-not-hardcoded", "A newly installed model"),
    ]
    output = ("\n" + "\n".join(f"{identity}\t{name}" for identity, name in rows) + "\n").encode()
    executable, observed = antigravity_cli(tmp_path, output)
    models = await discover_models("antigravity", str(executable))
    assert [(model["id"], model["name"]) for model in models] == rows
    assert all(model["efforts"] == [] and model["default_effort"] == "" for model in models)
    assert all(not model["default"] for model in models)
    assert "Fetching" not in json.dumps(models) and "private-account" not in json.dumps(models)
    call = json.loads(observed.read_text())
    assert call["args"] == ["models"] and call["input"] == ""
    assert Path(call["cwd"]).name.startswith("agent-models-")
    assert Path(call["cwd"]) != tmp_path and not Path(call["cwd"]).exists()


async def test_antigravity_models_deduplicate_metadata_choices(tmp_path):
    executable, _ = antigravity_cli(tmp_path, b"model-one\tModel One\nmodel-one\tModel One\n")
    assert len(await discover_models("antigravity", str(executable))) == 1


@pytest.mark.parametrize(
    "output",
    [
        b"",
        b"Fetching available models\n",
        b"valid\t\n",
        b"--unsafe\tName\n",
        b"valid\tName\textra\n",
        b"valid\tName\nmalformed\n",
        b"valid\t\xff\n",
        b"x" * (1024 * 1024 + 1),
        "\n".join(f"model-{i}\tModel {i}" for i in range(201)).encode(),
    ],
)
async def test_antigravity_model_catalogue_rejects_empty_or_malformed_output(tmp_path, output):
    executable, _ = antigravity_cli(tmp_path, output)
    with pytest.raises(DriverError) as failure:
        await discover_models("antigravity", str(executable))
    assert "private-account" not in str(failure.value)
    assert "Fetching" not in str(failure.value)


async def test_antigravity_model_catalogue_nonzero_exit_is_sanitized(tmp_path):
    executable, _ = antigravity_cli(tmp_path, b"model-one\tModel One\n", returncode=3)
    with pytest.raises(DriverError, match="Antigravity models") as failure:
        await discover_models("antigravity", str(executable))
    assert "private-account" not in str(failure.value)


async def test_antigravity_model_discovery_uses_existing_deadline(tmp_path, monkeypatch):
    import asyncio
    from symbiknow.api.agents.bridge import models

    executable = tmp_path / "agy"
    executable.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(60)\n")
    executable.chmod(0o700)
    deadline = asyncio.timeout

    def short_deadline(seconds):
        assert seconds == 30
        return deadline(0.05)

    monkeypatch.setattr(models.asyncio, "timeout", short_deadline)
    with pytest.raises(DriverError, match="Unable to load models"):
        await discover_models("antigravity", str(executable))
