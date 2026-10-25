"""Verify the native Codex registry with a local model stub, without account inference.

Uses the production restriction builder and only cached public model metadata.
The synthetic model tries shell, patch, web and code-mode calls even when absent
from the advertised inventory. No account credentials or prompts are recorded.
"""

import argparse
import asyncio
import json
from pathlib import Path
import socket
import tempfile

from starlette.responses import StreamingResponse
import uvicorn

from probe_codex import Fixture, Rpc
from symbiknow.api.agents.bridge.codex_config import restricted_catalog, restrictions


class AdversarialFixture(Fixture):
    attempted = ("exec_command", "apply_patch", "web", "exec")

    def __init__(self, root):
        super().__init__(root)
        self.request_count = 0
        self.rejections = set()

    async def model(self, request):
        payload = await request.json()
        for key, value in payload.get("client_metadata", {}).items():
            if "turn-metadata" in key and isinstance(value, str):
                metadata = json.loads(value)
                self.tool_metadata = {k: v for k, v in metadata.items() if "tool" in k}
        self.tools = payload.get("tools", [])
        # Retain only the rejected call IDs, never model input or output text.
        for item in payload.get("input", []):
            if item.get("type") == "function_call_output":
                output = str(item.get("output", "")).lower()
                if any(
                    word in output
                    for word in (
                        "unknown",
                        "unrecognized",
                        "unsupported",
                        "not found",
                        "not available",
                    )
                ):
                    self.rejections.add(item.get("call_id"))
        index = self.request_count
        self.request_count += 1
        if index < len(self.attempted):
            name = self.attempted[index]
            args = {"cmd": "printf forbidden", "prompt": "forbidden"}
            item = {
                "id": f"item-{index}",
                "type": "function_call",
                "name": name,
                "call_id": f"call-{index}",
                "arguments": json.dumps(args),
            }
        else:
            item = {
                "id": "fixture-message",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "fixture", "annotations": []}],
            }

        async def stream():
            events = [
                {"type": "response.created", "response": {"id": f"response-{index}"}},
                {"type": "response.output_item.added", "output_index": 0, "item": item},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {
                    "type": "response.completed",
                    "response": {
                        "id": f"response-{index}",
                        "status": "completed",
                        "output": [item],
                        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                    },
                },
            ]
            for event in events:
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")


async def probe(model):
    with tempfile.TemporaryDirectory(prefix="codex-isolation-") as directory:
        root = Path(directory)
        catalog = root / "catalog.json"
        catalog.write_text(json.dumps(restricted_catalog(model)))
        fixture = AdversarialFixture(root / "library")
        cwd = root / "empty"
        cwd.mkdir()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(fixture.app, log_level="critical", access_log=False))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        config = restrictions() | {
            "model": model,
            "model_catalog_json": str(catalog),
            "model_provider": "fixture",
            "model_providers.fixture.name": "Local protocol fixture",
            "model_providers.fixture.base_url": f"http://127.0.0.1:{port}",
            "model_providers.fixture.wire_api": "responses",
            "model_providers.fixture.requires_openai_auth": False,
        }
        try:
            while not server.started:
                await asyncio.sleep(0.01)
            async with Rpc(str(cwd), config, fixture.token) as rpc:
                thread = await rpc.isolated_thread(
                    {
                        "cwd": str(cwd),
                        "sandbox": "read-only",
                        "approvalPolicy": "never",
                        "ephemeral": True,
                        "environments": [],
                        "dynamicTools": [
                            {
                                "type": "function",
                                "name": "download",
                                "description": "Read application document",
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {},
                                    "additionalProperties": False,
                                },
                            }
                        ],
                    }
                )
                turn = await rpc.turn(thread["thread"]["id"], "Run the fixture.")
                assert turn["status"] == "completed"
            names = {t.get("name", t.get("type")) for t in fixture.tools}
            for namespace in fixture.tool_metadata.get("tool_namespaces_info", {}).values():
                names.update(namespace.get("functions", {}))
            assert names == {"download"}, names
            assert len(fixture.rejections) == len(fixture.attempted), fixture.rejections
            return {
                "model": model,
                "advertised_tools": sorted(names),
                "rejected_native_calls": list(fixture.attempted),
                "passed": True,
            }
        finally:
            server.should_exit = True
            await task


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gpt-6.1-sol")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(probe(args.model)), indent=2))
