import pytest


@pytest.fixture(autouse=True)
def _default_jev_search_mode(monkeypatch):
    # The MCP module loads the developer's .env; tests opt into experiments explicitly.
    monkeypatch.delenv("SYMBIKNOW_JEV_SEARCH_MODE", raising=False)
