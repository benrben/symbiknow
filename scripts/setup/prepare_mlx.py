# ruff: noqa: E402
"""Reproducible affine 8-bit text conversion; requires the pinned MLX runtime.
Install in a separate target (does not alter the torch fallback):
  uv pip install --target .tools/mlx-runtime --no-deps mlx==0.32.3 mlx-metal==0.32.3 \
    'mlx-vlm @ git+https://github.com/Blaizzy/mlx-vlm@3d87e88402f307efbf68e568971aa887ee7d9ed0'
Then run with PYTHONPATH=.tools/mlx-runtime USE_TORCH=0 and set
SYMBIKNOW_MLX_MODEL to the output path. Original source checkpoint is read-only.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from symbiknow.embeddings.runtime import MODEL_ID, MODEL_REVISION, MLX_VLM_REVISION

parser = argparse.ArgumentParser()
parser.add_argument("destination", type=Path)
args = parser.parse_args()
if args.destination.exists():
    raise SystemExit("Destination already exists; choose a new conversion directory")
import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_vlm.embedding_loader import load_embedding_model
from mlx_vlm.utils import get_class_predicate
from huggingface_hub import snapshot_download

source = Path(snapshot_download(MODEL_ID, revision=MODEL_REVISION))
config = json.loads((source / "config.json").read_text())
config["audio_config"] = None
model = load_embedding_model(source, config=config)
nn.quantize(
    model,
    group_size=64,
    bits=8,
    mode="affine",
    class_predicate=get_class_predicate(skip_vision=True),
)
mx.eval(model.parameters())
args.destination.mkdir(parents=True)
weights = dict(tree_flatten(model.parameters()))
output = args.destination / "model.safetensors"
mx.save_safetensors(str(output), weights)
config["quantization"] = {"group_size": 64, "bits": 8, "mode": "affine"}
(args.destination / "config.json").write_text(json.dumps(config, indent=2))
with output.open("rb") as handle:
    digest = hashlib.file_digest(handle, "sha256").hexdigest()
record = {
    "source_revision": MODEL_REVISION,
    "mlx": "0.32.3",
    "mlx_vlm_revision": MLX_VLM_REVISION,
    "bits": 8,
    "group_size": 64,
    "audio": False,
    "vision_precision": "bfloat16",
    "weights_sha256": digest,
    "quantized_modules": [k.removesuffix(".scales") for k in weights if k.endswith(".scales")],
}
(args.destination / "conversion.json").write_text(json.dumps(record, indent=2))
print(json.dumps({k: v for k, v in record.items() if k != "quantized_modules"}, indent=2))
