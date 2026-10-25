"""Hosted Jev repetition across a restart: what would a disk answer cache save?

Indexes an isolated copy of the fixture corpus with the configured real
embedding model, runs a full organization reset rebuild against hosted Jev,
clears every in-process judgment cache (as a restart would), and runs the same
reset again. Every provider request is digested (sha256 of state + questions;
no text is retained). A request in the second run whose digest the first run
already sent is one an answer-level disk cache keyed by the request would
serve; with that cache enabled, ``disk_answer_cache_hits`` counts the requests it
actually served without a provider call. Never reads the live library.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import uuid

REPO = Path(__file__).resolve().parents[1]
CORPUS = ("backend/tests/fixtures/library", "backend/tests/fixtures/ordinary-prose",
          "backend/tests/fixtures/review-4")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
    sys.path.insert(0, str(REPO / "backend"))
    from symbiknow.ai import jev, numeric, proof
    from symbiknow.api import mcp as server
    from symbiknow.embeddings.runtime import get_embedder, validate_index
    from symbiknow.ingestion import service as ingest
    from symbiknow.library import storage
    from symbiknow.organization import rebuild
    from symbiknow.search.metrics import CURRENT

    digests, original_call = [], jev._call

    def recorded(state, questions, client=None, **options):
        payload = json.dumps([state, {k: q.model_dump(mode="json") for k, q in questions.items()}],
                             sort_keys=True, ensure_ascii=False, default=str)
        digests.append(hashlib.sha256(payload.encode()).hexdigest())
        return original_call(state, questions, client, **options)

    jev._call = recorded
    report = {"started_utc": datetime.now(timezone.utc).isoformat(), "corpus": CORPUS, "runs": []}
    with tempfile.TemporaryDirectory(prefix="symbiknow-repeats-") as temporary:
        root = Path(temporary)
        server.DATA_DIR, server.STORAGE_ONLY = root, False
        storage.init_storage(root)
        validate_index(root)
        embedder = get_embedder()
        files = sorted(p for folder in CORPUS for p in (REPO / folder).iterdir() if p.is_file())
        for path in files:
            content = path.read_bytes()
            metadata = storage.save_file(root, content, path.name, request_id=str(uuid.uuid4()))
            assert ingest.index_document(root, metadata, content, embedder)["status"] == "indexed"
        report["documents"] = len(files)
        seen = set()
        for label in ("first reset", "reset after simulated restart"):
            for cache in (jev._ORGANIZATION_CACHE, proof._CACHE, numeric._CACHE):
                cache.clear()
            start = len(digests)
            metrics = {}
            token = CURRENT.set(metrics)
            try:
                rebuild.request(grouping=True, links=True)
                while rebuild.process_one():
                    pass
            finally:
                CURRENT.reset(token)
            sent = digests[start:]
            state = rebuild.status() or {}
            run = {"run": label, "provider_requests": len(sent),
                   "provider_calls_including_splits": metrics.get("provider_calls", 0),
                   "disk_answer_cache_hits": metrics.get("provider_answer_cache_hits", 0),
                   "input_tokens": metrics.get("provider_input_tokens", 0),
                   "output_tokens": metrics.get("provider_output_tokens", 0),
                   "repeated_from_earlier_run": sum(d in seen for d in sent),
                   "distinct_requests": len(set(sent)),
                   "outcome": {k: state.get(k) for k in ("status", "grouped", "unfiled", "links_added")}}
            run["disk_cache_hit_rate"] = run["repeated_from_earlier_run"] / len(sent) if sent else None
            seen.update(sent)
            report["runs"].append(run)
            print(json.dumps(run), flush=True)
    report["completed_utc"] = datetime.now(timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
