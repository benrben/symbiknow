"""ZIP leases survive revocation without reopening deleted archive paths."""
import asyncio
from contextlib import contextmanager
from io import BytesIO
import uuid
import zipfile

import pytest
from starlette.requests import Request
from starlette.requests import ClientDisconnect

from symbiknow.api import http, mcp
from symbiknow.core.application import ApplicationContext
from symbiknow.library import storage
from symbiknow.transfers import exports


def prepared(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp, "DATA_DIR", tmp_path)
    context = ApplicationContext(tmp_path)
    meta = storage.save_file(tmp_path, b"private exported content", "private.txt")
    token = str(uuid.uuid4())
    exports.prepare(context, [{"document_id": meta["document_id"], "version": "v1"}], token)
    archive, _ = exports.path(context, token)
    content = archive.read_bytes()
    opened, handles = exports.opened, []

    @contextmanager
    def tracked(*args):
        with opened(*args) as item:
            handles.append(item[0])
            yield item

    monkeypatch.setattr(exports, "opened", tracked)
    return context, meta, token, content, handles


def request(token, range_header=None, method="GET"):
    return Request({"type": "http", "asgi": {"spec_version": "2.4"}, "method": method,
                    "path": "/api/export", "query_string": ("token=" + token).encode(),
                    "headers": [(b"range", range_header.encode())] if range_header else []})


async def consume(response, scope, *, disconnect=False):
    messages = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if disconnect and message["type"] == "http.response.body":
            raise OSError("Client disconnected")
        messages.append(message)

    await response(scope, receive, send)
    return messages


@pytest.mark.parametrize("mutation", ["delete", "expire"])
@pytest.mark.parametrize("range_header", [None, "bytes=0-9", "bytes=0-9,20-29"])
def test_admitted_export_survives_unlink_but_new_reads_fail(tmp_path, monkeypatch, mutation, range_header):
    context, meta, token, content, handles = prepared(tmp_path, monkeypatch)
    req = request(token, range_header)
    response = asyncio.run(http.selection_export(req))
    if mutation == "delete":
        storage.delete_document(tmp_path, meta["document_id"], "v1")
    else:
        monkeypatch.setattr(exports.time, "time", lambda: 10**12)
        exports.cleanup(tmp_path)
    assert not list((tmp_path / "temp" / "selection-exports").glob("*.zip"))
    messages = asyncio.run(consume(response, req.scope))
    body = b"".join(message.get("body", b"") for message in messages)
    assert messages[0]["status"] == (206 if range_header else 200)
    assert handles[0].closed
    if not range_header:
        with zipfile.ZipFile(BytesIO(body)) as archive:
            assert archive.read("private.txt") == b"private exported content"
    elif "," in range_header:
        assert content[:10] in body and content[20:30] in body
        assert len(body) == int(response.headers["content-length"])
    else:
        assert body == content[:10]
    with pytest.raises(FileNotFoundError):
        asyncio.run(http.selection_export(req))


@pytest.mark.parametrize("kind", ["disconnect", "invalid-range", "head"])
def test_export_descriptor_closes_on_every_response_path(tmp_path, monkeypatch, kind):
    _, _, token, _, handles = prepared(tmp_path, monkeypatch)
    req = request(token, "bytes=999999-" if kind == "invalid-range" else None, "HEAD" if kind == "head" else "GET")
    response = asyncio.run(http.selection_export(req))
    if kind == "disconnect":
        with pytest.raises(ClientDisconnect):
            asyncio.run(consume(response, req.scope, disconnect=True))
    else:
        messages = asyncio.run(consume(response, req.scope))
        assert messages[0]["status"] == (416 if kind == "invalid-range" else 200)
        assert not b"".join(message.get("body", b"") for message in messages)
    assert handles[0].closed


@pytest.mark.parametrize("reason", ["excessive", "stale"])
def test_export_retains_full_response_fallback_for_ignored_ranges(tmp_path, monkeypatch, reason):
    _, _, token, content, handles = prepared(tmp_path, monkeypatch)
    req = request(token, "bytes=" + ",".join(["0-1"] * 101) if reason == "excessive" else "bytes=0-9")
    if reason == "stale":
        req.scope["headers"].append((b"if-range", b'"stale-etag"'))
    response = asyncio.run(http.selection_export(req))
    messages = asyncio.run(consume(response, req.scope))
    assert messages[0]["status"] == 200
    assert b"".join(message.get("body", b"") for message in messages) == content
    assert handles[0].closed
