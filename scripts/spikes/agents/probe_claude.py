"""Optional installed-CLI smoke test using only an isolated synthetic library.

Never uses the user's library, reads auth storage, or records prompts/tokens/text.
Run with repository Python and PYTHONPATH=backend. This consumes the existing
Claude subscription's normal usage. No API key or unsafe permission mode.
"""

import asyncio
import base64
import json
from pathlib import Path
import shutil
import socket
import tempfile

from starlette.applications import Starlette
from starlette.routing import Route
import uvicorn

from symbiknow.api.agents.bridge.claude import ClaudeDriver
from symbiknow.api.agents.bridge.sessions import Session
from symbiknow.api.agents.http import AgentRoutes
from symbiknow.api.agents.symbiknow import INSTRUCTIONS, ProductTools
from symbiknow.core.application import ApplicationContext, ApplicationSettings


async def main():
    with tempfile.TemporaryDirectory(prefix="symbiknow-claude-probe-") as directory:
        app = ApplicationContext(
            Path(directory) / "library", settings=ApplicationSettings(storage_only=True)
        )
        doc = app.transfers.upload(
            [
                {
                    "filename": "probe.txt",
                    "content_base64": base64.b64encode(
                        b"Synthetic marker: cobalt-otter-42."
                    ).decode(),
                }
            ]
        )["files"][0]
        session = Session("Claude Code", ClaudeDriver(), ProductTools(app).registry())
        routes = AgentRoutes(lambda: app)
        routes.sessions[session.id] = session
        transport = Starlette(
            routes=[Route("/agent-mcp/{identity}", routes.mcp, methods=["POST", "GET"])]
        )
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(transport, log_level="critical", access_log=False))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            while not server.started:
                await asyncio.sleep(0.02)
            await session.start(
                shutil.which("claude"),
                f"http://127.0.0.1:{port}/agent-mcp/{session.id}",
                INSTRUCTIONS,
            )
            for message in [
                f"Use download to read document {doc['document_id']} version v1. State only its synthetic marker.",
                "What marker did you just read? Can you run ls or edit a local file with your available tools? Keep the answer to one sentence.",
            ]:
                session.send(message)
                await asyncio.wait_for(session.task, 120)
                if any(e["type"] == "run_error" for e, _ in session.events):
                    break
            events = [event for event, _ in session.events]
            print(
                json.dumps(
                    {
                        "kind": "installed_claude_synthetic",
                        "completed_turns": sum(e["type"] == "run_finished" for e in events),
                        "streamed": any(e["type"] == "text_delta" for e in events),
                        "tools_called": [
                            e["name"] for e in events if e["type"] == "tool_call_started"
                        ],
                        "errors": [e["message"] for e in events if e["type"] == "run_error"],
                        "diagnostics": session.driver.diagnostics,
                        "native_resume_id_observed": bool(session.driver.native_id),
                    },
                    indent=2,
                )
            )
        finally:
            await routes.close()
            server.should_exit = True
            await task


if __name__ == "__main__":
    asyncio.run(main())
