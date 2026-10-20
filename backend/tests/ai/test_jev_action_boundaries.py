"""Non-destructive provider/observer checks for the action experiment review."""
import json
import threading

import pytest
from typesafe_sdk import Choice

from symbiknow.ai import jev
from symbiknow.ai import shadow as jev_shadow
from tests.ai.test_jev import sdk_client


def test_preflight_failure_does_not_expose_provider_message(monkeypatch):
    def failure(*args, **kwargs):
        raise RuntimeError('private provider payload')

    monkeypatch.setattr(jev, '_call', failure)
    with pytest.raises(ValueError, match='Library organization was left untouched') as exc:
        jev.preflight()
    assert 'private' not in str(exc.value)


def test_shadow_failure_cannot_replace_primary_response(monkeypatch):
    def failure(*args, **kwargs):
        raise RuntimeError('observer failed')

    monkeypatch.setattr(jev_shadow, 'record_shadow', failure)
    with sdk_client({'ready': 'ready'}) as sdk:
        response = jev._call({'text': 'ready'}, {
            'ready': Choice(instructions='Is the provider ready?', criteria={'ready': 'Ready'})
        }, sdk)
    assert response.choices['ready'].choice == 'ready'


@pytest.mark.parametrize('url', ['https://example.com', 'http://example.com',
                                 'http://user:password@localhost', 'http://localhost/path'])
def test_shadow_rejects_nonlocal_or_credentialed_origins(tmp_path, url):
    with pytest.raises(ValueError, match='local HTTP server origin'):
        jev_shadow.ShadowRecorder(url, 'fixture', tmp_path / 'shadow.log')


def test_shadow_queue_is_bounded_and_never_logs_source_text(tmp_path):
    started, release = threading.Event(), threading.Event()

    def transport(payload):
        started.set()
        assert release.wait(2)
        raise RuntimeError('private source text')

    path = tmp_path / 'shadow.log'
    observer = jev_shadow.ShadowRecorder('http://localhost', 'fixture', path,
                                       capacity=1, transport=transport)
    question = {'judge_0': Choice(instructions='Is this evidence?', criteria={'yes': 'Yes'})}
    with sdk_client({'judge_0': 'yes'}) as client:
        primary = client.system_one(state={'text': 'private source text'}, questions=question)
    try:
        assert observer.submit({'text': 'private source text'}, question, primary)
        assert started.wait(1)
        assert observer.submit({'text': 'private source text'}, question, primary)
        assert not observer.submit({'text': 'private source text'}, question, primary)
        assert observer.pending.qsize() == 1
        assert observer.dropped == 1
    finally:
        release.set()
        observer.pending.join()
    events = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(events) == 2
    assert all(event['status'] == 'shadow_failed' for event in events)
    assert 'private source text' not in path.read_text()
