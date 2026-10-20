"""Weight storage, bounded lookup, MPS execution and existing-index protection."""
from types import SimpleNamespace
import json

import pytest
import torch
from torchao.quantization import Int8Tensor

from symbiknow.embeddings import runtime as embeddings
from symbiknow.embeddings.quantization import CONVERSION_ROWS, SelectedInt8Embedding, quantize_text, quantize_weight


def test_vocabulary_conversion_has_bounded_float32_temporaries(monkeypatch):
    original = Int8Tensor.from_hp
    batches = []

    def checked(cls, values, *args, **kwargs):
        assert values.shape[0] <= CONVERSION_ROWS
        batches.append(values.shape[0])
        return original(values, *args, **kwargs)

    monkeypatch.setattr(Int8Tensor, "from_hp", classmethod(checked))
    source = torch.randn(5000, 64, generator=torch.Generator().manual_seed(12)).bfloat16()
    weight = quantize_weight(source)
    assert batches == [2048, 2048, 904]
    assert weight.qdata.dtype == torch.int8
    assert weight.dtype == torch.float32
    assert not weight.requires_grad
    assert weight.qdata.nbytes + weight.scale.nbytes < source.numel() * 2
    assert (weight.dequantize() - source.float()).abs().max() < 0.025


def test_selected_lookup_decodes_only_requested_rows_and_preserves_scale(monkeypatch):
    source = torch.randn(300, 64, generator=torch.Generator().manual_seed(13))
    weight = quantize_weight(source)
    expected = weight.dequantize()
    module = SelectedInt8Embedding(SimpleNamespace(
        weight=weight, scalar_embed_scale=2.25, embedding_dim=64, num_embeddings=300, padding_idx=0,
    ))
    original = Int8Tensor.dequantize
    decoded = []

    def checked(self, *args, **kwargs):
        decoded.append(self.qdata.shape[0])
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Int8Tensor, "dequantize", checked)
    ids = torch.tensor([[0, 21, 299], [21, 2, 7]])
    assert torch.equal(module(ids), expected[ids] * 2.25)
    assert decoded == [ids.numel()]
    with pytest.raises((IndexError, RuntimeError)):
        module(torch.tensor([-1]))


class ScaledEmbedding(torch.nn.Embedding):
    def __init__(self):
        super().__init__(300, 64)
        self.scalar_embed_scale = 2.25
        self.register_buffer("embed_scale", torch.tensor(2.25))


def model():
    result = torch.nn.Module()
    result.language_model = torch.nn.Module()
    result.language_model.embed_tokens = ScaledEmbedding()
    result.language_model.projection = torch.nn.Linear(64, 64, bias=False)
    result.vision_tower = torch.nn.Linear(64, 64, bias=False)
    return result.bfloat16()


def test_text_quantization_keeps_vision_weights_and_float32_arithmetic():
    m = model()
    vision = m.vision_tower.weight.detach().clone()
    original = m.language_model.projection.weight.detach().float().clone()
    quantize_text(m)
    assert torch.equal(m.vision_tower.weight, vision)
    assert m.vision_tower.weight.dtype == torch.bfloat16
    assert isinstance(m.language_model.embed_tokens, SelectedInt8Embedding)
    assert isinstance(m.language_model.projection.weight, Int8Tensor)
    inputs = torch.ones(2, 64)
    output = m.language_model.projection(inputs)
    assert output.dtype == torch.float32
    assert torch.allclose(output, inputs @ original.T, atol=0.02, rtol=0.02)


@pytest.mark.skipif(not torch.backends.mps.is_available(), reason="Apple Silicon MPS integration")
def test_quantized_embedding_and_linear_execute_on_mps():
    m = model()
    quantize_text(m)
    m.to("mps")
    with torch.inference_mode():
        vectors = m.language_model.embed_tokens(torch.tensor([[0, 10, 299]], device="mps"))
        output = m.language_model.projection(vectors)
        assert output.shape == (1, 3, 64)
        assert output.dtype == torch.float32
        assert bool(output.isfinite().all())
        assert m.language_model.embed_tokens.weight.qdata.device.type == "mps"


def test_int8_manifest_cannot_silently_mix_with_existing_float32_index(tmp_path, monkeypatch):
    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_RUNTIME", "torch")
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "none")
    embeddings.validate_index(tmp_path)
    old = embeddings.descriptor()
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    assert embeddings.descriptor()["quantization"] != old["quantization"]
    with pytest.raises(embeddings.EmbeddingUnavailable, match="manifest"):
        embeddings.validate_index(tmp_path)


