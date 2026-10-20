import subprocess
import pyarrow as pa
import pytest
from symbiknow.search.grep import matching_rows, parse_command

def rows(command, texts):
    batch = pa.RecordBatch.from_pylist([{"document_id": str(i), "text": text, "chunk_id": str(i)} for i, text in enumerate(texts)])
    return matching_rows(command, [batch], 10)

def test_real_grep_flags_and_evidence_mapping():
    texts = ["cache miss\nCache HIT", "prefixcache", "cache.value", "other"]
    assert [r["document_id"] for r in rows('grep -inw "cache"', texts)] == ["0", "2"]
    assert [r["document_id"] for r in rows('grep -F "cache.value"', texts)] == ["2"]
    assert [r["document_id"] for r in rows('grep -E "^other$|^prefix"', texts)] == ["1", "3"]
    assert rows('grep "absent"', texts) == []
    assert [r["document_id"] for r in rows('grep -e "HIT" -e "other"', texts)] == ["0", "3"]

@pytest.mark.parametrize("command", ['cat /etc/passwd', 'grep -r "cache" /tmp', 'grep -f /etc/passwd', 'grep cache ; touch bad', 'grep cache | cat', 'grep cache > output', 'grep --include=* cache', 'grep -e', 'grep ""', 'grep -FE cache'])
def test_no_file_or_shell_operands(command):
    with pytest.raises(ValueError): parse_command(command)

def test_substitutions_are_literal_and_cannot_execute(tmp_path):
    marker = tmp_path / "should-not-exist"
    pattern = f"$(touch {marker})"
    assert len(rows(f"grep -F '{pattern}'", [pattern])) == 1
    assert not marker.exists()

def test_bad_pattern_and_timeout_are_actionable(monkeypatch):
    with pytest.raises(ValueError, match="Invalid grep pattern"): rows('grep -E "["', ["text"])
    def timeout(*args, **kwargs): raise subprocess.TimeoutExpired(args[0], 3)
    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(ValueError, match="too long"): rows('grep "text"', ["text"])

def test_scope_limits_never_silently_truncate(monkeypatch):
    import symbiknow.search.grep as grep
    monkeypatch.setattr(grep, "MAX_BYTES", 3)
    with pytest.raises(ValueError, match="narrower"): rows('grep "a"', ["aaaa"])
