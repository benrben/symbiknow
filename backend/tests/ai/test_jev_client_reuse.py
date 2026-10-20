"""Connection reuse with isolated clients; no network or library mutation."""
import threading
from types import SimpleNamespace

import pytest

from symbiknow.ai import jev


@pytest.fixture
def clients(monkeypatch):
    jev.close_clients()
    created = []

    class Client:
        def __init__(self, **settings):
            self.settings, self.closed = settings, False
            created.append(self)

        def system_one(self, **kwargs):
            assert not self.closed
            return SimpleNamespace(choices={}, model="fixture", usage=None)

        def close(self):
            self.closed = True

    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture-only")
    monkeypatch.setattr(jev, "TypeSafeClient", Client)
    monkeypatch.setattr("symbiknow.ai.shadow.record_shadow", lambda *args: None)
    yield created
    jev.close_clients()


def test_reuse_rotate_configuration_and_close(clients, monkeypatch):
    jev._call({}, {})
    jev._call({}, {})
    assert len(clients) == 1 and not clients[0].closed
    monkeypatch.setenv("TYPESAFE_DEFAULT_MODEL", "another-model")
    jev._call({}, {})
    assert len(clients) == 2 and clients[0].closed
    jev.close_clients()
    assert clients[1].closed


def test_supplied_client_is_not_owned_or_closed(clients):
    supplied = SimpleNamespace(
        system_one=lambda **kw: SimpleNamespace(choices={}, model="fixture", usage=None))
    jev._call({}, {}, supplied)
    jev.close_clients()
    assert clients == []


def test_shutdown_does_not_close_inflight_client(clients, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = jev.TypeSafeClient.system_one
    def blocked(self, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(self, **kwargs)
    monkeypatch.setattr(jev.TypeSafeClient, "system_one", blocked)
    thread = threading.Thread(target=lambda: jev._call({}, {}))
    thread.start()
    assert entered.wait(5)
    jev.close_clients()
    assert not clients[0].closed
    release.set()
    thread.join(5)
    assert not thread.is_alive() and clients[0].closed
    jev._call({}, {})
    assert len(clients) == 2
