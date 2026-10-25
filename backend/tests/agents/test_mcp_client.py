import json

import httpx
import pytest

from symbiknow.api.agents.bridge import mcp_client
from symbiknow.api.agents.bridge.driver import DriverConfig, DriverError


@pytest.mark.parametrize("status", [200, 302, 401])
async def test_token_only_goes_to_original_endpoint(tmp_path, monkeypatch, status):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(
            status, headers={"Location": "https://other.example/"}, json={"result": {"tools": []}}
        )

    client = httpx.AsyncClient

    def factory(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return client(**kwargs, transport=httpx.MockTransport(handle))

    monkeypatch.setattr(mcp_client.httpx, "AsyncClient", factory)
    config = DriverConfig("", tmp_path, "http://127.0.0.1/mcp", "private-token", (), "")
    if status == 200:
        assert await mcp_client.request(config, "tools/list") == {"tools": []}
    else:
        with pytest.raises(DriverError, match="connection failed"):
            await mcp_client.request(config, "tools/list")
    assert len(requests) == 1
    assert str(requests[0].url) == config.mcp_url
    assert requests[0].headers["authorization"] == "Bearer private-token"
    assert "private-token" not in json.dumps(json.loads(requests[0].content))
