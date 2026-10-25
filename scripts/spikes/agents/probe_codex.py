"""Phase 0 only: inspect Codex's actual tools before permitting a live model turn.

Run with the repository Python. Uses a loopback model stub, no model account
or API key. Live model testing is deferred until the MCP-only boundary is proven.
Reports contain synthetic fixture events, never model requests,
credentials, or the session MCP token. This is not a production agent driver.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import tempfile
import time

from mcp.server import MCPServer
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route
import uvicorn

from symbiknow.core.application import ApplicationContext, ApplicationSettings
from symbiknow.api.agents.bridge.driver import child_environment


def restrictions() -> dict:
    # Read-only alone still allows shell reads. Disable execution separately.
    disabled = (
        "shell_tool", "unified_exec", "shell_snapshot", "shell_snapshot_v2",
        "apply_patch_freeform", "apps", "connectors", "plugins", "remote_plugin",
        "browser_use", "browser_use_external", "computer_use", "in_app_browser",
        "js_repl", "code_mode", "code_mode_only", "code_mode_host", "multi_agent",
        "multi_agent_v2", "collab", "image_generation", "imagegenext", "view_image",
        "memories", "memory_tool", "hooks", "codex_hooks", "plugin_hooks",
        "web_search", "web_search_cached", "web_search_request", "standalone_web_search",
        "skill_search", "skill_mcp_dependency_install", "workspace_dependencies",
        "goals", "tool_suggest", "request_permissions", "request_permissions_tool",
        "incremental_tools", "deferred_tool_world_state", "tool_search",
    )
    return {
        **{f"features.{key}": False for key in disabled},
        "features.skip_host_skill_discovery": True,
        "features.tool_registry.turn_metadata_includes_tool_info": True,
        "web_search": "disabled",
        "agents.enabled": False,
        "skills.include_instructions": False,
        "skills.bundled.enabled": False,
        "plugins._default.enabled": False,
        "apps._default.enabled": False,
        "project_doc_max_bytes": 0,
        "history.persistence": "none",
        "tools.update_plan.enabled": False,
    }


class Rpc:
    def __init__(self, cwd: str, config: dict, token: str):
        self.cwd, self.config, self.token = cwd, config, token
        self.pending = {}
        self.events = []
        self.queue = asyncio.Queue()
        self.next_id = 0

    async def __aenter__(self):
        # Config values go through argv, never shell interpolation. The MCP token
        # is supplied via an inherited env var, not argv or a persisted config.
        command = [shutil.which("codex"), "app-server"]
        for key, value in self.config.items():
            command += ["-c", f"{key}={json.dumps(value)}"]
        self.process = await asyncio.create_subprocess_exec(
            *command, cwd=self.cwd, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            env=child_environment({"SYMBIKNOW_SPIKE_MCP_TOKEN": self.token}),
        )
        self.reader = asyncio.create_task(self.read())
        try:
            await self.request("initialize", {
                "clientInfo": {"name": "symbiknow_phase0", "version": "0.1"},
                "capabilities": {"experimentalApi": True},
            })
            await self.send({"method": "initialized", "params": {}})
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, *_):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(self.process.wait(), 5)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGKILL)
            await self.process.wait()
        self.reader.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.reader

    async def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        await self.process.stdin.drain()

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if "method" in message:
                    # Fail closed on every host approval/dynamic tool request.
                    if "id" in message:
                        if message["method"].endswith("/requestApproval"):
                            response = {"result": {"decision": "decline"}}
                        else:
                            response = {"error": {"code": -32601, "message": "Not allowed"}}
                        await self.send({"id": message["id"], **response})
                    method = message["method"]
                    if method.startswith(("turn/", "item/")) or method == "error":
                        self.events.append(message)
                        await self.queue.put(message)
                elif (future := self.pending.get(message.get("id"))) and not future.done():
                    if "error" in message:
                        future.set_exception(RuntimeError(str(message["error"])))
                    else:
                        future.set_result(message.get("result"))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("app-server closed stdout"))

    async def request(self, method, params, *, timeout=45):
        self.next_id += 1
        request_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self.send({"id": request_id, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)

    async def isolated_thread(self, params, *, resume=False):
        # Empty tables merge with user config; they do NOT erase inherited MCP
        # servers. Ask the CLI for configuration metadata, retain names only,
        # and disable inherited servers before creating any thread. Auth storage
        # is never opened, copied, or queried by this probe.
        effective = await self.request("config/read", {"includeLayers": False})
        names = list(effective["config"].get("mcp_servers", {}))
        del effective
        if any(not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in names):
            raise RuntimeError("Cannot safely override an inherited MCP server name")
        overrides = {
            f"mcp_servers.{name}.enabled": False
            for name in names if name != "symbiknow_phase0"
        }
        return await self.request("thread/resume" if resume else "thread/start", {
            **params, "config": overrides,
        })

    async def turn(self, thread_id, text, *, interrupt=False, timeout=120):
        response = await self.request("turn/start", {
            "threadId": thread_id, "input": [{"type": "text", "text": text}],
        })
        turn_id = response["turn"]["id"]
        if interrupt:
            await self.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
        async with asyncio.timeout(timeout):
            while True:
                event = await self.queue.get()
                if (event["method"] == "turn/completed"
                        and event["params"]["turn"]["id"] == turn_id):
                    return event["params"]["turn"]


class Fixture:
    def __init__(self, root: Path):
        self.context = ApplicationContext(root, settings=ApplicationSettings(storage_only=True))
        self.token = secrets.token_urlsafe(32)
        self.tools = []
        self.model_request_keys = []
        self.tool_metadata = {}
        self.calls = []
        self.document_id = self.context.transfers.upload([{
            "filename": "agent-spike.txt",
            "content_base64": base64.b64encode(b"Synthetic marker: cobalt-otter-42.").decode(),
        }])["files"][0]["document_id"]
        server = MCPServer("symbiknow", log_level="ERROR")

        @server.tool()
        def download(files: list[dict]) -> dict:
            """Download synthetic fixture originals with Symbiknow's existing transfer service."""
            self.calls.append({"name": "download"})
            return self.context.transfers.download(files)

        @server.tool()
        async def approval_probe(seconds: int = 60) -> dict:
            """Simulate a human approval delay without writing anything. Bounded to 65 seconds."""
            seconds = max(0, min(seconds, 65))
            call = {"name": "approval_probe", "seconds": seconds, "state": "started"}
            self.calls.append(call)
            started = time.monotonic()
            try:
                await asyncio.sleep(seconds)
                call.update(state="completed", elapsed=round(time.monotonic() - started, 3))
                return {"ok": True, "waited_seconds": seconds}
            except asyncio.CancelledError:
                call.update(state="cancelled", elapsed=round(time.monotonic() - started, 3))
                raise

        self.app = server.streamable_http_app(stateless_http=True, json_response=True)
        self.app.router.routes.append(Route("/responses", self.model, methods=["POST"]))
        self.app.add_middleware(TokenGate, token=self.token)

    async def model(self, request):
        # Do not retain headers, prompt, system instructions, or tool arguments.
        payload = await request.json()
        self.model_request_keys = sorted(payload)
        metadata = payload.get("client_metadata", {})
        for key, value in metadata.items():
            if "turn-metadata" in key and isinstance(value, str):
                decoded = json.loads(value)
                self.tool_metadata = {key: value for key, value in decoded.items() if "tool" in key}
        self.tools = payload.get("tools", [])
        async def stream():
            message = {"id": "fixture-message", "type": "message", "role": "assistant",
                       "content": [{"type": "output_text", "text": "fixture", "annotations": []}]}
            events = [
                {"type": "response.created", "response": {"id": "fixture-response"}},
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**message, "content": []}},
                {"type": "response.content_part.added", "item_id": "fixture-message",
                 "output_index": 0, "content_index": 0,
                 "part": {"type": "output_text", "text": "", "annotations": []}},
                {"type": "response.output_text.delta", "item_id": "fixture-message",
                 "output_index": 0, "content_index": 0, "delta": "fixture"},
                {"type": "response.output_item.done", "output_index": 0, "item": message},
                {"type": "response.completed", "response": {
                    "id": "fixture-response", "status": "completed", "output": [message],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                }},
            ]
            for event in events:
                yield f"data: {json.dumps(event)}\n\n"
        return StreamingResponse(stream(), media_type="text/event-stream")


