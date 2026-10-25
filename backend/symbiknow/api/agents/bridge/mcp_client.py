"""Small JSON-only HTTP MCP client for client-hosted provider tools."""

import json

import httpx

from .driver import DriverError


async def request(config, method, params=None):
    try:
        return await _request(config, method, params)
    except (httpx.HTTPError, ValueError) as exc:
        raise DriverError("Application tool connection failed; reconnect the agent") from exc


async def _request(config, method, params):
    # Never forward the session token to redirects, environment proxies, provider
    # processes or their transcripts. The application supplies this local URL.
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=90) as client:
        async with client.stream(
            "POST",
            config.mcp_url,
            headers={"Authorization": "Bearer " + config.token},
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        ) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 4 * 1024 * 1024:
                    raise DriverError("Application tool response exceeded the size limit")
            value = json.loads(data)
    if "error" in value or not isinstance(value.get("result"), dict):
        raise DriverError("Application tool request failed")
    return value["result"]
