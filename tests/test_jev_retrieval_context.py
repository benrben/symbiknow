"""Regression: retain a correction ranked fourth in actual context assembly."""

import tempfile
from pathlib import Path
from pytest import MonkeyPatch
from app import search, storage


def test_rank_four_correction_and_intro_survive_context_assembly():
    texts = (
        ["Lumen document introduction."]
        + [f"Operational source passage {i}." for i in range(1, 7)]
        + ["Approved correction superseding all previous policy: Lumen preserves originals."]
    )
    all_rows = [
        dict(
            document_id="d0",
            version="v1",
            chunk_id=f"d0:v1:t{i}",
            text=t,
            basis="text",
            provenance_json="{}",
            active=True,
        )
        for i, t in enumerate(texts)
    ]
    state = dict(
        document_id="d0",
        version="v1",
        indexed_version="v1",
        status="indexed",
        filename="record.md",
        sha256="synthetic",
        mime_type="text/markdown",
        source="synthetic",
        folder="",
        groups=[],
        organization_status="evaluated",
        links_json="[]",
    )

    class Table:
        def __init__(self, rows):
            self.rows = rows

        def search(self, *a, **kw):
            return self

        def where(self, *a, **kw):
            return self

        def select(self, *a, **kw):
            return self

        def limit(self, *a, **kw):
            return self

        def to_list(self):
            return self.rows

    results = []
    for name, order in [
        ("correction_rank4", [1, 2, 3, 7, 4, 5, 6, 0]),
        ("correction_rank1", [7, 1, 2, 3, 4, 5, 6, 0]),
    ]:
        rows = [dict(all_rows[i], _score=10 - rank) for rank, i in enumerate(order)]
        requests = []

        def resolve(root, refs):
            requests.extend(refs)
            return {
                ("d0", "v1", r["chunk_id"]): dict(
                    evidence_id=r["chunk_id"], text=r["text"], basis="text", provenance={}
                )
                for r in all_rows
                if ("d0", "v1", r["chunk_id"]) in refs
            }

        with (
            tempfile.TemporaryDirectory(prefix="jev-selection-") as temp,
            MonkeyPatch.context() as m,
        ):
            m.setattr(search, "_table", lambda *a, **k: Table(rows))
            m.setattr(search, "revisions", lambda *a: 0)
            m.setattr(search, "document_statuses", lambda *a: {"d0": state})
            m.setattr(storage, "current_version", lambda *a: "v1")
            m.setattr(search, "resolve_evidence_many", resolve)
            output = search.find_documents(
                Path(temp), "Lumen reset policy", mode="keyword", limit=1
            )
        refs = [e["evidence_id"] for e in output[0]["evidence"]]
        results.append(
            dict(
                case=name,
                retrieved=[r["chunk_id"] for r in rows],
                provider_context=refs,
                context_requests=requests,
                correction_retained="d0:v1:t7" in refs,
                introduction_retained="d0:v1:t0" in refs,
            )
        )
    assert all(r["correction_retained"] for r in results)
    assert all(r["introduction_retained"] for r in results)
