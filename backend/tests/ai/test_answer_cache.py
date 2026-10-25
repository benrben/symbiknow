"""Durable Jev answers: exact-request reuse across restarts; never text, never stale."""
from contextlib import contextmanager
import json
import os
import stat

import httpx2
import pytest
from typesafe_sdk import Choice, Noul, RetryPolicy, TypeSafeClient

from symbiknow.ai import jev
from symbiknow.ai.answer_cache import AnswerCache

TEXT = "Original passage: the keeper is Noa."


@pytest.fixture
def provider(tmp_path, monkeypatch):
    """Pooled-client path with a counting transport and a library-owned cache."""
    requests = []

    def respond(request):
        body = json.loads(request.content)
        requests.append(body)
        answers = {key: dict(type="noul", noul=.9) if q["type"] == "noul" else
                   dict(type="choice", choice=next(iter(q["criteria"])), confidence=.9,
                        probabilities={name: float(i == 0) for i, name in enumerate(q["criteria"])})
                   for key, q in body["questions"].items()}
        return httpx2.Response(200, json=dict(model="jev-1.14.0", answers=answers,
                                             usage=dict(input_tokens=10, output_tokens=1)))

    @contextmanager
    def pooled():
        with TypeSafeClient(api_key="fixture", model="jev-1.14.0", transport=httpx2.MockTransport(respond),
                            retry=RetryPolicy(max_retries=0)) as sdk:
            yield sdk

    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture-only")
    monkeypatch.setattr(jev, "_provider_client", pooled)
    monkeypatch.setattr("symbiknow.ai.shadow.record_shadow", lambda *args: None)
    monkeypatch.setattr(jev, "_ANSWER_CACHE", AnswerCache(tmp_path))
    yield tmp_path, requests


def ask(question="Who is the keeper?"):
    return jev._call({"text": TEXT}, {"keeper": Noul(instructions=question),
                                      "kind": Choice(instructions="Kind?", criteria={"fact": "Fact", "other": "Other"})})


def test_identical_request_is_answered_from_disk_after_restart(provider, monkeypatch):
    root, requests = provider
    first = ask()
    monkeypatch.setattr(jev, "_ANSWER_CACHE", AnswerCache(root))  # A new process owner.
    second = ask()
    assert len(requests) == 1
    assert second.answers == first.answers and second.model == first.model
    ask("Who keeps it?")  # Any request change is a different answer.
    assert len(requests) == 2


def test_disk_holds_only_labels_and_scores_in_private_files(provider):
    root, _ = provider
    ask()
    directory = root / "temp" / "jev-answer-cache"
    files = list((directory / "entries").glob("*.json"))
    assert len(files) == 1
    content = files[0].read_text()
    assert TEXT not in content and "keeper is Noa" not in content and "Who is the keeper" not in content
    assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
    assert stat.S_IMODE((directory / "entries").stat().st_mode) == 0o700


def test_liveness_checks_and_explicit_clients_bypass_durable_answers(provider):
    root, requests = provider
    for _ in range(2):
        jev.preflight()
    assert len(requests) == 2
    with jev._provider_client() as explicit:
        for _ in range(2):
            jev._call({"text": TEXT}, {"keeper": Noul(instructions="Who?")}, explicit)
    assert len(requests) == 4
    assert not (root / "temp" / "jev-answer-cache").exists()


def test_credential_guard_runs_before_any_cache_lookup(provider):
    root, requests = provider
    with pytest.raises(jev.SensitiveContentError):
        jev._call({"text": "token: " + "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2"}, {"q": Noul(instructions="Check")})
    assert not requests and not (root / "temp" / "jev-answer-cache").exists()


def test_expired_corrupt_and_oversized_entries_are_misses(tmp_path):
    clock = [1000.0]
    cache = AnswerCache(tmp_path, ttl=60, now=lambda: clock[0])
    cache.put("a" * 64, {"model": "m", "answers": {}})
    assert cache.get("a" * 64) == {"model": "m", "answers": {}}
    clock[0] += 61
    assert cache.get("a" * 64) is None
    cache.put("b" * 64, {"model": "m", "answers": {}})
    (cache.entries / ("b" * 64 + ".json")).write_text("{not json")
    assert cache.get("b" * 64) is None
    cache.put("c" * 64, {"model": "m", "answers": {"x": "y" * (1024**2)}})
    assert cache.get("c" * 64) is None


def test_byte_budget_evicts_oldest_answers_first(tmp_path):
    clock = [1000.0]
    cache = AnswerCache(tmp_path, max_bytes=3 * 4096, now=lambda: clock[0])
    for n in range(5):
        clock[0] += 1
        cache.put(f"{n:064x}", {"model": "m", "answers": {}})
        os.utime(cache.entries / f"{n:064x}.json", (clock[0], clock[0]))
    cache.sweep()
    kept = sorted(p.stem for p in cache.entries.glob("*.json"))
    assert len(kept) <= 3 and f"{4:064x}" in kept and f"{0:064x}" not in kept


def test_a_removed_library_is_never_recreated(tmp_path):
    cache = AnswerCache(tmp_path / "gone")
    cache.put("d" * 64, {"model": "m", "answers": {}})
    assert not (tmp_path / "gone").exists()
