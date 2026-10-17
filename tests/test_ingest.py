"""Docling extraction and indexing state regression checks."""

from io import BytesIO

from PIL import Image
import pytest
from test_search import FixtureEmbedder

from app import storage
from app.ingest import extract_units, index_document
from app.search import document_evidence, get_document_status


def _save(root, filename, content, **kwargs):
    return storage.save_file(root, content, filename, **kwargs)


def test_plain_text_is_literal_and_utf8():
    units, visual, _ = extract_units(
        {"filename": "literal.txt", "mime_type": "text/plain"},
        "# Heading syntax stays literal\nCafé cat".encode(),
        FixtureEmbedder(),
    )
    assert "# Heading syntax stays literal" in units[0]["text"]
    assert "Café" in units[0]["text"]
    assert not visual


def test_unsupported_is_stored_with_explicit_status(tmp_path):
    storage.init_storage(tmp_path)
    original = b"\x00\x01unsupported bytes"
    meta = _save(tmp_path, "archive.bin", original)
    state = index_document(tmp_path, meta, original)
    assert state["status"] == "unsupported"
    assert not state["searchable_text"] and not state["searchable_visual"]
    assert storage.read_file(tmp_path, meta["document_id"])[0] == original


def test_embedding_failure_keeps_bytes_and_can_retry(tmp_path):
    storage.init_storage(tmp_path)
    meta = _save(tmp_path, "cat.txt", b"cat rests")

    class Broken(FixtureEmbedder):
        def embed_documents(self, *args):
            raise RuntimeError("test model outage")

    state = index_document(tmp_path, meta, b"cat rests", Broken())
    assert state["status"] == "failed"
    assert "test model outage" in state["index_error"]
    assert get_document_status(tmp_path, meta["document_id"])["status"] == "failed"
    assert index_document(tmp_path, meta, b"cat rests", FixtureEmbedder())["status"] == "indexed"
    assert len(storage.list_versions(tmp_path, meta["document_id"])) == 1


def test_native_image_survives_ocr_outage_and_labels_basis(tmp_path, monkeypatch):
    from app import ingest

    storage.init_storage(tmp_path)
    output = BytesIO()
    Image.new("RGB", (16, 16), "red").save(output, format="PNG")
    content = output.getvalue()
    meta = _save(tmp_path, "red.png", content)

    def unavailable():
        raise RuntimeError("OCR test outage")

    monkeypatch.setattr(ingest, "_converter", unavailable)
    state = index_document(tmp_path, meta, content, FixtureEmbedder())
    assert state["status"] == "indexed"
    assert state["searchable_visual"] and not state["searchable_text"]
    assert "OCR unavailable" in state["index_error"]
    evidence = document_evidence(tmp_path, meta["document_id"], "v1")
    assert evidence[0]["basis"] == "visual" and evidence[0]["text"] == ""


@pytest.mark.parametrize(
    "filename,mime", [("diagram.png", "image/png"), ("diagram.pdf", "application/pdf")]
)
def test_diagram_headers_and_picture_text_reach_evidence(monkeypatch, filename, mime):
    from types import SimpleNamespace
    from docling.datamodel.base_models import ConversionStatus
    from docling_core.types.doc import (
        BoundingBox,
        ContentLayer,
        DocItemLabel,
        DoclingDocument,
        ProvenanceItem,
    )
    from app import ingest

    doc = DoclingDocument(name=filename)
    prov = ProvenanceItem(page_no=1, bbox=BoundingBox(l=0, t=10, r=100, b=0), charspan=(0, 20))
    doc.add_text(
        label=DocItemLabel.PAGE_HEADER,
        text="PROJECT ATLAS",
        prov=prov,
        content_layer=ContentLayer.FURNITURE,
    )
    doc.add_text(label=DocItemLabel.TEXT, text="Visible introduction", prov=prov)
    picture = doc.add_picture(prov=prov)
    doc.add_text(
        label=DocItemLabel.TEXT, text="Original bytes survive reset", parent=picture, prov=prov
    )
    doc.add_text(
        label=DocItemLabel.SECTION_HEADER,
        text="Standalone diagram label",
        parent=picture,
        prov=prov,
    )
    doc.add_text(
        label=DocItemLabel.PAGE_FOOTER,
        text="Version history stays intact",
        prov=prov,
        content_layer=ContentLayer.FURNITURE,
    )
    monkeypatch.setattr(
        ingest,
        "_converter",
        lambda: SimpleNamespace(
            convert=lambda *a, **k: SimpleNamespace(status=ConversionStatus.SUCCESS, document=doc)
        ),
    )
    data = BytesIO()
    Image.new("RGB", (16, 16), "blue").save(data, format="PNG")
    units, _, warnings = extract_units(
        {"filename": filename, "mime_type": mime}, data.getvalue(), FixtureEmbedder()
    )
    text = "\n".join(unit["text"] for unit in units)
    assert not warnings
    for expected in (
        "PROJECT ATLAS",
        "Original bytes survive reset",
        "Standalone diagram label",
        "Version history stays intact",
    ):
        assert expected in text
        assert any(expected in unit["text"] and unit["provenance"]["pages"] for unit in units)
    assert text.count("Original bytes survive reset") == 1
    assert all(unit["basis"] == ("ocr" if mime.startswith("image/") else "text") for unit in units)
