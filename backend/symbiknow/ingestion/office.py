"""Docling Office text/table backends without external drawing renderers."""

from docling.backend.msexcel_backend import MsExcelDocumentBackend
from docling.backend.msword_backend import MsWordDocumentBackend


class TextWordBackend(MsWordDocumentBackend):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Word text, tables and native chart data remain available. Never launch
        # LibreOffice to rasterize drawings from an imported original.
        self.docx_to_pdf_converter = None
        self.docx_to_pdf_converter_init = True


class TextExcelBackend(MsExcelDocumentBackend):
    def _get_libreoffice_converter(self):
        return None
