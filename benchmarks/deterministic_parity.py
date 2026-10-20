"""Exact old/new output replay on isolated OCFL/LanceDB and fixture embeddings.

Run once with --source pointing to an archived baseline checkout and once with
the current checkout, then compare the JSON artifacts. ROCFL_BIN must point to
the installed pinned CLI when the archive has no local .tools directory.
Includes actual head update/deletion and SDK-parsed proof fixtures; no provider
calls or real-model inference. This is a correctness check, not a speed test.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    sys.path.insert(0, str(source / "backend"))
    from symbiknow.ingestion import service as ingest
    from symbiknow.search import index as search
    from symbiknow.api import mcp as server
    from symbiknow.library import storage
    from symbiknow.ai import jev
    from tests.search.test_search import FixtureEmbedder
    from tests.ai.test_jev_proof import sdk, document

    search.get_embedder = FixtureEmbedder
    records = {}

    def capture(label):
        for query in ("cat", "dog", "feline canine", "version preservation"):
            for mode in ("keyword", "semantic", "hybrid"):
                for folder in (None, "Animals", "Animals / Cats"):
                    result = server.search(query, mode=mode, limit=8, folder=folder, detail="full")
                    records[f"{label}/{query}/{mode}/{folder}"] = [
                        {key: match.get(key) for key in
                         ("document_id", "version", "filename", "folder", "groups", "evidence", "links")}
                        for match in result["matches"]
                    ]

    with tempfile.TemporaryDirectory(prefix="symbiknow-independent-parity-") as temporary:
        root = Path(temporary)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        for number in range(31):
            animal = "cat feline" if number % 2 == 0 else "dog canine"
            text = (f"{animal} policy {number}. Original version preservation protects documents. "
                    + ("A cat rests on the sofa." if number % 3 else "A canine walks outside."))
            metadata = storage.save_file(
                root, text.encode(), f"policy-{number:02d}.txt",
                document_id=f"parity-{number:02d}", request_id=f"create-{number}",
            )
            assert ingest.index_document(root, metadata, text.encode(), FixtureEmbedder())["status"] == "indexed"
            search.save_organization(
                root, metadata["document_id"], "v1",
                dict(status="evaluated", folder="Animals / Cats" if number % 2 == 0 else "Animals / Dogs",
                     groups=["Pets"], links=[]),
            )
        capture("initial")
        storage.save_file(root, b"new dog evidence", "policy-00.txt", document_id="parity-00",
                          request_id="update-0", expected_version="v1")
        storage.delete_document(root, "parity-01", "v1")
        capture("changed")
        for coverage in ("complete", "partial", "missing", "conflicting"):
            with sdk({"coverage": coverage}) as client:
                result = jev.judge_matches("What is the policy?", [document()], client=client)
            records["proof/" + coverage] = result
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(records, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    digest = hashlib.sha256(json.dumps(records, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    print(json.dumps({"cases": len(records), "sha256": digest}))


if __name__ == "__main__":
    main()
