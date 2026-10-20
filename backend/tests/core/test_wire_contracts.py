"""Generated declarations cannot drift from canonical response schemas."""
import json
from pathlib import Path
import subprocess
import sys

import jsonschema
import pytest

from symbiknow.organization import rebuild
from symbiknow.search import index as search
from symbiknow.api import mcp as server
from symbiknow.api import http as ui
from tests.api.test_ui_api import context as context, indexed, decision

ROOT = Path(__file__).resolve().parents[3]


def validate(name, value):
    schema = json.loads((ROOT / "backend/symbiknow/schemas/contracts.json").read_text())
    schema["$ref"] = "#/$defs/" + name
    jsonschema.Draft202012Validator(schema).validate(value)


def test_generated_contracts_have_no_drift():
    subprocess.run([sys.executable, str(ROOT / "scripts/contracts/generate.py"), "--check"],
                   cwd=ROOT, check=True)


def test_canonical_response_schemas_cover_real_shared_operations(context, monkeypatch):
    root, _, _ = context
    doc = indexed(root)
    validate("Library", ui.library({}))
    validate("Detail", server.application().library.detail(doc["document_id"], "v1").to_wire())
    validate("SearchResponse", server.application().search.retrieve("cat", mode="keyword").to_wire())
    monkeypatch.setattr(server, "STORAGE_ONLY", False)
    monkeypatch.setenv("TYPESAFE_API_KEY", "fixture")
    target = indexed(root, name="target.txt")
    link = {"document_id": target["document_id"], "source_version": "v1", "version": "v1",
            "relation": "related", "source_chunk_id": f"{doc['document_id']}:v1:t0",
            "target_chunk_id": f"{target['document_id']}:v1:t0"}
    search.save_organization(root, doc["document_id"], "v1", decision(links=[link]))
    validate("Detail", server.application().library.detail(doc["document_id"], "v1").to_wire())
    validate("SearchResponse", server.application().search.retrieve("cat", mode="keyword").to_wire())
    monkeypatch.setattr("symbiknow.ai.jev.organize_document", lambda *args, **kwargs: decision())
    rebuild.request()
    validate("Rebuild", rebuild.progress())
    while rebuild.process_one():
        pass
    validate("Rebuild", rebuild.progress())
    validate("Library", ui.library({}))


def test_schema_preserves_narrow_rebuild_mode_and_required_evidence():
    with pytest.raises(jsonschema.ValidationError):
        validate("Evidence", {"text": "missing source reference"})
    schema = json.loads((ROOT / "backend/symbiknow/schemas/contracts.json").read_text())
    assert schema["$defs"]["Rebuild"]["properties"]["mode"] == {"enum": ["reset", "unfiled", "links"]}
