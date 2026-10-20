"""Folder MCP contracts and exact-byte round trips, isolated from the real library."""

import asyncio
import base64
import hashlib
import io
import json
import uuid
import zipfile

import pytest
from mcp import Client

from symbiknow.transfers import folders as folder_transfer
from symbiknow.organization import edits as organization_edits
from symbiknow.api import mcp as server
from symbiknow.library import storage
from symbiknow.cli.client import call, download_folder, server_parameters, upload_folder


def b64(value):
    return base64.b64encode(value).decode("ascii")


def test_folder_stdio_round_trip_restart_and_snapshot(tmp_path):
    async def run():
        directory = tmp_path / "source"
        (directory / "nested").mkdir(parents=True)
        (directory / "one.txt").write_bytes(b"original one")
        big = bytes(range(256)) * 1200
        (directory / "nested" / "two.bin").write_bytes(big)
        data = tmp_path / "data"
        request = str(uuid.uuid4())
        async with Client(server_parameters(str(data), storage_only=True)) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
            assert set(tools) == {
                "upload",
                "download",
                "search",
                "upload_folder",
                "download_folder",
                "remove_file",
                "scan_freshness",
                "get_freshness_scan",
                "cancel_freshness_scan",
                "review_freshness_finding",
            }
            assert set(tools["upload_folder"].input_schema["required"]) == {
                "folder",
                "files",
                "request_id",
            }
            uploaded = await upload_folder(
                client, directory, "Project", request, chunk_bytes=200000
            )
            assert len(uploaded["files"]) == 2
            assert all(x["stored"] and x["folder_assigned"] for x in uploaded["files"])
            repeated = await upload_folder(
                client, directory, "Project", request, chunk_bytes=200000
            )
            assert [(x["document_id"], x["version"]) for x in repeated["files"]] == [
                (x["document_id"], "v1") for x in uploaded["files"]
            ]
            one = next(x for x in uploaded["files"] if x["relative_path"] == "one.txt")
            snapshot = await call(client, "download_folder", {"folder": "Project", "length": 37})
            assert snapshot["file_count"] == 2 and not snapshot["eof"]
            changed = await call(
                client,
                "upload_folder",
                {
                    "folder": "Project",
                    "request_id": str(uuid.uuid4()),
                    "files": [
                        {
                            "relative_path": "one.txt",
                            "content_base64": b64(b"new one"),
                            "document_id": one["document_id"],
                            "expected_version": "v1",
                        }
                    ],
                },
            )
            assert changed["files"][0]["version"] == "v2"
            assert organization_edits.override(data, one["document_id"])["folder"] == "Project"
        # A restart preserves upload identities, assignments and the unexpired ZIP snapshot.
        async with Client(server_parameters(str(data), storage_only=True)) as client:
            content = base64.b64decode(snapshot["content_base64"])
            while len(content) < snapshot["size"]:
                piece = await call(
                    client,
                    "download_folder",
                    {
                        "folder": "Project",
                        "transfer_id": snapshot["transfer_id"],
                        "offset": len(content),
                        "length": 100000,
                    },
                )
                assert piece["sha256"] == snapshot["sha256"]
                content += base64.b64decode(piece["content_base64"])
            assert hashlib.sha256(content).hexdigest() == snapshot["sha256"]
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                assert set(archive.namelist()) == {"one.txt", "nested/two.bin"}
                assert archive.read("one.txt") == b"original one"
                assert archive.read("nested/two.bin") == big
            output = tmp_path / "folder.zip"
            downloaded = await download_folder(client, "Project", output, chunk_bytes=100000)
            assert downloaded["file_count"] == 2
            with zipfile.ZipFile(output) as archive:
                assert archive.read("one.txt") == b"new one"
            with pytest.raises(FileExistsError):
                await download_folder(client, "Project", output)
            conflict = await call(
                client,
                "upload_folder",
                {
                    "folder": "Project",
                    "request_id": str(uuid.uuid4()),
                    "files": [
                        {
                            "relative_path": "one.txt",
                            "content_base64": b64(b"conflict"),
                            "document_id": one["document_id"],
                            "expected_version": "v1",
                        }
                    ],
                },
            )
            assert not conflict["files"][0]["stored"]
            assert conflict["files"][0]["current_version"] == "v2"
        assert len(storage.list_versions(data, one["document_id"])) == 2

    asyncio.run(run())


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", True)
    server.status_cache.clear()
    return tmp_path


