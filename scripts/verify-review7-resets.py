"""Exact original-version hash receipt for full and selective isolated resets.

Real OCFL/LanceDB; deterministic test-only organization, no provider calls.
"""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from app import ingest, jev, organization_edits, rebuild, search, server, storage  # noqa: E402
from test_search import FixtureEmbedder  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="symbiknow-review7-reset-") as temp:
        root = Path(temp)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        os.environ["TYPESAFE_API_KEY"] = "test-only-no-provider"
        jev.preflight = lambda: None
        jev.organize_document = lambda *args, **kwargs: {
            "status": "evaluated",
            "folder": "Fresh",
            "groups": ["Versioning"],
            "links": [],
        }
        search.get_embedder = lambda: FixtureEmbedder()
        storage.init_storage(root)
        first = storage.save_file(root, b"NovaPay keeps original version one.", "a.txt")
        first = storage.save_file(
            root,
            b"NovaPay keeps every version, including version two.",
            "a.txt",
            document_id=first["document_id"],
        )
        other = storage.save_file(root, b"NovaPay storage reference.", "b.txt")
        unsupported = storage.save_file(root, b"\x00\x01original unsupported bytes\xff", "c.bin")
        docs = [first, other, unsupported]
        for doc in docs:
            content, _ = storage.read_file(root, doc["document_id"])
            ingest.index_document(root, doc, content, FixtureEmbedder())
            search.save_organization(
                root,
                doc["document_id"],
                doc["version"],
                {"status": "evaluated", "folder": "Legacy / Child", "groups": ["Old"], "links": []},
            )
        organization_edits.edit(
            "move-documents",
            {
                "folder": "Manual / Old",
                "documents": [
                    {"document_id": first["document_id"], "expected_version": first["version"]}
                ],
            },
        )

        def hashes():
            return [
                {
                    "document_id": doc["document_id"],
                    "version": version["version"],
                    "sha256": hashlib.sha256(
                        storage.read_file(root, doc["document_id"], version["version"])[0]
                    ).hexdigest(),
                }
                for doc in docs
                for version in storage.list_versions(root, doc["document_id"])
            ]

        before = hashes()
        rebuild.request()
        while rebuild.process_one():
            pass
        full = rebuild.status()
        assert not full["failures"] and not organization_edits.read(root)["assignments"]
        assert hashes() == before
        assert "Legacy / Child" not in search.organization_catalog(root)["folders"]
        assert search.get_document_status(root, unsupported["document_id"])["folder"] == ""
        folders = {
            doc["document_id"]: search.get_document_status(root, doc["document_id"])["folder"]
            for doc in docs
        }
        rebuild.request(folder="Fresh", grouping=False, links=True)
        while rebuild.process_one():
            pass
        selective = rebuild.status()
        assert hashes() == before
        assert folders == {
            doc["document_id"]: search.get_document_status(root, doc["document_id"])["folder"]
            for doc in docs
        }
        receipt = {
            "provider": "mocked organization; actual OCFL and LanceDB",
            "temporary_library": temp,
            "before": before,
            "after": hashes(),
            "byte_hashes_identical": True,
            "full_reset": full,
            "links_only_reset": selective,
            "manual_overrides_cleared": True,
            "links_only_preserved_folders": True,
        }
        out = (
            Path(__file__).resolve().parents[1]
            / "outputs/review-7-implementation/reset-integrity.json"
        )
        out.write_text(json.dumps(receipt, indent=2))
        print(
            f"{len(before)} original versions preserved byte-for-byte; full/selective reset passed"
        )


if __name__ == "__main__":
    main()
