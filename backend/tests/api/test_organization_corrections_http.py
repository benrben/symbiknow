"""The UI correction endpoints use the same guarded application service."""
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from symbiknow.api import http
from tests.organization import test_targeted_corrections as correction_fixtures

library = correction_fixtures.library


def test_http_inspect_replace_and_stale_rejection(library, monkeypatch):
    context, source, _, _, args, _, _ = library
    monkeypatch.setattr(http.server, "application", lambda: context)
    app = Starlette(routes=[Route("/api/{action}", http.api, methods=["GET", "POST"])])
    app.add_middleware(http.LocalProtection)
    headers = {"Origin": "http://localhost", "X-Symbiknow-UI": "1"}
    with TestClient(app, base_url="http://localhost") as client:
        before = client.get('/api/organization-correction', params={'id': source['document_id']})
        assert before.status_code == 200 and before.json()['history'] == []
        payload = dict(args, action='replace-topics', value=['Research'])
        assert client.post('/api/organization-correction', json=payload).status_code == 403
        applied = client.post('/api/organization-correction', json=payload, headers=headers)
        assert applied.status_code == 200
        again = client.post('/api/organization-correction', json=payload, headers=headers)
        assert again.status_code == 400 and 'changed' in again.json()['error']
        after = client.get('/api/organization-correction', params={'id': source['document_id']}).json()
        assert after['document']['groups'] == ['Research']
        assert after['history'][0]['previous'] == ['Wrong / Read']
