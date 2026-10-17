"""Integration tests against the pinned native rocfl executable, never a fake store."""

import hashlib
import os
import subprocess
import sys
import threading
import time

import pytest

from app import storage


@pytest.fixture(autouse=True)
def rocfl_available():
    # Fail clearly, rather than skip the project's primary storage contract.
    storage._binary()


def test_binary_versions_and_metadata(tmp_path):
    original = bytes(range(256)) * 1024
    first = storage.save_file(
        tmp_path, original, "report α.pdf", "application/pdf", "/source/report α.pdf"
    )
    second = storage.save_file(
        tmp_path,
        b"\x00changed\xff",
        "renamed.pdf",
        document_id=first["document_id"],
        expected_version="v1",
    )
    assert second["version"] == "v2"
    assert storage.read_file(tmp_path, first["document_id"], "v1") == (original, first)
    assert storage.read_file(tmp_path, first["document_id"])[0] == b"\x00changed\xff"
    assert [item["version"] for item in storage.list_versions(tmp_path, first["document_id"])] == [
        "v1",
        "v2",
    ]
    assert storage.list_documents(tmp_path) == [second]
    assert storage.current_version(tmp_path, first["document_id"]) == "v2"
    assert first["filename"] == "report α.pdf"
    assert first["source"] == "/source/report α.pdf"
    assert first["sha256"] == hashlib.sha256(original).hexdigest()
    storage._run(tmp_path, "validate", "-l", "error")


def test_empty_unsupported_and_independent_identical_versions(tmp_path):
    first = storage.save_file(tmp_path, b"", "empty.unknown-extension")
    second = storage.save_file(
        tmp_path, b"", "empty.unknown-extension", document_id=first["document_id"]
    )
    assert second["version"] == "v2"
    assert first["mime_type"] == "application/octet-stream"
    assert storage.read_file(tmp_path, first["document_id"], "v1")[0] == b""


def test_retry_and_conflict(tmp_path):
    first = storage.save_file(tmp_path, b"one", "one.txt", request_id="lost-first-response")
    assert storage.save_file(tmp_path, b"one", "one.txt", request_id="lost-first-response") == first
    with pytest.raises(storage.VersionConflict, match="different"):
        storage.save_file(tmp_path, b"different", "one.txt", request_id="lost-first-response")
    with pytest.raises(storage.VersionConflict, match="Expected"):
        storage.save_file(
            tmp_path, b"two", "one.txt", document_id=first["document_id"], expected_version="v2"
        )
    assert len(storage.list_versions(tmp_path, first["document_id"])) == 1


def test_lost_commit_response_retry(tmp_path, monkeypatch):
    run = storage._run

    def interrupt_after_commit(root, *args, **kwargs):
        result = run(root, *args, **kwargs)
        if args[0] == "commit":
            raise InterruptedError("daemon disappeared after rocfl committed")
        return result

    monkeypatch.setattr(storage, "_run", interrupt_after_commit)
    with pytest.raises(InterruptedError):
        storage.save_file(tmp_path, b"saved", "saved.txt", request_id="crash")
    monkeypatch.setattr(storage, "_run", run)
    retry = storage.save_file(tmp_path, b"saved", "saved.txt", request_id="crash")
    assert retry["version"] == "v1"
    assert len(storage.list_versions(tmp_path, retry["document_id"])) == 1


def test_interrupted_staging_restarts_without_extra_version(tmp_path, monkeypatch):
    first = storage.save_file(tmp_path, b"before", "before.txt")
    run = storage._run

    def interrupt_after_copy(root, *args, **kwargs):
        result = run(root, *args, **kwargs)
        if args[0] == "cp":
            raise InterruptedError("daemon disappeared while staging")
        return result

    monkeypatch.setattr(storage, "_run", interrupt_after_copy)
    with pytest.raises(InterruptedError):
        storage.save_file(
            tmp_path, b"after", "after.txt", document_id=first["document_id"], request_id="retry"
        )
    monkeypatch.setattr(storage, "_run", run)
    assert storage.read_file(tmp_path, first["document_id"])[0] == b"before"
    second = storage.save_file(
        tmp_path, b"after", "after.txt", document_id=first["document_id"], request_id="retry"
    )
    assert second["version"] == "v2"
    assert storage.read_file(tmp_path, first["document_id"])[0] == b"after"
    storage._run(tmp_path, "validate", "-l", "error")


def test_parent_killed_during_child_commit(tmp_path):
    """Real child/daemon crash: rocfl retains lock and completes its update.

    A tiny executable delays only commit before exec'ing the real pinned rocfl,
    giving the test a deterministic kill boundary without changing storage APIs.
    """
    first = storage.save_file(tmp_path, b"before", "before.txt")
    marker = tmp_path / "child-started"
    shim = tmp_path / "delayed-rocfl"
    binary = storage._binary()
    shim.write_text(
        f"#!{sys.executable}\n"
        "import os,sys,time\n"
        f"if 'commit' in sys.argv[1:]:\n open({str(marker)!r},'w').close()\n time.sleep(0.5)\n"
        f"os.execv({binary!r},[{binary!r},*sys.argv[1:]])\n"
    )
    shim.chmod(0o755)
    code = (
        "from app.storage import save_file; "
        f"save_file({str(tmp_path)!r}, b'after', 'after.txt', document_id={first['document_id']!r}, request_id='killed-parent')"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", code], env={**os.environ, "ROCFL_BIN": str(shim)}
    )
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert marker.exists(), "commit subprocess did not start"
        child.kill()
        child.wait(timeout=5)
        # Save blocks on the child's inherited lock, then detects request replay.
        retry = storage.save_file(
            tmp_path,
            b"after",
            "after.txt",
            document_id=first["document_id"],
            request_id="killed-parent",
        )
        assert retry["version"] == "v2"
        assert len(storage.list_versions(tmp_path, first["document_id"])) == 2
        assert storage.read_file(tmp_path, first["document_id"])[0] == b"after"
        storage._run(tmp_path, "validate", "-l", "error")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def test_serialized_updates(tmp_path):
    first = storage.save_file(tmp_path, b"before", "before.txt")
    versions = []

    def save(number):
        result = storage.save_file(
            tmp_path, str(number).encode(), "next.txt", document_id=first["document_id"]
        )
        versions.append(result["version"])

    threads = [threading.Thread(target=save, args=(number,)) for number in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(versions) == ["v2", "v3", "v4"]
    assert len(storage.list_versions(tmp_path, first["document_id"])) == 4


@pytest.mark.parametrize("document_id", ["../escape", "/absolute", "-option", "a/b", "", "*glob*"])
def test_bad_ids(tmp_path, document_id):
    with pytest.raises(ValueError):
        storage.read_file(tmp_path, document_id)


def test_missing_document_or_version(tmp_path):
    storage.init_storage(tmp_path)
    assert storage.current_version(tmp_path, "missing") is None
    with pytest.raises(FileNotFoundError):
        storage.read_file(tmp_path, "missing")
    first = storage.save_file(tmp_path, b"content", "one.txt")
    with pytest.raises(FileNotFoundError):
        storage.read_file(tmp_path, first["document_id"], "v9")


def test_empty_supplied_id_does_not_create_object(tmp_path):
    with pytest.raises(ValueError):
        storage.save_file(tmp_path, b"content", "one.txt", document_id="")
