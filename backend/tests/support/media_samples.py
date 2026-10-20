"""Opt-in real file samples for local UI verification; never used by the live library."""
from io import BytesIO
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageFont
from symbiknow.library import storage
from symbiknow.search import index as search


def add_media_samples(root, embedder):
    pages = []
    for heading, subheading in [
        ("Original files, preserved", "Page one: stored contents and independent histories."),
        ("Retrieve an exact version", "Page two: request a document, version and checksum."),
    ]:
        image = Image.new("RGB", (800, 1000), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 28)
        draw.text((60, 75), "SYMBIKNOW / STORAGE", font=font, fill="#596273")
        draw.text((60, 150), heading, font=font, fill="#202631")
        draw.text((60, 230), subheading, font=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20), fill="#596273")
        draw.rectangle((60, 320, 740, 600), fill="#edf2fd")
        draw.text((95, 350), "A real saved PDF page", font=font, fill="#315fbe")
        pages.append(image)
    pdf, jpg, word = BytesIO(), BytesIO(), BytesIO()
    pages[0].save(pdf, "PDF", save_all=True, append_images=pages[1:])
    pages[1].resize((480, 600)).save(jpg, "JPEG")
    with ZipFile(word, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Evidence remains linked to the original document version.</w:t></w:r></w:p></w:body></w:document>')
    for name, data, mime, text in [
        ("storage-reference.pdf", pdf.getvalue(), "application/pdf", "Original files, preserved. Retrieve an exact version."),
        ("desktop-reference.jpg", jpg.getvalue(), "image/jpeg", ""),
        ("download-manifest.csv", b'File,Version,Check\nREADME.md,v2,Verified\n"notes, final.md",v1,Verified\n', "text/csv", "File, Version, Check"),
        ("answer-checks.docx", word.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Evidence remains linked to the original document version."),
    ]:
        metadata = storage.save_file(root, data, name, mime_type=mime)
        search.put_chunks(root, metadata, [{"chunk_id": f"{metadata['document_id']}:v1:t0", "text": text, "basis": "text" if text else "visual", "provenance_json": "{}", "vector": [1.0, 0.0, 0.1]}], embedder.model_id)
        search.set_document_status(root, metadata, status="indexed", indexed_version="v1", chunk_count=1)
        search.save_organization(root, metadata["document_id"], "v1", {"status": "evaluated", "folder": "Engineering", "groups": [], "links": []})