class TokenGate:
    def __init__(self, app, token):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/mcp"):
            headers = dict(scope["headers"])
            if not secrets.compare_digest(
                headers.get(b"authorization", b""), f"Bearer {self.token}".encode()
            ):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


async def probe(args):
    report = {"kind": "phase0_synthetic", "results": {}}
    version = await asyncio.create_subprocess_exec(
        "codex", "--version", env=child_environment(), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    report["codex_version"] = (await version.communicate())[0].decode().strip()
    with tempfile.TemporaryDirectory(prefix="symbiknow-agent-spike-") as directory:
        root = Path(directory)
        cwd = root / "empty"
        cwd.mkdir()
        fixture = Fixture(root / "library")
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(fixture.app, log_level="error", access_log=False))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        config = restrictions()
        # Rpc.isolated_thread disables inherited servers before creating a thread.
        config.update({
            "mcp_servers.symbiknow_phase0.url": f"http://127.0.0.1:{port}/mcp",
            "mcp_servers.symbiknow_phase0.bearer_token_env_var": "SYMBIKNOW_SPIKE_MCP_TOKEN",
            "mcp_servers.symbiknow_phase0.enabled_tools": ["download", "approval_probe"],
            "mcp_servers.symbiknow_phase0.required": True,
        })
        if args.tool_timeout is not None:
            config["mcp_servers.symbiknow_phase0.tool_timeout_sec"] = args.tool_timeout
        mock = dict(config)
        mock.update({
            "model_provider": "phase0_fixture",
            "model_providers.phase0_fixture.name": "Loopback protocol fixture",
            "model_providers.phase0_fixture.base_url": f"http://127.0.0.1:{port}",
            "model_providers.phase0_fixture.wire_api": "responses",
            "model_providers.phase0_fixture.requires_openai_auth": False,
            "model_providers.phase0_fixture.stream_max_retries": 0,
        })
        thread_params = {
            "cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "never",
            "baseInstructions": "This is a synthetic protocol probe. Use only Symbiknow MCP tools.",
        }
        try:
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.02)
            report["config_overrides"] = mock
            async with Rpc(str(cwd), mock, fixture.token) as rpc:
                thread = await rpc.isolated_thread({**thread_params, "ephemeral": True})
                status = await rpc.request("mcpServerStatus/list", {
                    "threadId": thread["thread"]["id"], "serverName": "symbiknow_phase0",
                })
                report["mcp_inventory"] = [
                    {"name": item.get("name"), "tools": list(item.get("tools", {}))}
                    for item in status.get("data", [])
                ]
                report["results"]["host_download"] = await rpc.request("mcpServer/tool/call", {
                    "threadId": thread["thread"]["id"], "server": "symbiknow_phase0",
                    "tool": "download", "arguments": {"files": [{"document_id": fixture.document_id}]},
                })
                report["results"]["mock_turn"] = await rpc.turn(thread["thread"]["id"], "Reply fixture.")
                report["results"]["mock_second_turn"] = await rpc.turn(
                    thread["thread"]["id"], "Reply fixture again.")
                if args.delay is not None:
                    started = time.monotonic()
                    try:
                        result = await rpc.request("mcpServer/tool/call", {
                            "threadId": thread["thread"]["id"], "server": "symbiknow_phase0",
                            "tool": "approval_probe", "arguments": {"seconds": args.delay},
                        }, timeout=90)
                        report["results"]["host_delay"] = {"result": result}
                    except Exception as error:
                        report["results"]["host_delay"] = {"error": str(error)}
                    report["results"]["host_delay"]["elapsed"] = round(time.monotonic() - started, 3)
                report["results"]["mock_interrupt"] = await rpc.turn(
                    thread["thread"]["id"], "Reply fixture after interruption.", interrupt=True)
                report["mock_events"] = rpc.events
            names = [tool.get("name", tool.get("type")) for tool in fixture.tools]
            # Newer models advertise namespace tools in request metadata instead
            # of the top-level Responses tools array. Treat both as authoritative.
            for namespace, info in fixture.tool_metadata.get("tool_namespaces_info", {}).items():
                names.extend(f"{namespace}__{name}" for name in info.get("functions", {}))
            names = sorted(set(names))
            report["tool_names"] = names
            report["model_request_keys"] = fixture.model_request_keys
            report["tool_metadata"] = fixture.tool_metadata
            unexpected = [name for name in names if name not in {
                "mcp__symbiknow_phase0__download", "mcp__symbiknow_phase0__approval_probe",
            }]
            report["unexpected_tools"] = unexpected
            if unexpected or not names:
                report["results"]["live"] = "blocked: tool inventory is not MCP-only"
        except Exception as error:
            report["error"] = f"{type(error).__name__}: {error}"
        finally:
            report["fixture_calls"] = fixture.calls
            server.should_exit = True
            await task
            sock.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Safety check: even an unexpected protocol error must not persist the token.
    args.output.write_text(json.dumps(report, indent=2).replace(fixture.token, "[redacted]"))
    print(json.dumps({"report": str(args.output), "tools": report.get("tool_names"),
                      "error": report.get("error"), "results": list(report["results"])}))
    return 1 if report.get("error") or report.get("unexpected_tools") or not report.get("tool_names") else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool-timeout", type=int)
    parser.add_argument("--delay", type=int, choices=range(0, 66), metavar="0..65")
    parser.add_argument("--output", type=Path, default=Path("artifacts/agents/codex-phase0.json"))
    raise SystemExit(asyncio.run(probe(parser.parse_args())))
