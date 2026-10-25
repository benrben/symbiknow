"""Loopback transport for local agent sessions; credentials never enter URLs."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from copy import deepcopy
import hmac
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocketDisconnect

from .bridge.claude import ClaudeDriver
from .bridge.antigravity import AntigravityDriver
from .bridge.codex import CodexDriver
from .bridge.gemini import GeminiDriver
from .bridge.driver import DriverError, Process
from .bridge.sessions import Session
from .bridge.models import discover_models, select_model
from .symbiknow import INSTRUCTIONS, ProductTools, display_payload


def provider_executable(provider):
    """Antigravity installs `agy`; its provider identity is not a binary name."""
    command = "agy" if provider == "antigravity" else provider
    executable = shutil.which(command)
    if not executable and provider == "antigravity":
        local = Path.home() / ".local" / "bin" / command
        if local.is_file() and os.access(local, os.X_OK):
            executable = str(local)
    return executable


async def cli_output(executable, flag):
    with tempfile.TemporaryDirectory(prefix="agent-detect-") as directory:
        owner = Process()
        try:
            await owner.launch([executable, flag], Path(directory))
            output, _ = await asyncio.wait_for(owner.process.communicate(), 5)
            return output.decode(errors="replace")[:50000]
        except (TimeoutError, OSError):
            return ""
        finally:
            await owner.stop()


async def detect():
    result = []
    for name, title in [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("antigravity", "Antigravity CLI"),
        ("gemini", "Gemini CLI"),
    ]:
        executable = provider_executable(name)
        version = (await cli_output(executable, "--version")).strip()[:120] if executable else ""
        supported, reason = False, f"Install {title} and sign in with its CLI."
        if executable:
            reason = (
                "This Codex version has not passed the tool-isolation check."
                if name == "codex"
                else "Gemini ACP is untested; connection is disabled."
            )
            if name == "claude":
                help_text = await cli_output(executable, "--help")
                supported = all(
                    flag in help_text
                    for flag in (
                        "--restricted",
                        "--tools",
                        "--strict-mcp-config",
                        "--permission-prompts",
                        "--setting-sources",
                    )
                )
                reason = (
                    "Uses your existing CLI login."
                    if supported
                    else "Please update Claude Code; required tool restrictions are missing."
                )
            elif name == "codex":
                supported = CodexDriver.supports_version(version)
                if supported:
                    reason = "Uses your existing CLI login with application-only tools."
            elif name == "antigravity":
                supported = AntigravityDriver.supports_version(version)
                reason = (
                    "Uses your existing CLI login with an isolated application-only agent."
                    if supported
                    else "This Antigravity version has not passed the chat isolation check."
                )
        result.append(
            {
                "id": name,
                "name": title,
                "installed": bool(executable),
                "version": version,
                "available": supported,
                "reason": reason,
                "untested": name == "gemini",
            }
        )
    return result


def local_origin(headers):
    host, origin = headers.get("host", ""), headers.get("origin", "")
    try:
        return (
            urlsplit("http://" + host).hostname in {"localhost", "127.0.0.1", "::1"}
            and origin == "http://" + host
        )
    except ValueError:
        return False


async def body(request, limit=2 * 1024 * 1024):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise ValueError("Request exceeds the size limit")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("Expected an object")
    return value


def context(value):
    """Bounded view metadata only; never document bodies, HTML or arbitrary keys."""
    if not isinstance(value, dict):
        raise ValueError("Invalid UI context")
    result = {}
    doc = value.get("open_document")
    if isinstance(doc, dict):
        result["open_document"] = {
            key: str(doc[key])[:200] for key in ("document_id", "version", "title") if key in doc
        }
    if isinstance(value.get("folder"), str):
        result["folder"] = value["folder"][:2000]
    result["selection"] = (
        [item[:200] for item in value.get("selection", [])[:100] if isinstance(item, str)]
        if isinstance(value.get("selection", []), list)
        else []
    )
    for key in ("query", "group", "project"):
        if isinstance(value.get(key), str):
            result[key] = value[key][:2000]
    enums = {
        "scope": {"all", "recent", "unfiled", "folder", "group", "project"},
        "surface": {"library", "split", "reader"},
        "view": {"list", "grid", "map"},
        "mode": {"semantic", "grep"},
        "sort": {"filename", "type", "date", "relevance"},
        "reader_tab": {"document", "evidence", "versions", "connections", "details"},
    }
    for key, choices in enums.items():
        if isinstance(value.get(key), str) and value[key] in choices:
            result[key] = value[key]
    for key in ("ready", "descending", "reader_expanded", "visible_documents_truncated"):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    for key in ("folders", "groups"):
        if isinstance(value.get(key), list):
            result[key] = [item[:2000] for item in value[key][:200] if isinstance(item, str)]
    for field, limit in (("visible_documents", 50), ("selection_documents", 100)):
        if not isinstance(value.get(field), list):
            continue
        result[field] = [
            {
                key: item[key][:200]
                for key in ("document_id", "version", "title")
                if isinstance(item.get(key), str)
            }
            for item in value[field][:limit]
            if isinstance(item, dict)
        ]
    count = value.get("loaded_document_count")
    if type(count) is int and 0 <= count <= 1000000:
        result["loaded_document_count"] = count
    fields = {
        "open_document": {"open_document", "reader_tab", "reader_expanded"},
        "selection": {"selection", "selection_documents"},
        "scope": {"scope", "folder", "group", "project", "folders", "groups"},
        "results": {"query", "mode", "view", "sort", "descending", "ready", "surface",
                    "visible_documents", "visible_documents_truncated", "loaded_document_count"},
    }
    if "context_policy" in value:
        policy = value["context_policy"]
        if not isinstance(policy, dict) or any(type(policy.get(key)) is not bool for key in fields):
            raise ValueError("Invalid context sharing choices")
        result["context_policy"] = {key: policy[key] for key in fields}
        for category, keys in fields.items():
            if not policy[category]:
                for key in keys:
                    result.pop(key, None)
    return result


def browser_result(value, session_context):
    """Browser navigation must obey the same sharing policy as chat messages."""
    if not isinstance(value, dict):
        return value
    result = dict(value)
    if isinstance(result.get("state"), dict):
        state = dict(result["state"])
        if "context_policy" in session_context:
            state["context_policy"] = session_context["context_policy"]
        result["state"] = context(state)
    return result


class AgentRoutes:
    def __init__(
        self,
        application,
        *,
        detector=detect,
        driver_factory=None,
        disconnect_timeout=30,
        model_loader=discover_models,
    ):
        self.application, self.detector, self.driver_factory = application, detector, driver_factory
        self.disconnect_timeout = disconnect_timeout
        self.sessions = {}
        self.creating = asyncio.Lock()
        self.model_loader = model_loader
        self.model_cache = {}
        self.loading_models = asyncio.Lock()

    def routes(self):
        return [
            Route("/api/agents", self.agents),
            Route("/api/agent-models", self.models, methods=["POST"]),
            Route("/api/agent-document", self.document),
            Route("/api/agent-sessions", self.create, methods=["POST"]),
            WebSocketRoute("/api/agent-chat/{identity}", self.socket),
            Route("/agent-mcp/{identity}", self.mcp, methods=["POST", "GET", "DELETE"]),
        ]

    async def document(self, request):
        from starlette.concurrency import run_in_threadpool

        def read():
            app = self.application()
            args = request.query_params
            with app.snapshots.read():
                ProductTools(app).document(args["id"], args["version"])
                detail = app.library.detail(args["id"], args["version"], "summary").to_wire()
                document = detail["document"]
                organization = detail.get("organization") or {}
                if organization.get("version") == args["version"]:
                    for key in ("folder", "groups"):
                        if key in organization:
                            document[key] = organization[key]
                if args.get("evidence"):
                    ref = (args["id"], args["version"], args["evidence"])
                    evidence = app.evidence.resolve_evidence_many([ref]).get(ref)
                    if not evidence:
                        raise ValueError("Evidence changed")
                    document["evidence"] = [evidence]
                return document

        try:
            return JSONResponse(await run_in_threadpool(read))
        except (ValueError, FileNotFoundError, KeyError):
            return JSONResponse({"error": "Document or evidence changed; search again"}, 409)

    async def agents(self, request):
        return JSONResponse({"agents": await self.detector()})

    async def catalog(self, provider, *, refresh=False):
        async with self.loading_models:
            cached = self.model_cache.get(provider["id"])
            if cached and not refresh and time.monotonic() - cached[0] < 60:
                return cached[1]
            models = await self.model_loader(
                provider["id"], provider_executable(provider["id"]) or provider["id"]
            )
            self.model_cache[provider["id"]] = (time.monotonic(), models)
            return models

    async def models(self, request):
        if not local_origin(request.headers) or request.headers.get("x-symbiknow-ui") != "1":
            return JSONResponse({"error": "Local same-origin access required"}, 403)
        try:
            args = await body(request, 1024)
            provider = next(
                (
                    p
                    for p in await self.detector()
                    if p["id"] == args.get("provider") and p["available"]
                ),
                None,
            )
            if not provider:
                raise DriverError("Choose an available CLI first")
            return JSONResponse(
                {"models": await self.catalog(provider, refresh=args.get("refresh") is True)}
            )
        except (ValueError, DriverError, OSError) as exc:
            return JSONResponse(
                {
                    "error": str(exc)
                    if isinstance(exc, DriverError)
                    else "Unable to load models. Check the CLI and try again."
                },
                400,
            )

    async def create(self, request):
        if not local_origin(request.headers) or request.headers.get("x-symbiknow-ui") != "1":
            return JSONResponse({"error": "Local same-origin access required"}, 403)
        session = None
        try:
            args = await body(request, 1024)
            async with self.creating:
                if len(self.sessions) >= 4:
                    raise ValueError("Close an existing agent chat first")
                provider = next(
                    (
                        p
                        for p in await self.detector()
                        if p["id"] == args.get("provider") and p["available"]
                    ),
                    None,
                )
                if not provider:
                    raise ValueError("This agent is unavailable; update its CLI or choose another")
                model, effort = args.get("model"), args.get("effort")
                if (
                    model is not None
                    and (not isinstance(model, str) or not model or len(model) > 200)
                ) or (effort is not None and (not isinstance(effort, str) or len(effort) > 20)):
                    raise DriverError("Choose a model and effort from the available options")
                selected = (
                    select_model(await self.catalog(provider), model, effort) if model else None
                )
                if effort and not selected:
                    raise DriverError("Choose a model before setting effort")
                factory = self.driver_factory or {
                    "claude": ClaudeDriver,
                    "codex": CodexDriver,
                    "antigravity": AntigravityDriver,
                    "gemini": GeminiDriver,
                }.get(provider["id"])
                if factory is None:
                    raise ValueError("Unknown provider")
                session = Session(
                    provider["name"],
                    factory(),
                    ProductTools(self.application()).registry(),
                    display=display_payload,
                )
                self.sessions[session.id] = session
                # Use the backend listener, not the UI proxy's Host/port.
                port = request.scope.get("server", ("127.0.0.1", 8765))[1]
                await session.start(
                    provider_executable(provider["id"]) or provider["id"],
                    f"http://127.0.0.1:{port}/agent-mcp/{session.id}",
                    INSTRUCTIONS,
                    model=model,
                    effort=effort or None,
                )
                session.expiry = asyncio.create_task(self.expire(session))
                return JSONResponse(
                    {
                        "session_id": session.id,
                        "token": session.ui_token,
                        "provider": provider["name"],
                        "model": model or getattr(session.driver, "model", ""),
                        "model_name": selected["name"] if selected else "CLI default",
                        "effort": effort or "",
                    }
                )
        except (ValueError, DriverError, OSError) as exc:
            if session:
                await self.remove(session)
            return JSONResponse(
                {
                    "error": str(exc)
                    if isinstance(exc, DriverError)
                    else "Unable to connect. Check the CLI version and login, then try again."
                },
                400,
            )

    async def expire(self, session):
        await asyncio.sleep(self.disconnect_timeout)
        if session.sink is None:
            await self.remove(session)

    async def remove(self, session):
        self.sessions.pop(session.id, None)
        if session.expiry and session.expiry is not asyncio.current_task():
            session.expiry.cancel()
        await session.close()

    async def close(self):
        await asyncio.gather(*(self.remove(s) for s in list(self.sessions.values())))

    async def socket(self, ws):
        session = self.sessions.get(ws.path_params["identity"])
        protocols = ws.scope.get("subprotocols", [])
        token = next((p[6:] for p in protocols if p.startswith("token.")), "")
        if (
            not local_origin(ws.headers)
            or not session
            or not hmac.compare_digest(token, session.ui_token)
            or "symbiknow-assistant" not in protocols
        ):
            await ws.close(code=1008)
            return
        if session.sink is not None:
            await ws.close(code=1008)
            return
        if session.expiry:
            session.expiry.cancel()
        await ws.accept(subprotocol="symbiknow-assistant")
        queue = asyncio.Queue(maxsize=4096)
        session.sink = queue
        writer = None
        try:
            first_text = await asyncio.wait_for(ws.receive_text(), 10)
            if len(first_text) > 1024:
                raise ValueError("Invalid replay request")
            first = json.loads(first_text)
            if (
                not isinstance(first, dict)
                or first.get("type") != "replay"
                or type(first.get("after")) is not int
            ):
                raise ValueError("Invalid replay request")
            for event in session.replay(first["after"]):
                await ws.send_json(event)

            async def send_events():
                while True:
                    await ws.send_json(await queue.get())

            writer = asyncio.create_task(send_events())
            while True:
                text = await ws.receive_text()
                if len(text) > 64000:
                    raise ValueError("Message exceeds the size limit")
                message = json.loads(text)
                if not isinstance(message, dict):
                    raise ValueError("Invalid message")
                kind = message.get("type")
                try:
                    if kind in {"approval", "ui_result"} and not isinstance(message.get("id"), str):
                        raise ValueError("Invalid call ID")
                    if kind == "send":
                        if "context" in message:
                            session.context = context(message["context"])
                        session.send(message.get("message"))
                    elif kind == "cancel":
                        await session.cancel()
                    elif kind == "approval":
                        if type(message.get("approve")) is not bool:
                            raise ValueError("Choose approve or deny")
                        session.request_decision(message.get("id"), message["approve"])
                    elif kind == "ui_result":
                        if type(message.get("ok")) is not bool:
                            raise ValueError("Invalid browser result")
                        result = browser_result(message.get("result"), session.context)
                        if session.ui.resolve(message.get("id"), message["ok"], result):
                            await session.emit(
                                "ui_result",
                                id=message["id"],
                                ok=message["ok"],
                                result=result,
                            )
                    elif kind == "context_update":
                        session.context = context(message)
                    elif kind == "close":
                        await self.remove(session)
                        break
                    else:
                        raise ValueError("Unsupported message")
                except ValueError as exc:
                    await session.emit("request_error", message=str(exc))
        except (WebSocketDisconnect, TimeoutError, ValueError):
            with suppress(RuntimeError, WebSocketDisconnect):
                await ws.close(code=1008)
        finally:
            if writer:
                writer.cancel()
                with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                    await writer
            session.sink = None
            session.ui.cancel("no_ui")
            if not session.closed:
                session.expiry = asyncio.create_task(self.expire(session))

    async def mcp(self, request):
        session = self.sessions.get(request.path_params["identity"])
        header = request.headers.get("authorization", "")
        if (
            not session
            or session.closed
            or not hmac.compare_digest(header, "Bearer " + session.mcp_token)
        ):
            return JSONResponse({"error": "Unauthorized"}, 401)
        # No SSE background channel is required; requests return bounded JSON.
        if request.method != "POST":
            return Response(status_code=405)
        identity = None
        try:
            message = await body(request)
            identity = message.get("id")
            method, params = message.get("method"), message.get("params", {})
            if method == "initialize":
                result = {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "Symbiknow session tools", "version": "1"},
                }
            elif method == "notifications/initialized":
                return Response(status_code=202)
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {
                    "tools": [
                        {"name": t.name, "description": t.description, "inputSchema": t.schema}
                        for t in session.tools.values()
                    ]
                    + [
                        {
                            "name": "await_approval",
                            "description": "Read an approval receipt; never repeats a write.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"id": {"type": "string"}},
                                "required": ["id"],
                                "additionalProperties": False,
                            },
                        },
                        {
                            "name": "get_ui_context",
                            "description": "Read current UI state, visible document IDs/titles, search, reader, folders and groups; no document bodies.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {},
                                "additionalProperties": False,
                            },
                        },
                    ]
                }
                if isinstance(session.driver, AntigravityDriver):
                    # agy otherwise defers MCP tools behind native discovery
                    # helpers. Supply the exact session allowlist eagerly.
                    for tool in result["tools"]:
                        tool["_meta"] = {"antigravity/alwaysLoad": True}
            elif method == "tools/call" and isinstance(params, dict):
                arguments = params.get("arguments", {})
                if not isinstance(arguments, dict) or not isinstance(params.get("name"), str):
                    raise ValueError("Invalid tool request")
                value = await session.call(params["name"], arguments)
                result = {
                    "content": [{"type": "text", "text": json.dumps(value)}],
                    "structuredContent": deepcopy(value),
                    "isError": isinstance(value, dict) and value.get("ok") is False,
                }
            else:
                return JSONResponse(
                    {
                        "jsonrpc": "2.0",
                        "id": identity,
                        "error": {"code": -32601, "message": "Method not available"},
                    }
                )
            return JSONResponse({"jsonrpc": "2.0", "id": identity, "result": result})
        except (ValueError, TypeError):
            return JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": identity,
                    "error": {
                        "code": -32602,
                        "message": "Invalid or unavailable session tool request",
                    },
                }
            )
