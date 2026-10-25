from contextlib import asynccontextmanager

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from symbiknow.api.agents.http import AgentRoutes, context
from symbiknow.api.agents.bridge.models import model_choice
from .test_sessions import FakeDriver


@pytest.fixture
def transport():
    async def detector():
        return [{"id": "fake", "name": "Fake", "available": True}]

    async def models(provider, executable):
        return [
            model_choice("fast", "Fast", "Quick answers", default=True, efforts=["low", "high"])
        ]

    routes = AgentRoutes(
        lambda: None, detector=detector, driver_factory=FakeDriver, model_loader=models
    )

    @asynccontextmanager
    async def lifespan(app):
        yield
        await routes.close()

    app = Starlette(routes=routes.routes(), lifespan=lifespan)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, routes


def connect(client):
    response = client.post(
        "/api/agent-sessions",
        json={"provider": "fake"},
        headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"},
    )
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize("origin", [None, "http://evil.example", "null", "http://localhost"])
def test_creation_requires_same_origin(transport, origin):
    client, routes = transport
    response = client.post(
        "/api/agent-sessions",
        json={"provider": "fake"},
        headers={"Origin": origin} if origin else {},
    )
    assert response.status_code == 403 and not routes.sessions


def test_socket_auth_mcp_scope_and_replay(transport):
    client, routes = transport
    first, second = connect(client), connect(client)
    path = "/api/agent-chat/" + first["session_id"]
    for origin, token in [
        ("http://evil.example", first["token"]),
        ("http://127.0.0.1", second["token"]),
        ("http://127.0.0.1", ""),
    ]:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                path,
                headers={"Origin": origin, "Host": "127.0.0.1"},
                subprotocols=["symbiknow-assistant", "token." + token],
            ):
                pass
    session = routes.sessions[first["session_id"]]
    mcp = "/agent-mcp/" + first["session_id"]
    request = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    for token in [first["token"], routes.sessions[second["session_id"]].mcp_token, "wrong"]:
        assert (
            client.post(mcp, json=request, headers={"Authorization": "Bearer " + token}).status_code
            == 401
        )
    headers = {"Authorization": "Bearer " + session.mcp_token}
    result = client.post(mcp, json=request, headers=headers).json()["result"]
    assert "remove_file" in {t["name"] for t in result["tools"]}
    assert "shell" not in {t["name"] for t in result["tools"]}
    protocols = ["symbiknow-assistant", "token." + first["token"]]
    with client.websocket_connect(
        path, headers={"Origin": "http://127.0.0.1", "Host": "127.0.0.1"}, subprotocols=protocols
    ) as ws:
        ws.send_json({"type": "replay", "after": 0})
        ws.send_json({"type": "context_update", "folder": "Work", "document_text": "private"})
        ws.send_json(
            {
                "type": "send",
                "message": "Question",
                "context": {
                    "surface": "reader",
                    "folder": "Current",
                    "document_text": "private",
                    "open_document": {"document_id": "opened", "version": "v2"},
                },
            }
        )
        event = ws.receive_json()
        assert event["type"] == "run_started" and event["seq"] == 1
        assert ws.receive_json()["type"] == "text_delta"
        response = client.post(
            mcp,
            json={**request, "method": "tools/call", "params": {"name": "get_ui_context"}},
            headers=headers,
        ).json()
        assert response["result"]["structuredContent"] == {
            "surface": "reader",
            "folder": "Current",
            "selection": [],
            "open_document": {"document_id": "opened", "version": "v2"},
        }
        assert '"folder": "Current"' in session.driver.message
        assert "private" not in session.driver.message
        response = client.post(
            mcp,
            json={**request, "method": "tools/call", "params": {"name": "shell"}},
            headers=headers,
        ).json()
        assert response["error"]["code"] == -32602
        ws.send_json({"type": "cancel"})
        assert ws.receive_json()["status"] == "cancelled"
    with client.websocket_connect(
        path, headers={"Origin": "http://127.0.0.1", "Host": "127.0.0.1"}, subprotocols=protocols
    ) as ws:
        ws.send_json({"type": "replay", "after": 1})
        assert ws.receive_json()["seq"] == 2
        assert ws.receive_json()["seq"] == 3
        ws.send_json({"type": "close"})
    assert client.post(mcp, json=request, headers=headers).status_code == 401


def test_context_drops_document_content():
    assert context(
        {
            "open_document": {"document_id": "id", "title": "Title", "text": "Secret"},
            "selection": ["e1"],
            "body": "Secret",
        }
    ) == {"open_document": {"document_id": "id", "title": "Title"}, "selection": ["e1"]}


def test_antigravity_receives_eager_tools_without_expanding_session_scope(transport):
    from symbiknow.api.agents.bridge.antigravity import AntigravityDriver

    client, routes = transport
    created = connect(client)
    session = routes.sessions[created["session_id"]]
    session.driver = AntigravityDriver()
    response = client.post(
        "/agent-mcp/" + session.id,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": "Bearer " + session.mcp_token},
    )
    tools = response.json()["result"]["tools"]
    assert {t["name"] for t in tools} == set(session.tools) | {"await_approval", "get_ui_context"}
    assert all(t["_meta"] == {"antigravity/alwaysLoad": True} for t in tools)
    assert session.mcp_token not in response.text


