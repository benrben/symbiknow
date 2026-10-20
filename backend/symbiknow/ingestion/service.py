"""Convert committed bytes with Docling, chunk, embed and replace derived index rows."""

from __future__ import annotations

import hashlib
import json
import os
from io import BytesIO
import tempfile
from pathlib import Path

from symbiknow.embeddings.runtime import get_embedder
from symbiknow.search.index import INDEX_LOCK, mark_pending, put_chunks, set_document_status


def supported(metadata):
    mime = metadata.get("mime_type", "").split(";", 1)[0]
    return mime in {
        "text/plain",
        "text/markdown",
        "text/x-markdown",
        "text/html",
        "application/xhtml+xml",
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/tiff",
    } or (
        Path(metadata["filename"]).suffix.lower()
        in {
            ".txt",
            ".md",
            ".markdown",
            ".html",
            ".htm",
            ".pdf",
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
            ".gif",
            ".bmp",
            ".tif",
            ".tiff",
        }
    )


def _converter():
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    options = PdfPipelineOptions()
    options.generate_page_images = False
    options.images_scale = 1.0
    # Pinned Docling 2.137 exposes these controls. Keep OCR and tables enabled.
    options.ocr_batch_size = options.layout_batch_size = options.table_batch_size = 1
    options.queue_max_size = 4
    options.document_timeout = float(os.getenv("SYMBIKNOW_CONVERSION_TIMEOUT", "300"))
    return DocumentConverter(
        allowed_formats=[InputFormat.MD, InputFormat.HTML, InputFormat.PDF, InputFormat.IMAGE],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        },
    )


class VisualUnits:
    """Compressed source only; one decoded RGB frame/page is owned by the iterator."""

    def __init__(self, source, image=False):
        self.source, self.image, self.pages = source, image, []
        if image:
            from PIL import Image

            with Image.open(source if isinstance(source, Path) else BytesIO(source)) as opened:
                # Pillow exposes n_frames only for formats with frame support.
                self.pages = range(1, getattr(opened, "n_frames", 1) + 1)

    def __len__(self):
        return len(self.pages)

    def __iter__(self):
        if self.image:
            from PIL import Image

            with Image.open(
                self.source if isinstance(self.source, Path) else BytesIO(self.source)
            ) as opened:
                for page in self.pages:
                    opened.seek(page - 1)
                    image = opened.convert("RGB")
                    try:
                        yield {"image": image, "page": page}
                    finally:
                        image.close()
        elif self.pages:
            import pypdfium2 as pdfium

            with pdfium.PdfDocument(
                str(self.source) if isinstance(self.source, Path) else self.source
            ) as document:
                for number in self.pages:
                    page = document[number - 1]
                    bitmap = page.render(scale=1.0, may_draw_forms=False)
                    image = bitmap.to_pil().convert("RGB")
                    try:
                        yield {"image": image, "page": number}
                    finally:
                        image.close()
                        bitmap.close()
                        page.close()


