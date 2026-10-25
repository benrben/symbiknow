"""Optional real agy smoke: synthetic originals, application tools and denied deletion.

Consumes normal CLI account usage. Never reads the live library or auth storage.
Configuration/transcripts are temporary; output contains only timings and booleans.
Run with repository Python. Requires an already authenticated agy 1.4.6.
"""

import argparse
import asyncio
import base64
import json
from pathlib import Path
import socket
import tempfile
import time

from starlette.applications import Starlette
import uvicorn

from symbiknow.api.agents.bridge.antigravity import AntigravityDriver
from symbiknow.api.agents.bridge.sessions import Session
from symbiknow.api.agents.http import AgentRoutes, provider_executable
from symbiknow.api.agents.symbiknow import INSTRUCTIONS, ProductTools
from symbiknow.core.application import ApplicationContext, ApplicationSettings


async def probe(model=None):
    with tempfile.TemporaryDirectory(prefix="symbiknow-agy-library-") as directory:
        app = ApplicationContext(
            Path(directory) / "library", settings=ApplicationSettings(storage_only=True)
        )
        content = b"Synthetic marker: cobalt-otter-42."
        doc = app.transfers.upload(
            [{"filename": "probe.txt", "content_base64": base64.b64encode(content).decode()}]
        )["files"][0]
        session = Session("Antigravity CLI", AntigravityDriver(), ProductTools(app).registry())
        routes = AgentRoutes(lambda: app)
        routes.sessions[session.id] = session
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(
                Starlette(routes=routes.routes()),
                log_level="critical",
                access_log=False,
                lifespan="off",
            )
        )
        server_task = asyncio.create_task(server.serve(sockets=[sock]))
        report = {
            "kind": "installed_antigravity_synthetic_library",
            "version": "1.4.6",
            "turns": [],
        }

        async def turn(message):
            before = session.sequence
            started = time.monotonic()
            session.send(message)
            await asyncio.wait_for(session.task, 150)
            events = session.replay(before)
            errors = [e["message"] for e in events if e["type"] == "run_error"]
            text = "".join(e.get("text", "") for e in events if e["type"] == "text_delta")
            report["turns"].append(
                {
                    "seconds": round(time.monotonic() - started, 2),
                    "tools_called": [e["name"] for e in events if e["type"] == "tool_call_started"],
                    "streamed": bool(text),
                    "errors": errors,
                }
            )
            assert not errors, errors
            return text

        try:
            while not server.started:
                await asyncio.sleep(0.02)
            await session.start(
                provider_executable("antigravity"),
                f"http://127.0.0.1:{port}/agent-mcp/{session.id}",
                INSTRUCTIONS,
                model=model,
                effort="low",
            )
            answer = await turn(
                f"Use download to read document {doc['document_id']} version v1. "
                "State only its synthetic marker. Do not call any other tools."
            )
            assert "download" in report["turns"][-1]["tools_called"]
            assert "cobalt-otter-42" in answer
            await turn(
                f"Propose removing document {doc['document_id']} at expected_version v1 using "
                "remove_file once. This is only a proposal. Stop and await explicit approval."
            )
            pending = [
                (key, value)
                for key, value in session.approvals.items()
                if value.status == "pending"
            ]
            assert len(pending) == 1
            assert app.originals.metadata(doc["document_id"])["version"] == "v1"
            identity, approval = pending[0]
            await session.decide(identity, False)
            await asyncio.sleep(0.05)
            if session.running:
                await asyncio.wait_for(session.task, 150)
            assert approval.status == "denied"
            assert app.originals.metadata(doc["document_id"])["version"] == "v1"
            report["denied_deletion_preserved_original"] = True
            await session.driver.cancel()
            answer = await turn(
                "What synthetic marker did you read earlier? Use conversation history only, no tools."
            )
            report["resume_preserved_history"] = "cobalt-otter-42" in answer
            assert report["resume_preserved_history"]
            report["passed"] = True
            return report
        finally:
            await routes.close()
            server.should_exit = True
            await server_task


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = json.dumps(asyncio.run(probe(args.model)), indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result)
    print(result, end="")
