"""Every advertised image format must reach visual indexing."""

from io import BytesIO

from PIL import Image
import pytest

from symbiknow.ingestion.service import VisualUnits


@pytest.mark.parametrize("format", ["PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF"])
@pytest.mark.parametrize("source_kind", ["bytes", "path"])
def test_supported_single_frame_images(format, source_kind, tmp_path):
    output = BytesIO()
    with Image.new("RGB", (32, 24), "blue") as image:
        image.save(output, format=format)
    content = output.getvalue()
    if source_kind == "path":
        path = tmp_path / ("image." + format.lower())
        path.write_bytes(content)
        content = path
    units = VisualUnits(content, image=True)
    assert len(units) == 1
    seen = []
    for unit in units:
        seen.append(unit["page"])
        assert unit["image"].size == (32, 24)
        assert unit["image"].mode == "RGB"
    assert seen == [1]