def test_explicit_int8_on_untested_device_fails_before_loading_weights(monkeypatch):
    import transformers

    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_DEVICE", "cpu")
    monkeypatch.setattr(transformers.AutoConfig, "from_pretrained", lambda *a, **k: pytest.fail("weights/config must not load"))
    with pytest.raises(embeddings.EmbeddingUnavailable, match="CPU/CUDA fallback"):
        embeddings.EmbeddingGemma2()


def test_int8_cannot_adopt_an_unrecorded_populated_index(tmp_path, monkeypatch):
    from symbiknow.search import index as search

    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_RUNTIME", "torch")
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    monkeypatch.setattr(search, "_table", lambda *a: SimpleNamespace(count_rows=lambda: 1))
    with pytest.raises(embeddings.EmbeddingUnavailable, match="Legacy index"):
        embeddings.validate_index(tmp_path)
    assert not (tmp_path / "index/embedding-runtime.json").exists()


@pytest.mark.parametrize("installed", [None, "0.18.0"])
def test_missing_or_changed_quantizer_fails_before_loading_weights(monkeypatch, installed):
    import transformers

    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_DEVICE", "mps")
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)

    def get_version(name):
        if installed is None:
            raise embeddings.importlib.metadata.PackageNotFoundError(name)
        return installed

    monkeypatch.setattr(embeddings.importlib.metadata, "version", get_version)
    monkeypatch.setattr(transformers.AutoConfig, "from_pretrained", lambda *a, **k: pytest.fail("weights/config must not load"))
    with pytest.raises(embeddings.EmbeddingUnavailable, match="require torchao==0.17.0"):
        embeddings.EmbeddingGemma2()


def test_invalid_quantization_option_fails_clearly(monkeypatch):
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "8")
    with pytest.raises(embeddings.EmbeddingUnavailable, match="none or int8"):
        embeddings.descriptor()


def proof():
    return {
        "existing_index_queries": 80, "minimum_query_cosine": 0.999,
        "existing_index_top1_agreement": 1.0, "existing_index_top3_overlap": 1.0,
        "existing_index_expected_top1_losses": 0, "existing_index_expected_top3_losses": 0,
        "production_expected_top1_losses": 0, "production_expected_top3_losses": 0,
        "image_top1_correct": 10, "image_total": 10,
        "resource_checks_passed": True, "original_byte_checks_passed": True,
    }


def test_explicit_measured_approval_preserves_base_manifest_and_fallback(tmp_path, monkeypatch):
    from filelock import FileLock

    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_RUNTIME", "torch")
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "none")
    embeddings.validate_index(tmp_path)
    path = tmp_path / "index/embedding-runtime.json"
    original = path.read_bytes()
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    with FileLock(tmp_path / "server.lock"):
        embeddings.record_validated_precision(tmp_path, proof())
    embeddings.validate_index(tmp_path)
    assert path.read_bytes() == original
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "none")
    embeddings.validate_index(tmp_path)
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    approval = path.with_name("embedding-runtime-compatibility.json")
    data = json.loads(approval.read_text())
    data["compatible"]["dimensions"] = 512
    approval.write_text(json.dumps(data))
    with pytest.raises(embeddings.EmbeddingUnavailable, match="manifest"):
        embeddings.validate_index(tmp_path)


@pytest.mark.parametrize("field,value", [
    ("minimum_query_cosine", 0.98), ("existing_index_queries", 12),
    ("existing_index_expected_top3_losses", 1), ("production_expected_top1_losses", 2),
    ("image_top1_correct", 9), ("resource_checks_passed", False),
])
def test_failed_validation_cannot_authorize_mixed_precision(tmp_path, monkeypatch, field, value):
    monkeypatch.setenv("SYMBIKNOW_EMBEDDING_RUNTIME", "torch")
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "none")
    embeddings.validate_index(tmp_path)
    monkeypatch.setenv("SYMBIKNOW_TORCH_QUANTIZATION", "int8")
    measurements = proof()
    measurements[field] = value
    with pytest.raises(embeddings.EmbeddingUnavailable, match="has not passed"):
        embeddings.record_validated_precision(tmp_path, measurements)
    assert not (tmp_path / "index/embedding-runtime-compatibility.json").exists()