def extract_units(metadata, content, embedder, *, isolated=False, artifact_store=None, source_digest=None):
    """Text uses the model's own tokenizer; image representations never imply OCR evidence."""
    from docling.datamodel.base_models import ConversionStatus, DocumentStream
    from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
    from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
    from docling_core.types.doc import DocItemLabel, DoclingDocument

    filename = metadata["filename"]
    suffix = Path(filename).suffix.lower()
    mime = metadata.get("mime_type", "").split(";", 1)[0]
    image = mime.startswith("image/") or suffix in {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
        ".bmp",
        ".tif",
        ".tiff",
    }
    visual = VisualUnits(content, image=image)
    heavy = image or mime == "application/pdf" or suffix == ".pdf"

    def convert_document():
        warnings = []
        if mime == "text/plain" or suffix == ".txt":
            text = (content.read_bytes() if isinstance(content, Path) else content).decode("utf-8-sig")
            doc = DoclingDocument(name=filename)
            # Plain TXT remains literal text rather than interpreting Markdown syntax.
            doc.add_text(label=DocItemLabel.PARAGRAPH, text=text)
            return doc, warnings
        if isolated:
            from symbiknow.ingestion.conversion.manager import get_conversion_manager

            if heavy:
                boundary = getattr(embedder, "conversion_boundary", None)
                if boundary is not None:
                    boundary()
            with tempfile.TemporaryDirectory(prefix="symbiknow-convert-") as directory:
                root = Path(directory)
                # User filenames can never alias worker outputs or overwrite a lease.
                source = root / ("input" + suffix)
                if isinstance(content, Path):
                    source.symlink_to(content.resolve())
                else:
                    source.write_bytes(content)
                result = get_conversion_manager().convert(source, root, filename, heavy=heavy)
                doc = DoclingDocument.load_from_json(root / "document.json")
                if result["partial"]:
                    warnings.append("Docling reported partial conversion")
        else:
            conversion = _converter().convert(
                content if isinstance(content, Path)
                else DocumentStream(name=Path(filename).name, stream=BytesIO(content)),
                max_num_pages=int(os.getenv("SYMBIKNOW_MAX_PAGES", "1000")),
            )
            if conversion.status not in {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}:
                raise ValueError(f"Docling conversion status: {conversion.status}")
            if conversion.status == ConversionStatus.PARTIAL_SUCCESS:
                warnings.append("Docling reported partial conversion")
            doc = conversion.document
        return doc, warnings

    try:
        if artifact_store is not None:
            from symbiknow.library.storage import _digest_path

            digest = source_digest or (_digest_path(content) if isinstance(content, Path) else hashlib.sha256(content).hexdigest())
            doc, warnings = artifact_store.document(metadata, digest, convert_document)
        else:
            doc, warnings = convert_document()
        if not image:
            visual.pages = sorted(doc.pages)
    except Exception as exc:
        if not image:
            raise
        # Native visual retrieval remains available if OCR dependencies/conversion fail.
        warnings = [f"OCR unavailable: {type(exc).__name__}: {exc}"]
        doc = DoclingDocument(name=filename)
    tokenizer = getattr(embedder, "chunk_tokenizer", None)
    if tokenizer is None:
        tokenizer = HuggingFaceTokenizer(tokenizer=embedder.tokenizer, max_tokens=512)
    chunking = {}
    if image or mime == "application/pdf" or suffix == ".pdf":
        from docling_core.transforms.chunker.hierarchical_chunker import (
            ChunkingDocSerializer,
            ChunkingSerializerProvider,
        )
        from docling_core.types.doc import ContentLayer

        class EvidenceSerializerProvider(ChunkingSerializerProvider):
            def get_serializer(self, doc):
                serializer = ChunkingDocSerializer(doc=doc)
                # Diagram text can live inside pictures, and its project name can
                # be a page header. Keep Docling's extracted text and provenance.
                serializer.params = serializer.params.model_copy(
                    update={"traverse_pictures": True, "layers": set(ContentLayer)}
                )
                return serializer

        chunking = {
            "serializer_provider": EvidenceSerializerProvider(),
            "always_emit_headings": True,
        }
    chunker = HybridChunker(tokenizer=tokenizer, **chunking)
    text_units = []
    for chunk in chunker.chunk(dl_doc=doc):
        text = chunker.contextualize(chunk=chunk)
        if not text.strip():
            continue
        provenance = []
        for item in chunk.meta.doc_items:
            for prov in item.prov:
                provenance.append(prov.model_dump(mode="json"))
        text_units.append(
            {
                "text": text,
                "basis": "ocr" if image else "text",
                "provenance": {"pages": provenance, "headings": chunk.meta.headings or []},
            }
        )
    return text_units, visual, warnings


class ChunkSpool:
    """Small Arrow batches in an unpublished temporary stream; no document-sized float lists."""

    def __init__(self):
        self.file = tempfile.TemporaryFile()
        self.writer = None
        self.pending = []
        self.count = 0

    def __len__(self):
        return self.count

    def append(self, row):
        self.pending.append(row)
        self.count += 1
        if len(self.pending) >= 4:
            self.flush()

    def flush(self):
        if not self.pending:
            return
        import pyarrow as pa
        from symbiknow.search.index import chunk_schema

        schema = chunk_schema(len(self.pending[0]["vector"]))
        schema = pa.schema(
            [schema.field(k) for k in ("chunk_id", "text", "basis", "provenance_json", "vector")]
        )
        table = pa.Table.from_pylist(self.pending, schema=schema)
        if self.writer is None:
            self.writer = pa.ipc.new_stream(self.file, schema)
        self.writer.write_table(table)
        self.pending.clear()

    def reader(self):
        import pyarrow as pa

        self.flush()
        self.writer.close()
        self.file.seek(0)
        return pa.ipc.open_stream(self.file)

    def close(self):
        if self.writer:
            self.writer.close()
        self.file.close()


