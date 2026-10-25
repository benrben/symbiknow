"""Two real HTTP MCP clients and human routes share exactly one worker/owner."""

import asyncio
import base64
import io
import zipfile
import socket
import threading
import time
import uuid

import httpx2
import uvicorn
from filelock import FileLock, Timeout
from mcp import Client

from symbiknow.api import mcp as server
from symbiknow.api import http as ui
from symbiknow.cli.client import call


def test_shared_http_clients_browser_and_one_worker(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("SYMBIKNOW_WARMUP", "0")
    starts = []
    actual_worker = server._worker

    def worker():
        starts.append(threading.current_thread().name)
        actual_worker()

    monkeypatch.setattr(server, "_worker", worker)
    # Unsupported bytes exercise the actual worker without loading model weights.
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    config = uvicorn.Config(ui.create_app(), host="127.0.0.1", port=port, log_level="warning")
    web = uvicorn.Server(config)
    thread = threading.Thread(target=web.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not web.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert web.started
    url = f"http://127.0.0.1:{port}"

    async def run():
        async with (
            Client(url + "/mcp") as first,
            Client(url + "/mcp") as second,
            httpx2.AsyncClient() as browser,
        ):
            tool_lists = await asyncio.gather(first.list_tools(), second.list_tools())
            assert all(
                {t.name for t in result.tools}
                == {"upload", "download", "search", "ask", "resolve_jev_decision",
                    "upload_folder", "download_folder", "remove_file", "get_job",
                    "list_documents", "get_taxonomy", "list_jev_decisions",
                    "get_organization_history", "list_jobs"}
                for result in tool_lists
            )
            saved = await call(
                first,
                "upload",
                {
                    "files": [
                        {
                            "filename": "concurrent.bin",
                            "content_base64": base64.b64encode(b"\x00\xffshared").decode(),
                            "request_id": str(uuid.uuid4()),
                        }
                    ]
                },
            )
            identity = saved["files"][0]["document_id"]
            downloads, listing, byte_response = await asyncio.gather(
                call(second, "download", {"files": [{"document_id": identity}]}),
                browser.get(url + "/api/library"),
                browser.get(url + "/api/download", params={"id": identity, "version": "v1"}),
            )
            assert (
                base64.b64decode(downloads["files"][0]["content_base64"])
                == byte_response.content
                == b"\x00\xffshared"
            )
            assert listing.json()["total"] == 1
            folder_upload = await call(
                first,
                "upload_folder",
                {
                    "folder": "HTTP folder",
                    "request_id": str(uuid.uuid4()),
                    "files": [
                        {
                            "relative_path": "nested/shared.bin",
                            "content_base64": base64.b64encode(b"folder bytes").decode(),
                        }
                    ],
                },
            )
            assert folder_upload["complete"]
            folder_zip = await call(second, "download_folder", {"folder": "HTTP folder"})
            with zipfile.ZipFile(
                io.BytesIO(base64.b64decode(folder_zip["content_base64"]))
            ) as archive:
                assert archive.read("nested/shared.bin") == b"folder bytes"
            assert starts == ["symbiknow-ingest"]
        # Disconnecting every MCP client does not release the application's owner.
        assert thread.is_alive()
        try:
            with FileLock(tmp_path / "server.lock", timeout=0):
                raise AssertionError("Owner lock was released on client disconnect")
        except Timeout:
            pass
        assert starts == ["symbiknow-ingest"]

    try:
        asyncio.run(run())
    finally:
        web.should_exit = True
        thread.join(15)
    assert not thread.is_alive()
    with FileLock(tmp_path / "server.lock", timeout=0):
        pass
