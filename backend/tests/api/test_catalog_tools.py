"""Read-only inventory/organization tools share bounded application services."""
import asyncio
import subprocess
import sys

from mcp import Client
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from symbiknow.api import http, mcp
from symbiknow.api.agents.symbiknow import ProductTools
from symbiknow.cli.client import call, server_parameters
from symbiknow.core.application import ApplicationContext
from symbiknow.library import storage


READS = {"list_documents", "get_taxonomy", "list_jev_decisions", "get_organization_history", "list_jobs"}


def test_read_tool_discovery_preparation_and_bounds(tmp_path):
    async def exercise():
        async with Client(server_parameters(str(tmp_path), storage_only=True)) as client:
            tools = {item.name: item for item in (await client.list_tools()).tools}
            for name in READS:
                assert tools[name].annotations.read_only_hint
                assert not tools[name].annotations.destructive_hint
                assert not tools[name].annotations.open_world_hint
                assert name in client.instructions
                response = await client.call_tool(name, {"limit": 101})
                assert response.is_error
            inventory = await call(client, "list_documents", {})
            assert inventory["documents"] == [] and inventory["total_originals"] == 0
            assert (await call(client, "get_taxonomy", {}))["items"] == []
            assert (await call(client, "list_jev_decisions", {}))["decisions"] == []
            jobs = await call(client, "list_jobs", {})
            assert {row["kind"] for row in jobs["jobs"]} == {"library-catalog"}
            error = await client.call_tool("get_organization_history", {"document_id": "../../private/key"})
            assert error.is_error and "/private" not in error.content[0].text
    asyncio.run(exercise())


def test_http_mcp_and_agent_bridge_share_effective_metadata(tmp_path, monkeypatch):
    context = ApplicationContext(tmp_path)
    original = storage.save_file(tmp_path, b"original without evidence", "unregistered.data")
    context.catalog.prepare_taxonomy()
    monkeypatch.setattr(mcp, "application", lambda: context)
    app = Starlette(routes=[Route("/api/{action}", http.api, methods=["GET", "POST"])])
    with TestClient(app, base_url="http://localhost") as client:
        for route, operation in [("catalog", mcp.list_documents), ("taxonomy", mcp.get_taxonomy)]:
            response = client.get("/api/" + route)
            assert response.status_code == 200 and response.json() == operation()
        response = client.get("/api/organization-history", params={"id": original["document_id"]})
        assert response.status_code == 200
        assert response.json() == mcp.get_organization_history(original["document_id"])
        assert response.json()["current"]["indexing_status"] == "unregistered"
    bridge = {tool.name: tool for tool in ProductTools(context).registry()}
    for name in READS:
        assert bridge[name].kind == "server" and not bridge[name].preview
    assert bridge["list_documents"].invoke({}, None) == mcp.list_documents()
    assert bridge["get_organization_history"].invoke({"document_id": original["document_id"]}, None) == response.json()


def test_cli_discovers_read_commands():
    output = subprocess.run([sys.executable, "-m", "symbiknow.cli.client", "--help"], capture_output=True, text=True, check=True).stdout
    assert all(name.replace("_", "-") in output for name in READS)
