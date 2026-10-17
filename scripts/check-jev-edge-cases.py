"""Additional live MCP conflicts, partial answers, OCR, visual-only and empty-file checks.

Run after check-jev-actions.py against the same isolated server at port 8767.
The corpus is authored synthetic test material, never production-library content.
"""

import asyncio
import base64
import io
import json
from pathlib import Path
import sys
import time
import uuid

import httpx
from mcp import Client
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from client import call  # noqa: E402


async def main():
    out = Path("outputs/jev-actions-fixes/edge-cases")
    out.mkdir(parents=True, exist_ok=True)
    report = {"checks": [], "searches": {}, "documents": {}}

    def check(name, passed, **details):
        entry = {"name": name, "passed": bool(passed), **details}
        report["checks"].append(entry)
        (out / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(entry), flush=True)

    image = Image.new("RGB", (1400, 700), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 44)
    draw.multiline_text(
        (80, 80),
        "Symbiknow\nStorage review\nOrganization reset preserves all file versions.\nOriginal file bytes remain unchanged.",
        font=font,
        fill="black",
        spacing=30,
    )
    files = []
    for extension, mime, fmt in [("png", "image/png", "PNG"), ("pdf", "application/pdf", "PDF")]:
        buffer = io.BytesIO()
        image.save(buffer, format=fmt)
        files.append(("Symbiknow preservation scan." + extension, mime, buffer.getvalue()))
    visual = io.BytesIO()
    Image.new("RGB", (300, 300), "#2277bb").save(visual, format="PNG")
    files.extend(
        [
            ("Plain blue image.png", "image/png", visual.getvalue()),
            ("Empty file.txt", "text/plain", b""),
            (
                "Delta approved preserve.md",
                "text/markdown",
                b"# Delta / Storage / Current approved policy A\nCurrent approved Delta retention policy: Delta reset preserves every original and all version history. This policy is in force now.",
            ),
            (
                "Delta approved delete.md",
                "text/markdown",
                b"# Delta / Storage / Current approved policy B\nCurrent approved Delta retention policy: Delta reset deletes every original and all version history. This policy is in force now.",
            ),
        ]
    )
    base = "http://127.0.0.1:8767"
    async with (
        Client(base + "/mcp") as mcp,
        httpx.AsyncClient(
            base_url=base, headers={"Origin": base, "X-Symbiknow-UI": "1"}, timeout=90
        ) as http,
    ):
        for name, mime, content in files:
            result = (
                await call(
                    mcp,
                    "upload",
                    {
                        "files": [
                            {
                                "filename": name,
                                "mime_type": mime,
                                "source": "synthetic-jevmcp-edge-cases",
                                "request_id": str(uuid.uuid4()),
                                "content_base64": base64.b64encode(content).decode(),
                            }
                        ]
                    },
                )
            )["files"][0]
            check("MCP stores " + name, result.get("stored"))
            report["documents"][name] = result
        deadline = time.monotonic() + 480
        ids = {m["document_id"] for m in report["documents"].values()}
        while True:
            library = (await http.get("/api/library?limit=100")).json()
            rows = [d for d in library["documents"] if d["document_id"] in ids]
            if (
                len(rows) == len(files)
                and not library["processing"]
                and all(d["status"] not in {"pending", "indexing"} for d in rows)
            ):
                break
            if time.monotonic() > deadline:
                raise TimeoutError("Media indexing")
            await asyncio.sleep(2)
        for name, _, content in files:
            identity = report["documents"][name]["document_id"]
            downloaded = (await call(mcp, "download", {"files": [{"document_id": identity}]}))[
                "files"
            ][0]
            check(
                "MCP byte integrity " + name,
                base64.b64decode(downloaded["content_base64"]) == content,
            )
            d = (await http.get("/api/document", params={"id": identity})).json()
            report["documents"][name] = d
            if name.startswith("Symbiknow"):
                check(
                    "Extracted real text " + name,
                    any("preserves" in e["text"].lower() for e in d["evidence"]),
                )
                check(
                    "Media grouped " + name,
                    d["organization"]["folder"].startswith("Symbiknow"),
                    folder=d["organization"]["folder"],
                )
        queries = [
            (
                "partial",
                "Does Symbiknow reset preserve versions, and what is its annual revenue?",
                "Symbiknow",
            ),
            ("conflict", "Does Delta reset preserve original files and version history?", "Delta"),
            (
                "ocr",
                "Does Symbiknow reset preserve original file bytes and all versions?",
                "Symbiknow",
            ),
        ]
        for key, query, folder in queries:
            result = await call(
                mcp,
                "search",
                {"query": query, "mode": "answer", "folder": folder, "limit": 8, "detail": "full"},
            )
            report["searches"][key] = result
            check("Live Jev " + key, result["evaluation"]["status"] == "evaluated")
            supported = [
                m for m in result["matches"] if m.get("jev", {}).get("supporting_chunk_ids")
            ]
            if key == "partial":
                check(
                    "Missing subanswer cannot be complete",
                    bool(supported) and all(m["jev"]["coverage"] != "complete" for m in supported),
                    labels=[(m["filename"], m["jev"]["coverage"]) for m in supported],
                )
            if key == "conflict":
                check(
                    "Applicable current conflict detected",
                    len(supported) == 2
                    and all(
                        m["jev"].get("evidence_disagreement") == "accepted"
                        and m["jev"]["label"] == "uncertain"
                        for m in supported
                    ),
                )
            if key == "ocr":
                check(
                    "OCR/PDF cited as answer evidence",
                    sum(m["filename"].endswith((".pdf", ".png")) for m in supported) == 2,
                )
        visual_id = report["documents"]["Plain blue image.png"]["document"]["document_id"]
        result = await call(
            mcp,
            "search",
            {
                "query": "plain blue image",
                "mode": "semantic",
                "evaluate": True,
                "limit": 30,
                "detail": "full",
            },
        )
        report["searches"]["visual_only"] = result
        pure = [m for m in result["matches"] if m["document_id"] == visual_id]
        check(
            "Visual-only has no fabricated text support",
            bool(pure) and not pure[0].get("jev", {}).get("supporting_chunk_ids"),
        )
        response = await http.post("/api/rebuild", json={"mode": "unfiled"})
        response.raise_for_status()
        for _ in range(240):
            job = (await http.get("/api/rebuild")).json()
            if job["status"] not in {"running", "queued"}:
                break
            await asyncio.sleep(1)
        report["job"] = job
        empty_id = report["documents"]["Empty file.txt"]["document"]["document_id"]
        check(
            "Empty/visual-only grouping has explicit skip reasons",
            all(
                any(
                    d["document_id"] == identity and d["outcome"] == "skipped" and d["reason"]
                    for d in job["details"]
                )
                for identity in [empty_id, visual_id]
            ),
        )
        report["summary"] = {
            "passed": sum(c["passed"] for c in report["checks"]),
            "total": len(report["checks"]),
        }
        (out / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report["summary"]), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
