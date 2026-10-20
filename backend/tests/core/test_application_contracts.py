"""Executable ownership, wire drift and library isolation contracts."""

import runpy
from pathlib import Path
import subprocess
import sys

from symbiknow.api import mcp as server
from symbiknow.core.contracts import DomainResult
import pytest

ROOT = Path(__file__).resolve().parents[3]
checker = runpy.run_path(str(ROOT / "scripts/checks/architecture.py"))


def test_current_owners_and_generated_contracts():
    assert all(
        not checker["check_source"](path.read_text(), str(path.relative_to(ROOT)))
        for path in (ROOT / "backend/symbiknow").rglob("*.py")
    )
    subprocess.run(
        [sys.executable, str(ROOT / "scripts/contracts/generate.py"), "--check"], check=True
    )


def test_owner_checks_resolve_aliases_and_relative_imports():
    cases = [
        "import symbiknow.api.mcp as transport",
        "from ..api.mcp import upload",
        "from ..api import http as browser",
        'from lancedb import connect as db; db("index")',
        'import lancedb as db; db.connect("index")',
        "from symbiknow.search.index import _set_chunk_filters as apply",
        "service._refresh_matches([])",
        'import importlib as imports; imports.import_module("symbiknow.api.http")',
    ]
    for source in cases:
        assert checker["check_source"](source, "backend/symbiknow/core/domain.py"), source


def test_library_context_does_not_share_mutable_facts(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DATA_DIR", tmp_path / "one")
    first = server.application()
    first.status_cache["identity"] = {"version": "v1"}
    first.retry_ids.add("identity")
    first.organization_attempts.add(("identity", "v1"))
    first.schedule("identity")
    monkeypatch.setattr(server, "DATA_DIR", tmp_path / "two")
    second = server.application()
    assert first.DATA_DIR != second.DATA_DIR
    assert not second.status_cache and not second.retry_ids and not second.organization_attempts
    assert second.pending.empty()
    assert first.status_cache == {"identity": {"version": "v1"}}
    assert first.pending.get_nowait() == "identity"


def test_domain_publication_and_transport_projections_have_independent_ownership():
    original = {"matches": [{"evidence": [{"text": "original"}]}]}
    result = DomainResult(original)
    original["matches"][0]["evidence"][0]["text"] = "changed"
    with pytest.raises(TypeError):
        result.payload["matches"][0]["evidence"][0]["text"] = "corrupt"
    first, second = result.to_wire(), result.to_wire()
    first["matches"][0]["evidence"][0]["text"] = "consumer edit"
    assert second["matches"][0]["evidence"][0]["text"] == "original"


def test_settings_are_validated_immutable_and_state_is_owned(tmp_path, monkeypatch):
    from dataclasses import FrozenInstanceError
    from symbiknow.core.application import ApplicationSettings

    with pytest.raises(ValueError):
        ApplicationSettings(max_chunk_bytes=10, max_file_bytes=1)
    settings = ApplicationSettings()
    with pytest.raises(FrozenInstanceError):
        settings.max_chunk_bytes = 1
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    context = server.application()
    owned = context.status_cache
    monkeypatch.setattr(server, "status_cache", {"foreign": {"version": "v9"}})
    assert server.application().status_cache is owned
    assert "foreign" not in owned


def test_library_body_and_revision_share_cross_process_snapshot(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    import time
    from symbiknow.search import index as search
    from symbiknow.library import storage

    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "STORAGE_ONLY", True)
    metadata = storage.save_file(tmp_path, b"first", "first.txt")
    search.register_document(tmp_path, metadata, disabled=True)
    context = server.application()
    before = storage.source_revision(tmp_path)
    entered, release = threading.Event(), threading.Event()
    original = context.library._library

    def held(params):
        entered.set()
        assert release.wait(10)
        return original(params)

    monkeypatch.setattr(context.library, "_library", held)
    marker = tmp_path / "writer-started"
    code = ("import sys; from pathlib import Path; from symbiknow.library import storage; "
            "Path(sys.argv[3]).write_text('started'); "
            "storage.save_file(sys.argv[1], b'second', 'second.txt', document_id=sys.argv[2])")
    child = None
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(context.library.library, {})
        try:
            assert entered.wait(5)
            child = subprocess.Popen([sys.executable, "-c", code, str(tmp_path), metadata["document_id"], str(marker)],
                                     cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            assert marker.exists() and child.poll() is None
            # The child cannot change even the durable pre-commit token while
            # the library's body and revision remain under the same snapshot.
            assert storage.source_revision(tmp_path) == before
        finally:
            release.set()
        result = pending.result(timeout=10).to_wire()
        assert before in result["organization_revision"]
        assert result["documents"][0]["version"] == "v1"
        stdout, stderr = child.communicate(timeout=10)
        assert child.returncode == 0, (stdout, stderr)
    assert storage.source_revision(tmp_path) != before
    assert storage.current_version(tmp_path, metadata["document_id"]) == "v2"


def test_folder_navigation_reuses_exact_global_and_group_aggregates(tmp_path, monkeypatch):
    from symbiknow.core.application import ApplicationContext
    from symbiknow.library import service as library_service
    context = ApplicationContext(tmp_path)
    values = [("A", ["x"]), ("A / Child", ["y"]), ("B", ["x", "y"]), ("", [])]
    rows = [{"document_id": str(index), "version": "v1", "folder": folder, "groups": groups,
             "status": "indexed", "organization_status": "evaluated"}
            for index, (folder, groups) in enumerate(values)]
    scans = []
    def batches(*args, **kwargs):
        scans.append(1)
        return iter([rows])
    monkeypatch.setattr(library_service, "metadata_batches", batches)
    def view(folder=None, group=None, revision="r"):
        return context.library._aggregates(str(tmp_path), revision, "m", folder, group)
    all_rows = view()
    assert view("A")["scoped_folders"] == {"A": 1, "A / Child": 1}
    assert view("")["scoped_folders"] == {"": 1}
    assert view("B")["scoped_folders"] == {"B": 1}
    assert len(scans) == 1 and all_rows["library_total"] == 4
    assert view("A", "x")["scoped_folders"] == {"A": 1}
    assert view("B", "x")["scoped_folders"] == {"B": 1}
    assert len(scans) == 2
    private = view("B")
    private["folders"]["B"] = 999
    assert view()["folders"]["B"] == 1
    assert view(revision="next")["folders"] == all_rows["folders"]
    assert len(scans) == 3