def index_document(data_dir, metadata, content: bytes | Path, embedder=None, *, on_invalidate=None):
    """Only derived data is changed here. The caller must first commit originals via storage.save."""
    from symbiknow.library.storage import current_version

    with INDEX_LOCK:
        if current_version(data_dir, metadata["document_id"]) != str(metadata["version"]):
            return {**metadata, "status": "superseded", "indexed_version": ""}
        mark_pending(data_dir, metadata)
        if not supported(metadata):
            return set_document_status(
                data_dir,
                metadata,
                status="unsupported",
                index_error="Original stored; format is not supported for indexing",
            )
    rows = None
    try:
        from symbiknow.library.storage import _digest_path

        digest = (
            _digest_path(content)
            if isinstance(content, Path)
            else hashlib.sha256(content).hexdigest()
        )
        if metadata.get("sha256") and digest != metadata["sha256"]:
            raise ValueError("Indexing bytes do not match committed original SHA-256")
        isolated = embedder is None
        embedder = embedder or get_embedder()
        if isolated:
            from symbiknow.embeddings.runtime import validate_index

            validate_index(data_dir)
        from symbiknow.ingestion.artifacts import ExtractionArtifacts

        text_units, visual, warnings = extract_units(
            metadata, content, embedder, isolated=isolated,
            artifact_store=ExtractionArtifacts(data_dir), source_digest=digest,
        )
        rows = ChunkSpool()
        # Small batches bound model input and memory; vector rows stay derived and replaceable.
        for start in range(0, len(text_units), 4):
            units = text_units[start : start + 4]
            vectors = embedder.embed_documents([u["text"] for u in units], metadata["filename"])
            for unit, vector in zip(units, vectors, strict=True):
                rows.append(
                    {
                        "chunk_id": f"{metadata['document_id']}:{metadata['version']}:t{len(rows)}",
                        "text": unit["text"],
                        "basis": unit["basis"],
                        "provenance_json": json.dumps(unit["provenance"]),
                        "vector": vector,
                    }
                )
        for start, unit in enumerate(visual):
            vector = embedder.embed_images([unit["image"]])[0]
            rows.append(
                {
                    "chunk_id": f"{metadata['document_id']}:{metadata['version']}:v{start}",
                    "text": "",
                    "basis": "visual",
                    "provenance_json": json.dumps({"page": unit["page"]}),
                    "vector": vector,
                }
            )
        with INDEX_LOCK:
            if current_version(data_dir, metadata["document_id"]) != str(metadata["version"]):
                return {**metadata, "status": "superseded", "indexed_version": ""}
            if not rows:
                return set_document_status(
                    data_dir,
                    metadata,
                    status="empty",
                    index_error="No textual or visual evidence extracted",
                )
            put_chunks(data_dir, metadata, rows.reader(), embedder.model_id, on_invalidate=on_invalidate)
            from symbiknow.core.retry import clear

            clear(data_dir, metadata["document_id"])
            return set_document_status(
                data_dir,
                metadata,
                status="indexed",
                indexed_version=str(metadata["version"]),
                chunk_count=len(rows),
                searchable_text=bool(text_units),
                searchable_visual=bool(visual),
                index_error="; ".join(warnings),
            )
    except Exception as exc:  # noqa: BLE001 - failed indexing must preserve a durable retryable state
        with INDEX_LOCK:
            if current_version(data_dir, metadata["document_id"]) != str(metadata["version"]):
                return {**metadata, "status": "superseded", "indexed_version": ""}
            from symbiknow.core.retry import failed
            from symbiknow.embeddings.runtime import EmbeddingUnavailable

            failed(
                data_dir,
                metadata,
                exc,
                permanent=isinstance(exc, (ValueError, UnicodeError, EmbeddingUnavailable)),
            )
            return set_document_status(
                data_dir, metadata, status="failed", index_error=f"{type(exc).__name__}: {exc}"
            )

    finally:
        if rows is not None:
            rows.close()
        if embedder is not None and hasattr(embedder, "job_boundary"):
            embedder.job_boundary()
