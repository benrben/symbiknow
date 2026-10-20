"""Streaming exact derived-evidence identity and durable completed-chunk receipts."""
import hashlib
import json
from pathlib import Path


def receipt_path(root, identity):
    return Path(root) / "temp" / "evidence-revisions" / (hashlib.sha256(identity.encode()).hexdigest() + ".json")


def receipt(root, identity):
    file = receipt_path(root, identity)
    return json.loads(file.read_text()) if file.exists() else None


def begin(root, metadata):
    """Revoke prior completion durably before any chunk mutation can begin."""
    from symbiknow.organization.edits import atomic
    atomic(receipt_path(root, metadata["document_id"]), {
        "schema": 1, "state": "preparing", "document_id": metadata["document_id"],
        "version": str(metadata["version"])})


class EvidenceDigest:
    def __init__(self, root, model, dimension):
        from symbiknow.ingestion.artifacts import extraction_descriptor
        runtime = Path(root) / "index" / "embedding-runtime.json"
        descriptor = {"schema": 1, "extraction": extraction_descriptor(), "chunking": "docling-structural-1",
                      "model": model, "dimension": dimension,
                      "runtime": json.loads(runtime.read_text()) if runtime.exists() else None}
        self.digest = hashlib.sha256()
        self._add(json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode())
        self.count = 0

    def _add(self, value):
        self.digest.update(len(value).to_bytes(8, "big"))
        self.digest.update(value)

    def add(self, batch):
        vectors = batch.column("vector").combine_chunks()
        matrix = vectors.flatten().to_numpy(zero_copy_only=False).reshape(batch.num_rows, -1)
        for index, row in enumerate(batch.select(["chunk_id", "text", "basis", "provenance_json"]).to_pylist()):
            row["provenance"] = json.loads(row.pop("provenance_json"))
            self._add(json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
            self._add(matrix[index].astype("<f4", copy=False).tobytes())
            self.count += 1

    def commit(self, root, metadata):
        from symbiknow.organization.edits import atomic
        value = {"schema": 1, "state": "completed", "document_id": metadata["document_id"], "version": str(metadata["version"]),
                 "evidence_revision": self.digest.hexdigest(), "chunk_count": self.count}
        atomic(receipt_path(root, metadata["document_id"]), value)
        return value["evidence_revision"]