def test_model_discovery_and_explicit_selection(transport):
    client, routes = transport
    headers = {"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"}
    assert client.post("/api/agent-models", json={"provider": "fake"}).status_code == 403
    choices = client.post("/api/agent-models", json={"provider": "fake"}, headers=headers).json()
    assert choices["models"][0]["id"] == "fast"
    response = client.post(
        "/api/agent-sessions",
        json={"provider": "fake", "model": "fast", "effort": "high"},
        headers=headers,
    )
    assert response.status_code == 200
    session = response.json()
    assert (session["model"], session["model_name"], session["effort"]) == ("fast", "Fast", "high")
    config = routes.sessions[session["session_id"]].driver.config
    assert config.model == "fast" and config.effort == "high"


@pytest.mark.parametrize(
    "selection",
    [
        {"model": "unknown"},
        {"model": "--unsafe"},
        {"model": ["fast"]},
        {"model": "fast", "effort": "ultra"},
        {"effort": "high"},
        {"model": "fast", "effort": ["high"]},
    ],
)
def test_invalid_model_or_effort_cannot_start_a_session(transport, selection):
    client, routes = transport
    response = client.post(
        "/api/agent-sessions",
        json={"provider": "fake", **selection},
        headers={"Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"},
    )
    assert response.status_code == 400 and not routes.sessions


async def test_detection_enables_verified_codex_and_retains_missing_gemini(monkeypatch):
    from symbiknow.api.agents import http

    monkeypatch.setattr(
        http.shutil, "which", lambda name: "/bin/" + name if name != "gemini" else None
    )

    async def output(executable, flag):
        if executable.endswith("codex"):
            return "codex-cli 0.162.1"
        return "--restricted --tools --strict-mcp-config --permission-prompts --setting-sources"

    monkeypatch.setattr(http, "cli_output", output)
    providers = {p["id"]: p for p in await http.detect()}
    assert providers["claude"]["available"] and providers["codex"]["available"]
    assert not providers["gemini"]["available"] and not providers["gemini"]["installed"]


async def test_antigravity_detection_uses_agy_and_never_substitutes_gemini(monkeypatch):
    from symbiknow.api.agents import http

    monkeypatch.setattr(http.shutil, "which", lambda name: "/bin/agy" if name == "agy" else None)
    calls = []

    async def output(executable, flag):
        calls.append((executable, flag))
        return "1.4.6\n"

    monkeypatch.setattr(http, "cli_output", output)
    providers = {p["id"]: p for p in await http.detect()}
    antigravity = providers["antigravity"]
    assert antigravity["name"] == "Antigravity CLI"
    assert antigravity["installed"] and antigravity["version"] == "1.4.6"
    assert antigravity["available"]
    assert "isolated application-only" in antigravity["reason"]
    assert calls == [("/bin/agy", "--version")]
    assert not providers["gemini"]["installed"]


def test_antigravity_resolves_local_install_even_with_old_server_path(monkeypatch, tmp_path):
    from symbiknow.api.agents import http

    monkeypatch.setattr(http.shutil, "which", lambda name: None)
    monkeypatch.setattr(http.Path, "home", lambda: tmp_path)
    executable = tmp_path / ".local/bin/agy"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o600)
    assert http.provider_executable("antigravity") is None
    executable.chmod(0o700)
    assert http.provider_executable("antigravity") == str(executable)
    assert http.provider_executable("gemini") is None
    monkeypatch.setattr(http.shutil, "which", lambda name: "/custom/agy")
    assert http.provider_executable("antigravity") == "/custom/agy"


def test_ui_context_keeps_bounded_view_metadata_not_document_bodies():
    projected = context(
        {
            "scope": "folder",
            "surface": "reader",
            "visible_documents_truncated": True,
            "view": "grid",
            "mode": "grep",
            "sort": "filename",
            "reader_tab": "details",
            "ready": True,
            "descending": False,
            "reader_expanded": True,
            "query": "needle",
            "group": "Team",
            "folders": ["Work"] * 250,
            "groups": ["Team", 42],
            "visible_documents": [
                {"document_id": "d", "version": "v1", "title": "A", "body": "secret"}
            ]
            * 70,
            "html": "secret",
            "password": "secret",
        }
    )
    assert projected["scope"] == "folder" and projected["view"] == "grid"
    assert projected["surface"] == "reader" and projected["visible_documents_truncated"] is True
    assert projected["ready"] is True and projected["query"] == "needle"
    assert len(projected["folders"]) == 200 and projected["groups"] == ["Team"]
    assert len(projected["visible_documents"]) == 50
    assert projected["visible_documents"][0] == {"document_id": "d", "version": "v1", "title": "A"}
    assert "secret" not in str(projected)
    assert context({"scope": "arbitrary", "ready": "yes", "view": ["grid"]}) == {"selection": []}
