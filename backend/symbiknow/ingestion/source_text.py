"""Inert text extraction and bounded validation before structured conversion."""

from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


TEXT_LIMIT = 16 * 1024**2
OFFICE_LIMIT = 128 * 1024**2
OFFICE_MEMBER_LIMIT = 32 * 1024**2
OFFICE_ENTRIES = 4096
OFFICE_SOURCE_LIMIT = 64 * 1024**2
SVG_ELEMENTS = 50_000
SVG_DEPTH = 128
LITERAL_SUFFIXES = {".txt", ".py", ".sh"}
LITERAL_MIMES = {"text/plain", "text/x-python", "application/x-python-code",
                 "text/x-shellscript", "application/x-sh"}
OFFICE_MIMES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
}


def _bounded_bytes(content, limit):
    if isinstance(content, Path):
        with content.open("rb") as stream:
            raw = stream.read(limit + 1)
    else:
        raw = content
    if len(raw) > limit:
        raise ValueError("Source exceeds text conversion byte limit")
    return raw


def _reject_declarations(raw):
    # OOXML may be UTF-16/32. Removing NULs also catches declarations in those
    # encodings; no XML parser receives a DTD or entity declaration.
    normalized = raw.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in normalized or b"<!ENTITY" in normalized:
        raise ValueError("DTD and entity declarations are not supported")


def literal_text(content):
    return _bounded_bytes(content, TEXT_LIMIT).decode("utf-8-sig")


def svg_text(content):
    raw = _bounded_bytes(content, TEXT_LIMIT)
    _reject_declarations(raw)
    try:
        text = raw.decode("utf-8-sig")
        parser = ElementTree.XMLPullParser(events=("start", "end"))
        root, count, depth = None, 0, 0
        for offset in range(0, len(text), 65536):
            parser.feed(text[offset:offset + 65536])
            for event, element in parser.read_events():
                if event == "start":
                    root = element if root is None else root
                    count += 1
                    depth += 1
                    if count > SVG_ELEMENTS or depth > SVG_DEPTH:
                        raise ValueError("SVG structure exceeds conversion budget")
                else:
                    depth -= 1
        parser.close()
    except (ElementTree.ParseError, UnicodeError) as exc:
        raise ValueError("Invalid UTF-8 SVG document") from exc
    if root is None or root.tag.rsplit("}", 1)[-1] != "svg":
        raise ValueError("Expected an SVG root element")
    lines = []

    def text_only(element):
        text = [element.text or ""]
        for child in element:
            if child.tag.rsplit("}", 1)[-1] in {"tspan", "textPath"}:
                text.append(text_only(child))
            text.append(child.tail or "")
        return "".join(text)

    def visit(element):
        name = element.tag.rsplit("}", 1)[-1]
        if name in {"script", "style", "foreignObject", "defs"}:
            return
        if name in {"text", "title", "desc"}:
            text = text_only(element).strip()
            if text:
                lines.append(text)
            return
        for child in element:
            visit(child)

    visit(root)
    return "\n".join(lines)


def validate_office(content):
    """No extraction to disk, macros, XML entities or unbounded ZIP expansion."""
    if (content.stat().st_size if isinstance(content, Path) else len(content)) > OFFICE_SOURCE_LIMIT:
        raise ValueError("Office source exceeds conversion budget")
    try:
        with ZipFile(content if isinstance(content, Path) else BytesIO(content)) as archive:
            entries = archive.infolist()
            if (len(entries) > OFFICE_ENTRIES
                    or sum(item.file_size for item in entries) > OFFICE_LIMIT):
                raise ValueError("Office archive exceeds conversion budget")
            for item in entries:
                if item.flag_bits & 1 or item.file_size > OFFICE_MEMBER_LIMIT:
                    raise ValueError("Office archive member exceeds conversion budget or is encrypted")
                if item.filename.lower().endswith("vbaproject.bin"):
                    raise ValueError("Macro-enabled Office content is not supported")
                if item.filename.lower().endswith((".xml", ".rels")):
                    with archive.open(item) as stream:
                        raw = stream.read(OFFICE_MEMBER_LIMIT + 1)
                    if len(raw) > OFFICE_MEMBER_LIMIT:
                        raise ValueError("Office XML exceeds conversion budget")
                    _reject_declarations(raw)
    except BadZipFile as exc:
        raise ValueError("Invalid Office archive") from exc