def put(folder="Root", path="a.txt", content=b"a", request=None, **extra):
    return server.upload_folder(
        folder,
        [{"relative_path": path, "content_base64": b64(content), **extra}],
        request or str(uuid.uuid4()),
    )


@pytest.mark.parametrize(
    "path", ["../escape", "/absolute", "a//b", "./a", "a/../b", "C:/a", "a\\b", "a/ b", "a\x00b"]
)
def test_invalid_paths_never_store(isolated, path):
    with pytest.raises(ValueError):
        put(path=path)
    assert not (isolated / "files").exists()


def test_assignment_retry_partial_failures_and_manual_move(isolated, monkeypatch):
    request = str(uuid.uuid4())
    original = organization_edits.edit
    monkeypatch.setattr(
        organization_edits,
        "edit",
        lambda *a: (_ for _ in ()).throw(ValueError("temporary assignment failure")),
    )
    first = put(request=request)["files"][0]
    assert first["stored"] and not first["folder_assigned"]
    monkeypatch.setattr(organization_edits, "edit", original)
    second = put(request=request)["files"][0]
    assert second["document_id"] == first["document_id"] and second["version"] == "v1"
    assert second["folder_assigned"]
    original(
        "move-documents",
        {
            "folder": "Elsewhere",
            "documents": [{"document_id": first["document_id"], "expected_version": "v1"}],
        },
    )
    assert put(request=request)["files"][0]["folder_assigned"]
    assert organization_edits.override(isolated, first["document_id"])["folder"] == "Elsewhere"
    with pytest.raises(ValueError, match="different destination"):
        put(folder="Other", request=request)
    bad = put(content=b"different", request=request)["files"][0]
    assert not bad["stored"]
    other = put(path="other.txt")["files"][0]
    bad = put(request=request, document_id=other["document_id"], expected_version="v1")["files"][0]
    assert not bad["stored"] and "different metadata" in bad["error"]
    batch = server.upload_folder(
        "Root",
        [
            {"relative_path": "ok.txt", "content_base64": b64(b"ok")},
            {"relative_path": "bad.txt", "content_base64": "bad!"},
        ],
        str(uuid.uuid4()),
    )
    assert batch["files"][0]["stored"] and not batch["files"][1]["stored"] and not batch["complete"]


def test_folder_snapshot_scope_collisions_and_bounds(isolated, monkeypatch):
    put(path="same.txt", content=b"one")
    put(path="same.txt", content=b"two")
    put(folder="Root / Child", path="deep.txt", content=b"deep")
    put(folder="Rootish", path="excluded.txt", content=b"no")
    result = server.download_folder("Root")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["content_base64"]))) as archive:
        assert set(archive.namelist()) == {"same.txt", "same (2).txt", "Child/deep.txt"}
        assert {archive.read(n) for n in archive.namelist()} == {b"one", b"two", b"deep"}
    with pytest.raises(ValueError, match="another folder"):
        server.download_folder("Rootish", result["transfer_id"])
    with pytest.raises(ValueError, match="archive size"):
        server.download_folder("Root", result["transfer_id"], result["size"] + 1)
    with pytest.raises(ValueError, match="Start at offset"):
        server.download_folder("Root", offset=1)
    with pytest.raises(ValueError, match="Folder not found"):
        server.download_folder("Missing")
    monkeypatch.setattr(folder_transfer, "MAX_EXPORT_FILES", 2)
    with pytest.raises(ValueError, match="limit is 2"):
        server.download_folder("Root")
    monkeypatch.setattr(folder_transfer, "MAX_EXPORT_FILES", 1000)
    monkeypatch.setattr(folder_transfer, "MAX_EXPORT_BYTES", 1)
    with pytest.raises(ValueError, match="1 GiB"):
        server.download_folder("Root")
    state_path = isolated / "temp" / "folder-exports" / (result["transfer_id"] + ".json")
    state = json.loads(state_path.read_text())
    state["expires_at"] = 0
    state_path.write_text(json.dumps(state))
    with pytest.raises(ValueError, match="expired"):
        server.download_folder("Root", result["transfer_id"])


