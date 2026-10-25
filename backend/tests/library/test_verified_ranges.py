"""Bounded reads authenticate original blocks across restarts, mutations and purges."""
import pytest
from symbiknow.library import storage


def test_ranges_cross_blocks_and_pin_old_versions_after_restart(tmp_path, monkeypatch):
    content = b'a' * (256 * 1024 - 3) + b'BOUNDARY' + b'z' * 500000
    old = storage.save_file(tmp_path, content, 'large.bin')
    storage.save_file(tmp_path, b'new', 'large.bin', document_id=old['document_id'])
    monkeypatch.setattr(storage, '_digest_path', lambda *a: pytest.fail('read hashed the whole file'))
    monkeypatch.setattr(storage, 'verified_file', lambda *a: pytest.fail('read staged the whole file'))
    with storage.verified_ranges(tmp_path, old['document_id'], 'v1') as (reader, metadata):
        assert metadata['version'] == 'v1'
        assert reader.read(256 * 1024 - 4, 16) == content[256 * 1024 - 4:256 * 1024 + 12]
        assert reader.read(len(content), 8) == b''
        storage.delete_document(tmp_path, old['document_id'], 'v2')
        assert reader.read(0, 10) == content[:10]  # An already opened descriptor stays pinned.
    with pytest.raises(FileNotFoundError):
        with storage.verified_ranges(tmp_path, old['document_id'], 'v1'):
            pass


def test_corrupt_range_never_returns_unverified_bytes(tmp_path):
    saved = storage.save_file(tmp_path, b'original bytes', 'file.txt')
    path = storage._original_path(tmp_path, saved['document_id'], 'v1')
    with path.open('r+b') as handle:
        handle.write(b'X')
    with storage.verified_ranges(tmp_path, saved['document_id'], 'v1') as (reader, _):
        with pytest.raises(storage.StorageError, match='integrity'):
            reader.read(0, 4)


def test_legacy_preparation_is_explicit_and_rebuildable(tmp_path):
    saved = storage.save_file(tmp_path, b'original', 'file.txt')
    with storage._range_db(tmp_path) as db:
        db.execute('DELETE FROM files')
    with pytest.raises(storage.RangeNotReady):
        with storage.verified_ranges(tmp_path, saved['document_id']):
            pass
    storage.prepare_ranges(tmp_path, saved['document_id'])
    with storage.verified_ranges(tmp_path, saved['document_id']) as (reader, _):
        assert reader.read(0, 100) == b'original'


def test_upload_staging_does_not_block_reads(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    original = storage.save_file(tmp_path, b'old', 'file.txt')
    entered, release = threading.Event(), threading.Event()
    native = storage._run

    def pause_copy(root, *args, **kwargs):
        if args[0] == 'cp' and args[-1] == 'original':
            entered.set()
            assert release.wait(5)
        return native(root, *args, **kwargs)

    monkeypatch.setattr(storage, '_run', pause_copy)
    with ThreadPoolExecutor(max_workers=2) as pool:
        write = pool.submit(storage.save_file, tmp_path, b'new', 'file.txt', document_id=original['document_id'], expected_version='v1')
        assert entered.wait(3)
        try:
            def read():
                with storage.verified_ranges(tmp_path, original['document_id']) as (reader, metadata):
                    return reader.read(0, 10), metadata['version']
            assert pool.submit(read).result(timeout=1) == (b'old', 'v1')
        finally:
            release.set()
        assert write.result(timeout=5)['version'] == 'v2'
