"""Pinned PyTorch weight-only INT8 text encoder; floating-point inference.

The vocabulary is quantized in bounded rows, and only requested rows are decoded.
Vision stays in bfloat16 on MPS. No dense vocabulary or dequantized layer is cached.

PyTorch's MPS allocator places any buffer of 10 MiB or more in a 1 GiB heap that
unified memory charges in full. The vocabulary therefore stays in CPU memory, and
wide projections dequantize in row blocks below that size.
"""

from importlib.metadata import version

import torch
from torchao.quantization import Int8Tensor, PerGroup

from symbiknow.embeddings.runtime import TORCHAO_VERSION, TORCH_INT8_GROUP as GROUP_SIZE

CONVERSION_ROWS = 2048
MPS_BUFFER_LIMIT = 8 * 2**20


class SelectedInt8Embedding(torch.nn.Module):
    """Preserve Gemma's embedding scale without decoding its entire vocabulary."""

    def __init__(self, original):
        super().__init__()
        self.weight = original.weight
        self.register_buffer("embed_scale", torch.tensor(original.scalar_embed_scale, dtype=torch.float32))
        self.embedding_dim = original.embedding_dim
        self.num_embeddings = original.num_embeddings
        self.padding_idx = original.padding_idx

    def _apply(self, fn, recurse=True):
        # Device moves skip the vocabulary; only selected rows reach the accelerator.
        return self

    def forward(self, ids):
        weight = self.weight
        indices = ids.reshape(-1).to(weight.qdata.device)
        selected = Int8Tensor(
            weight.qdata.index_select(0, indices),
            weight.scale.index_select(0, indices),
            weight.block_size,
            weight.dtype,
        )
        rows = selected.dequantize().reshape(*ids.shape, self.embedding_dim)
        return (rows * self.embed_scale.to(weight.dtype)).to(ids.device)


class RowBlockInt8Linear(torch.nn.Module):
    """Wide projection stored as output-row blocks, each dequantized below the MPS heap limit."""

    def __init__(self, original):
        super().__init__()
        rows = max(1, MPS_BUFFER_LIMIT // (original.in_features * 4))
        source = original.weight.detach()
        self.blocks = torch.nn.ParameterList(
            quantize_weight(source[start : start + rows]) for start in range(0, source.shape[0], rows)
        )
        self.bias = original.bias
        self.in_features = original.in_features
        self.out_features = original.out_features

    def forward(self, inputs):
        output = torch.cat([torch.nn.functional.linear(inputs, block) for block in self.blocks], dim=-1)
        return output if self.bias is None else output + self.bias


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
    for parent in list(model.language_model.modules()):
        for name, child in list(parent.named_children()):
            if isinstance(child, torch.nn.Linear) and child.weight.numel() * 4 > MPS_BUFFER_LIMIT:
                setattr(parent, name, RowBlockInt8Linear(child))
            elif isinstance(child, (torch.nn.Linear, torch.nn.Embedding)):
                child.weight = quantize_weight(child.weight)
    model.language_model.float()
    model.language_model.embed_tokens = SelectedInt8Embedding(model.language_model.embed_tokens)
