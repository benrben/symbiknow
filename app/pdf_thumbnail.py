"""Bounded, isolated page renderer using Docling's existing PDFium dependency."""

import sys
from io import BytesIO


def main():
    import pypdfium2 as pdfium

    with pdfium.PdfDocument(sys.argv[1]) as document:
        page_number = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        edge = int(sys.argv[3]) if len(sys.argv) > 3 else 340
        if not 1 <= page_number <= len(document) or not 1 <= edge <= 1400:
            raise ValueError("PDF page is out of range")
        page = document[page_number - 1]
        width, height = page.get_size()
        if width <= 0 or height <= 0:
            raise ValueError("Invalid page bounds")
        bitmap = page.render(scale=min(2, edge / max(width, height)), may_draw_forms=False)
        try:
            image = bitmap.to_pil().convert("RGB")
            image.thumbnail((264, 340) if edge == 340 else (edge, edge))
            output = BytesIO()
            image.save(output, format="JPEG", quality=85)
            sys.stdout.buffer.write(output.getvalue())
            print(f"pages:{len(document)}", file=sys.stderr)
        finally:
            bitmap.close()
            page.close()


if __name__ == "__main__":
    main()
