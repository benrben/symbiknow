"""Pinned PyTorch weight-only INT8 text encoder; floating-point inference.

The vocabulary is quantized in bounded rows, and only requested rows are decoded.
Vision stays in bfloat16 on MPS. No dense vocabulary or dequantized layer is cached.
"""

from importlib.metadata import version

import torch
from torchao.quantization import Int8Tensor, PerGroup

from symbiknow.embeddings.runtime import TORCHAO_VERSION, TORCH_INT8_GROUP as GROUP_SIZE

CONVERSION_ROWS = 2048


class SelectedInt8Embedding(torch.nn.Module):
    """Preserve Gemma's embedding scale without decoding its entire vocabulary."""

    def __init__(self, original):
        super().__init__()
        self.weight = original.weight
        self.register_buffer("embed_scale", torch.tensor(original.scalar_embed_scale, dtype=torch.float32))
        self.embedding_dim = original.embedding_dim
        self.num_embeddings = original.num_embeddings
        self.padding_idx = original.padding_idx

    def forward(self, ids):
        weight = self.weight
        indices = ids.reshape(-1)
        selected = Int8Tensor(
            weight.qdata.index_select(0, indices),
            weight.scale.index_select(0, indices),
            weight.block_size,
            weight.dtype,
        )
        rows = selected.dequantize().reshape(*ids.shape, self.embedding_dim)
        return rows * self.embed_scale.to(weight.dtype)


def quantize_weight(weight):
    """CPU conversion with bounded float32 temporaries, including vocabulary tables."""
    source = weight.detach()
    rows, width = source.shape
    if source.device.type != "cpu" or width % GROUP_SIZE:
        raise ValueError("INT8 conversion requires CPU weights with group-aligned columns")
    qdata = torch.empty((rows, width), dtype=torch.int8)
    scales = torch.empty((rows, width // GROUP_SIZE), dtype=torch.float32)
    for start in range(0, rows, CONVERSION_ROWS):
        part = Int8Tensor.from_hp(source[start : start + CONVERSION_ROWS].float(), PerGroup(GROUP_SIZE))
        qdata[start : start + CONVERSION_ROWS].copy_(part.qdata)
        scales[start : start + CONVERSION_ROWS].copy_(part.scale)
    return torch.nn.Parameter(
        Int8Tensor(qdata, scales, [1, GROUP_SIZE], torch.float32), requires_grad=False
    )


def quantize_text(model):
    if version("torchao") != TORCHAO_VERSION:
        raise ValueError("INT8 embeddings require torchao==" + TORCHAO_VERSION)
    for module in model.language_model.modules():
        if isinstance(module, (torch.nn.Linear, torch.nn.Embedding)):
            module.weight = quantize_weight(module.weight)
    model.language_model.float()
    model.language_model.embed_tokens = SelectedInt8Embedding(model.language_model.embed_tokens)
