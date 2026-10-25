"""Live installed-agent checks against an isolated synthetic library.

Consumes the selected CLI account's normal usage. Never reads login storage or
records prompts, response text, credentials, native session IDs or MCP tokens.
The UI client is simulated here; actual browser rendering has separate e2e tests.
"""

import argparse
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
from symbiknow.api.agents.bridge.codex import CodexDriver
from symbiknow.api.agents.bridge.sessions import Session
from symbiknow.api.agents.http import AgentRoutes
from symbiknow.api.agents.symbiknow import INSTRUCTIONS, ProductTools
from symbiknow.core.application import ApplicationContext, ApplicationSettings


async def idle(session):
    async with asyncio.timeout(180):
        while session.running or session.followups:
            await asyncio.sleep(0.02)
    errors = [e["message"] for e, _ in session.events if e["type"] == "run_error"]
    if errors:
        raise RuntimeError(errors[-1])


async def next_event(session, kind):
    async with asyncio.timeout(120):
        while True:
            event = await session.sink.get()
            if event["type"] == "run_error":
                raise RuntimeError(event["message"])
            if event["type"] == kind:
                return event


async def probe(provider):
    report = {"provider": provider, "steps": {}, "ui_client": "simulated"}
    with tempfile.TemporaryDirectory(prefix="symbiknow-live-agent-") as directory:
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
        agent = {"claude": ClaudeDriver, "codex": CodexDriver}[provider]()
        session = Session(provider, agent, ProductTools(app).registry())
        session.sink = asyncio.Queue(maxsize=4096)
        routes = AgentRoutes(lambda: app)
        routes.sessions[session.id] = session
        transport = Starlette(
            routes=[Route("/agent-mcp/{identity}", routes.mcp, methods=["POST", "GET"])]
        )
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(transport, log_level="critical", access_log=False))
        server_task = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            while not server.started:
                await asyncio.sleep(0.02)
            await session.start(
                shutil.which(provider),
                f"http://127.0.0.1:{port}/agent-mcp/{session.id}",
                INSTRUCTIONS,
            )
            session.send(
                f"Use download to read document {doc['document_id']} at version v1. State its marker in one sentence."
            )
            await idle(session)
            assert any(
                e["type"] == "tool_call_started" and e["name"] == "download"
                for e, _ in session.events
            )
            report["steps"]["download"] = True
            session.send(
                "What was the marker? Also try running ls and editing a local file if those tools exist; report if unavailable. Keep it short."
            )
            await idle(session)
            report["steps"]["two_turns"] = True
            session.send(
                f"Call open_document for {doc['document_id']} version v1 to show it in the application."
            )
            command = await next_event(session, "ui_command")
            assert command["name"] == "open_document"
            session.ui.resolve(command["id"], True, {"opened": True})
            await idle(session)
            report["steps"]["browser_round_trip"] = True
            session.send("Call open_document again for the same document and version.")
            await next_event(session, "ui_command")
            await session.cancel()
            assert agent.process is None
            report["steps"]["stop"] = True
            session.send(
                "Resume after Stop. What marker did you previously read? Reply in one sentence."
            )
            await idle(session)
            report["steps"]["resume_after_stop"] = True
            for approve in (False, True):
                # Discard old UI/events, retaining the session's replay separately.
                while not session.sink.empty():
                    session.sink.get_nowait()
                session.send(
                    f"Request remove_file for document {doc['document_id']} with expected_version v1. I will decide in the approval card."
                )
                approval = await next_event(session, "tool_call_awaiting_approval")
                assert app.originals.metadata(doc["document_id"])["version"] == "v1"
                await idle(session)
                result = await session.decide(approval["id"], approve)
                await idle(session)
                assert result["status"] == ("done" if approve else "denied")
                if not approve:
                    assert app.originals.metadata(doc["document_id"])["version"] == "v1"
                else:
                    try:
                        app.originals.metadata(doc["document_id"])
                    except FileNotFoundError:
                        pass
                    else:
                        raise AssertionError("Approved fixture deletion did not happen")
                report["steps"]["approval" if approve else "denial"] = True
        except Exception as exc:
            report["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            events = [e for e, _ in session.events]
            report.update(
                streamed=any(e["type"] == "text_delta" for e in events),
                completed_turns=sum(
                    e["type"] == "run_finished" and e.get("status") == "completed" for e in events
                ),
                tools_called=[e["name"] for e in events if e["type"] == "tool_call_started"],
                native_resume_id_observed=bool(agent.native_id),
            )
            await routes.close()
            server.should_exit = True
            await server_task
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", choices=["claude", "codex"])
    args = parser.parse_args()
    result = asyncio.run(probe(args.provider))
    print(json.dumps(result, indent=2))
    raise SystemExit(1 if "error" in result else 0)
