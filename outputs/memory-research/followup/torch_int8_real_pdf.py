"""Actual W8 ingestion of scanned table pages, OCR/page evidence and bilingual retrieval."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.update(SYMBIKNOW_EMBEDDING_RUNTIME="torch", SYMBIKNOW_TORCH_QUANTIZATION="int8",
                  SYMBIKNOW_EMBEDDING_DEVICE="mps", HF_HOME=str(ROOT / "data/models"),
                  HF_HUB_OFFLINE="1", TYPESAFE_API_KEY="")
from PIL import Image, ImageDraw, ImageFont
from app import embeddings, ingest, search, storage

font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 32)
with tempfile.TemporaryDirectory(prefix="symbiknow-int8-pdf-") as temp:
    root = Path(temp)
    embeddings.validate_index(root)
    distractor = "Coffee and sandwiches are available in the cafe. קפה וכריכים בבית הקפה.".encode()
    other = storage.save_file(root, distractor, "cafe.txt")
    assert ingest.index_document(root, other, distractor)["status"] == "indexed"
    pages = []
    for number in (1, 2):
        page = Image.new("RGB", (1000, 1400), "white")
        draw = ImageDraw.Draw(page)
        draw.text((60, 70), f"ATLAS RELEASE SCHEDULE - PAGE {number}", font=font, fill="black")
        for r, row in enumerate([["Team", "Milestone", "Date"], ["Security", "Review", "July 15"], ["Design", "Interface", "June 10"]]):
            for c, text in enumerate(row):
                x, y = 60 + c * 290, 200 + r * 100
                draw.rectangle((x, y, x + 290, y + 100), outline="black", width=2)
                draw.text((x + 15, y + 25), text, font=font, fill="black")
        draw.text((60, 600), "Original file versions are preserved.", font=font, fill="black")
        pages.append(page)
    path = root / "scanned-table.pdf"
    pages[0].save(path, "PDF", save_all=True, append_images=pages[1:])
    for page in pages: page.close()
    meta = storage.save_file(root, path, path.name, mime_type="application/pdf")
    state = ingest.index_document(root, meta, path)
    assert state["status"] == "indexed", state.get("index_error")
    evidence = search.document_evidence(root, meta["document_id"], "v1", limit=128)
    text = "\n".join(e["text"] for e in evidence)
    found = {word: word.casefold() in text.casefold() for word in ["ATLAS", "Team", "Security", "Review", "July", "Original"]}
    assert all(found.values()), found
    text_pages = sorted({p["page_no"] for e in evidence if e["basis"] == "text" for p in e["provenance"].get("pages", [])})
    visual_pages = sorted(e["provenance"]["page"] for e in evidence if e["basis"] == "visual")
    assert text_pages == visual_pages == [1, 2]
    retrieval = {}
    for language, query in [("en", "When is the Security review in the Atlas release schedule?"),
                            ("he", "מתי מתקיימת בדיקת האבטחה בלוח הזמנים של אטלס?")]:
        matches = search.find_documents(root, query, mode="semantic", limit=5)
        retrieval[language] = matches[0]["document_id"] == meta["document_id"]
    assert all(retrieval.values()), retrieval
    with path.open("rb") as source: original = hashlib.file_digest(source, "sha256").hexdigest()
    with storage.verified_file(root, meta["document_id"]) as (stored, _):
        with stored.open("rb") as source: assert hashlib.file_digest(source, "sha256").hexdigest() == original
    embeddings.unload_idle(force=True)
    report = {"passed": True, "found": found, "text_pages": text_pages, "visual_pages": visual_pages,
              "bilingual_top1": retrieval, "original_sha256_verified": True,
              "runtime": embeddings.descriptor(), "limitation": "Generated scanned table mechanics test, not production OCR certification."}
    (OUT / "torch-int8-real-pdf.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
