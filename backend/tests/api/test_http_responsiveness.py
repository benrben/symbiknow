"""Slow synchronous mutations must not monopolize the HTTP event loop."""
import asyncio
import threading
from types import SimpleNamespace

import httpx

from symbiknow.api import http as ui
from symbiknow.api import mcp as server
from symbiknow.core import retry


def test_retry_index_wait_does_not_block_other_http_requests(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    scheduled = []
    context = SimpleNamespace(DATA_DIR=tmp_path, write_lock=threading.RLock(), schedule=scheduled.append)
    monkeypatch.setattr(server, "application", lambda: context)
    monkeypatch.setattr(retry, "clear", lambda *_: None)

    def metadata(*_):
        entered.set()
        assert release.wait(2), "HTTP loop could not release the blocked operation"
        return {"version": "v1"}

    monkeypatch.setattr(ui.storage, "read_metadata", metadata)

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=ui.create_app()),
                                     base_url="http://127.0.0.1") as client:
            pending = asyncio.create_task(client.post("/api/retry-index", json={
                "document_id": "fixture", "expected_version": "v1"}, headers={
                "Origin": "http://127.0.0.1", "X-Symbiknow-UI": "1"}))
            try:
                assert await asyncio.to_thread(entered.wait, 2)
                assert not pending.done(), "Mutation blocked the HTTP event loop"
                response = await asyncio.wait_for(client.get("/api/unknown"), 1)
                assert response.status_code == 404
            finally:
                release.set()
            response = await pending
            assert response.status_code == 200
            assert response.json() == {"queued": True}

    asyncio.run(exercise())
    assert scheduled == ["fixture"]