def test_path_file_directory_collision_and_failed_export_cleanup(isolated, monkeypatch):
    put(path="nested", content=b"file")
    put(folder="Root / nested", path="file.txt", content=b"child")
    result = server.download_folder("Root")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["content_base64"]))) as archive:
        assert len(archive.namelist()) == 2
        assert {archive.read(n) for n in archive.namelist()} == {b"file", b"child"}
        names = [n.casefold() for n in archive.namelist()]
        assert not any(a.startswith(b + "/") for a in names for b in names)
    before = set((isolated / "temp" / "folder-exports").glob("*"))
    monkeypatch.setattr(
        storage, "verified_file", lambda *a: (_ for _ in ()).throw(FileNotFoundError("deleted"))
    )
    with pytest.raises(FileNotFoundError):
        server.download_folder("Root")
    assert set((isolated / "temp" / "folder-exports").glob("*")) == before


def test_folder_chunk_resume_across_restart(tmp_path):
    async def run():
        data = tmp_path / "data"
        content = b"first part\x00second part"
        common = {"folder": "Resume", "request_id": str(uuid.uuid4())}
        item = {
            "relative_path": "nested/file.bin",
            "total_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        async with Client(server_parameters(str(data), storage_only=True)) as client:
            first = await call(
                client,
                "upload_folder",
                {
                    **common,
                    "files": [
                        {**item, "offset": 0, "content_base64": b64(content[:10]), "final": False}
                    ],
                },
            )
            assert not first["complete"] and first["files"][0]["received_bytes"] == 10
        async with Client(server_parameters(str(data), storage_only=True)) as client:
            last = {
                **common,
                "files": [
                    {**item, "offset": 10, "content_base64": b64(content[10:]), "final": True}
                ],
            }
            result = await call(client, "upload_folder", last)
            assert result["complete"] and result["files"][0]["version"] == "v1"
            replay = await call(client, "upload_folder", last)
            assert replay["files"][0]["document_id"] == result["files"][0]["document_id"]
            snapshot = await call(client, "download_folder", {"folder": "Resume"})
            with zipfile.ZipFile(
                io.BytesIO(base64.b64decode(snapshot["content_base64"]))
            ) as archive:
                assert archive.read("nested/file.bin") == content
            malformed = await client.call_tool(
                "upload_folder", {**common, "files": [{"relative_path": "missing.bin"}]}
            )
            assert malformed.is_error

    asyncio.run(run())


def test_export_slots_and_duplicate_path_preflight(isolated, monkeypatch):
    with pytest.raises(ValueError, match="Duplicate relative paths"):
        server.upload_folder(
            "Root",
            [{"relative_path": p, "content_base64": b64(b"a")} for p in ["a.txt", "A.txt"]],
            str(uuid.uuid4()),
        )
    assert not (isolated / "files").exists()
    put()
    snapshot = server.download_folder("Root")
    monkeypatch.setattr(folder_transfer, "EXPORT_SLOTS", 1)
    with pytest.raises(ValueError, match="exports are retained"):
        server.download_folder("Root")
    assert server.download_folder("Root", snapshot["transfer_id"])["sha256"] == snapshot["sha256"]
