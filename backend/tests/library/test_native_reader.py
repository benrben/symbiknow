"""Native metadata reads preserve CLI semantics without caching current heads."""

import json
import hashlib
from pathlib import Path
import select
import subprocess
import threading

import pytest

from symbiknow.library import storage


BINARY = Path(__file__).resolve().parents[3] / ".tools/native/bin/symbiknow-ocfl-reader"


@pytest.fixture
def reader(tmp_path):
    storage.init_storage(tmp_path)
    process = subprocess.Popen(
        [str(BINARY), str(tmp_path / "files")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    def send(value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()
        assert select.select([process.stdout], [], [], 10)[0], "native reader response timed out"
        response = process.stdout.readline()
        assert response, "native reader exited without a response"
        return json.loads(response)

    try:
        yield tmp_path, send
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def test_native_reader_matches_cli_and_observes_commits_and_deletion(reader):
    root, send = reader
    first = storage.save_file(root, b"first", "example.txt")
    identity = first["document_id"]

    def read(*refs):
        response = send({"requests": list(refs)})
        assert response["ok"], response
        return response["metadata"]

    def cli(version=None):
        flags = ["-v", version] if version else []
        return json.loads(storage._run(root, "cat", *flags, identity, "metadata.json"))

    assert read({"document_id": identity}) == [cli()]
    second = storage.save_file(
        root, b"second", "example.txt", document_id=identity, expected_version="v1"
    )
    assert second["version"] == "v2"
    # Same live process must observe the new head and still resolve pinned v1.
    assert read(
        {"document_id": identity},
        {"document_id": identity, "version": "v1"},
        {"document_id": identity, "version": "v99"},
        {"document_id": "missing"},
    ) == [cli(), cli("v1"), None, None]
    storage.delete_document(root, identity, "v2")
    assert read({"document_id": identity}) == [None]


def test_native_reader_rejects_whole_batch_and_recovers_protocol(reader):
    root, send = reader
    metadata = storage.save_file(root, b"original", "example.txt")
    reference = {"document_id": metadata["document_id"]}
    rejected = send({"requests": [reference, {"document_id": "../escape"}]})
    assert rejected["ok"] is False
    assert rejected["error"]["kind"] == "request"
    assert "metadata" not in rejected
    excessive = send({"requests": [reference] * 801})
    assert excessive["error"]["kind"] == "limit"
    accepted = send({"requests": [reference]})
    assert accepted["metadata"] == [metadata]


def test_native_reader_does_not_return_corrupt_metadata_as_missing(reader):
    root, send = reader
    metadata = storage.save_file(root, b"original", "example.txt")
    files = list((root / "files").rglob("metadata.json"))
    assert len(files) == 1
    # Corrupt only an isolated test repository. The library reader should surface
    # invalid content rather than silently turn the object into a cache miss.
    files[0].write_text('{"document_id":"wrong","version":"v1"}')
    response = send({"requests": [{"document_id": metadata["document_id"]}]})
    assert response["ok"] is False
    assert response["error"]["kind"] == "metadata"
    assert "metadata" not in response


def test_python_adapter_restarts_dead_helper_and_does_not_cache_head(tmp_path):
    first = storage.save_file(tmp_path, b"first", "example.txt")
    identity = first["document_id"]
    assert storage.heads_many(tmp_path, [identity]) == {identity: "v1"}
    owner = storage._READERS[tmp_path.resolve()]
    previous = owner.process
    previous.kill()
    previous.wait(timeout=5)
    assert storage.heads_many(tmp_path, [identity]) == {identity: "v1"}
    assert owner.process.pid != previous.pid
    storage.save_file(tmp_path, b"second", "example.txt", document_id=identity, expected_version="v1")
    assert storage.heads_many(tmp_path, [identity]) == {identity: "v2"}


def test_python_adapter_completes_request_larger_than_pipe_buffer(tmp_path):
    storage.init_storage(tmp_path)
    identities = [f"missing-{number:04d}-" + "x" * 115 for number in range(800)]
    # More than 100 KiB forces multiple pipe writes; every missing identity must
    # survive framing in the one bounded response.
    assert len(json.dumps(identities)) > 100_000
    assert storage.heads_many(tmp_path, identities) == dict.fromkeys(identities)


def test_snapshot_reuses_reads_only_while_protected_and_results_are_immutable(tmp_path):
    from symbiknow.core.application import ApplicationContext
    from symbiknow.search.metrics import CURRENT

    document = storage.save_file(tmp_path, b"first", "example.txt")
    identity = document["document_id"]
    context = ApplicationContext(tmp_path, write_lock=threading.RLock(), index_lock=threading.RLock())
    metrics = {}
    token = CURRENT.set(metrics)
    try:
        with context.snapshots.read() as snapshot:
            assert snapshot.heads_many([identity])[identity] == "v1"
            metadata = snapshot.metadata_many([identity])[identity]
            assert metadata["document_id"] == identity
            with pytest.raises(TypeError):
                metadata["version"] = "v99"
        assert metrics["storage_backend_batches"] == 1
        with pytest.raises(RuntimeError, match="snapshot has ended"):
            snapshot.heads_many([identity])
        storage.save_file(tmp_path, b"second", "example.txt", document_id=identity, expected_version="v1")
        with context.snapshots.read() as next_snapshot:
            assert next_snapshot.heads_many([identity])[identity] == "v2"
    finally:
        CURRENT.reset(token)


def test_cross_library_nested_snapshot_is_rejected_without_damaging_outer_lock(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    storage.init_storage(first)
    storage.init_storage(second)
    with storage.read_snapshot(first):
        with pytest.raises(storage.StorageError, match="different libraries"):
            with storage.read_snapshot(second):
                pytest.fail("different library lock silently replaced outer lock")
        assert storage.heads_many(first, ["missing"]) == {"missing": None}
    assert storage.heads_many(second, ["missing"]) == {"missing": None}


def test_oversized_legacy_metadata_stream_preserves_bytes_and_protocol(tmp_path):
    first = storage.save_file(tmp_path, b"original", "example.txt")
    identity = first["document_id"]
    # A valid historical OCFL commit predating the new-write metadata budget.
    # Commit through rocfl; do not fabricate an inventory or damage content hashes.
    legacy = dict(first, version="v2", request_id="legacy-oversized", source="é" * (9 * 1024**2))
    staged = tmp_path / "legacy-metadata.json"
    staged.write_text(json.dumps(legacy, ensure_ascii=False))
    with storage.read_snapshot(tmp_path):
        storage._run(tmp_path, "cp", identity, str(staged), "--", "metadata.json")
        storage._run(tmp_path, "commit", "-n", "Fixture", "-m", "historical oversized metadata", identity)
    process = subprocess.Popen([str(BINARY), str(tmp_path / "files")],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    deadline = threading.Timer(30, process.kill)
    deadline.daemon = True
    deadline.start()
    try:
        process.stdin.write(json.dumps({"requests": [{"document_id": identity}], "stream": True}).encode() + b"\n")
        process.stdin.flush()
        digest = hashlib.sha256()
        chunks = 0
        while True:
            line = process.stdout.readline(131_104)
            assert line.endswith(b"\n") and len(line) <= 131_104
            frame = json.loads(line)
            if frame.get("complete"):
                assert frame == {"ok": True, "complete": True}
                break
            data = bytes.fromhex(frame["chunk_hex"])
            assert 0 < len(data) <= 65_536
            digest.update(data)
            chunks += 1
        assert chunks > 256
        assert digest.hexdigest() == storage._digest_path(staged)
        # Streaming leaves the persistent connection synchronized for normal reads.
        process.stdin.write(json.dumps({"requests": [{"document_id": identity, "version": "v1"}]}).encode() + b"\n")
        process.stdin.flush()
        assert json.loads(process.stdout.readline())["metadata"] == [first]
        process.stdin.write(b'{"requests":[{"document_id":"missing"}],"stream":true}\n')
        process.stdin.flush()
        assert json.loads(process.stdout.readline()) == {"ok": True, "complete": True, "missing": True}
    finally:
        deadline.cancel()
        process.stdin.close()
        process.wait(timeout=5)
        process.stdout.close()
    assert storage.read_metadata(tmp_path, identity) == legacy
    assert storage.read_metadata(tmp_path, identity, "v1") == first
    assert storage.save_file(
        tmp_path, b"original", "example.txt", document_id=identity,
        request_id="legacy-oversized", source=legacy["source"], expected_version="v1",
    ) == legacy
    assert "Invalid objects: 0" in storage._run(tmp_path, "validate", "-l", "error").decode()
    # The streaming path must apply the same identity checks after reconstruction.
    staged.write_text(json.dumps(dict(legacy, document_id="wrong", version="v3"), ensure_ascii=False))
    with storage.read_snapshot(tmp_path):
        storage._run(tmp_path, "cp", identity, str(staged), "--", "metadata.json")
        storage._run(tmp_path, "commit", "-n", "Fixture", "-m", "invalid metadata identity", identity)
    with pytest.raises(storage.StorageError, match="metadata"):
        storage.read_metadata(tmp_path, identity)
    with staged.open("wb") as stream:
        for _ in range(17):
            stream.write(b" " * 1024**2)
        stream.write(b"null")
    with storage.read_snapshot(tmp_path):
        storage._run(tmp_path, "cp", identity, str(staged), "--", "metadata.json")
        storage._run(tmp_path, "commit", "-n", "Fixture", "-m", "invalid null metadata", identity)
    with pytest.raises(storage.StorageError, match="metadata"):
        storage.read_metadata(tmp_path, identity)


def test_large_valid_batch_splits_without_cli_fallback_or_worker_restart(tmp_path):
    from symbiknow.search.metrics import CURRENT

    documents = [storage.save_file(tmp_path, b"original", f"file-{number}.txt", source="x" * (9 * 1024**2))
                 for number in range(2)]
    metrics = {}
    token = CURRENT.set(metrics)
    try:
        result = storage.metadata_many(tmp_path, [doc["document_id"] for doc in documents])
        assert dict(result) == {doc["document_id"]: doc for doc in documents}
    finally:
        CURRENT.reset(token)
    assert metrics["storage_backend_batches"] >= 3
    assert metrics.get("storage_cli_launches", 0) == 0
    assert metrics.get("storage_reader_restarts", 0) == 0


def test_new_oversized_metadata_is_rejected_before_original_mutation(tmp_path):
    original = storage.save_file(tmp_path, b"original", "example.txt")
    identity = original["document_id"]
    revision = storage.source_revision(tmp_path)
    with pytest.raises(ValueError, match="16 MiB"):
        storage.save_file(tmp_path, b"replacement", "example.txt", document_id=identity,
                          expected_version="v1", source="x" * (16 * 1024**2))
    assert storage.source_revision(tmp_path) == revision
    assert storage.read_metadata(tmp_path, identity) == original
    assert storage.read_file(tmp_path, identity)[0] == b"original"
