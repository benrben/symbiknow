"""Isolated pinned TorchAO W8/BF16 trial. No MLX and no production index access."""
import gc
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(OUT.parent / "torchao-runtime"))
os.environ.update(HF_HOME=str(ROOT / "data/models"), HF_HUB_OFFLINE="1")
import numpy as np
import torch
from torchao.quantization import quantize_, Int8WeightOnlyConfig, PerGroup
from transformers import AutoConfig, AutoModel
from app import embeddings
from PIL import Image
from torchao.quantization import Int8Tensor

GROUP = int(os.getenv("TORCH8_TRIAL_GROUP", "64"))
FP32 = os.getenv("TORCH8_TRIAL_COMPUTE", "bf16") == "float32"
LABEL = os.getenv("TORCH8_TRIAL_LABEL", "torch-int8-trial")


class SelectedEmbedding(torch.nn.Module):
    """Keep Gemma's scale and dequantize selected token rows, not the vocabulary."""
    def __init__(self, original):
        super().__init__()
        self.weight = original.weight
        self.register_buffer("embed_scale", torch.tensor(original.scalar_embed_scale) if FP32 else original.embed_scale)
        self.embedding_dim = original.embedding_dim
        self.num_embeddings = original.num_embeddings
        self.padding_idx = original.padding_idx

    def forward(self, ids):
        rows = self.weight[ids.reshape(-1)].dequantize()
        return rows.reshape(*ids.shape, self.embedding_dim) * self.embed_scale.to(self.weight.dtype)


class TrialRuntime(embeddings.EmbeddingGemma2):
    def __init__(self, vision=False):
        config = AutoConfig.from_pretrained(embeddings.MODEL_ID, revision=embeddings.MODEL_REVISION)
        config.audio_config = None
        if not vision:
            config.vision_config = None
        self.model = AutoModel.from_pretrained(
            embeddings.MODEL_ID, revision=embeddings.MODEL_REVISION, config=config,
            torch_dtype=torch.bfloat16,
        ).eval()
        if FP32:
            # Quantize the large vocabulary in bounded rows; leave no dense float32 table.
            for module in self.model.language_model.modules():
                if not isinstance(module, (torch.nn.Linear, torch.nn.Embedding)):
                    continue
                source = module.weight.detach()
                rows, width = source.shape
                qdata = torch.empty((rows, width), dtype=torch.int8)
                scales = torch.empty((rows, width // GROUP), dtype=torch.float32)
                for start in range(0, rows, 2048):
                    part = Int8Tensor.from_hp(source[start:start+2048].float(), PerGroup(GROUP))
                    qdata[start:start+2048].copy_(part.qdata)
                    scales[start:start+2048].copy_(part.scale)
                module.weight = torch.nn.Parameter(Int8Tensor(qdata, scales, [1, GROUP], torch.float32), requires_grad=False)
            self.model.language_model.float()
        else:
            quantize_(self.model.language_model,
                      Int8WeightOnlyConfig(version=2, granularity=PerGroup(GROUP), set_inductor_config=False),
                      filter_fn=lambda module, name: isinstance(module, (torch.nn.Linear, torch.nn.Embedding)))
        self.model.language_model.embed_tokens = SelectedEmbedding(self.model.language_model.embed_tokens)
        self.model.to("mps")
        self.processor = embeddings.get_processor() if vision else embeddings.get_tokenizer()
        self.vision, self.device, self.dtype, self.dimension = vision, "mps", torch.bfloat16, 768


def run():
    corpus = json.loads((OUT.parent / "generated-quality-corpus.json").read_text())
    outputs = {}
    start = time.perf_counter()
    runtime = TrialRuntime()

    def encode(strings):
        return np.concatenate([runtime.encode(strings[i:i+4]) for i in range(0, len(strings), 4)])

    outputs["docs"] = encode([p["text"] for p in corpus["passages"]])
    outputs["queries"] = encode(["task: search result | query: " + c["question"] for c in corpus["cases"]])
    runtime.clear(); del runtime.model; runtime.clear(); del runtime; gc.collect()
    runtime = TrialRuntime(vision=True)
    outputs["photo_vectors"] = np.concatenate([
        runtime.encode([Image.open(OUT.parent / "real-photos" / f"{name}.png").convert("RGB")], images=True)
        for name in ["astronaut", "chelsea", "coffee", "camera", "rocket"]
    ])
    photo_questions = ["astronaut in a space suit", "חתול עם פרווה חומה", "cup of coffee on a saucer",
        "צלם מחזיק מצלמה", "rocket launch at night", "אסטרונאוט בחליפת חלל", "brown tabby cat",
        "כוס קפה על צלחת", "man taking a photograph with a camera", "שיגור טיל בלילה"]
    outputs["photo_queries"] = encode(["task: search result | query: " + q for q in photo_questions])
    runtime.clear(); del runtime.model; runtime.clear(); del runtime; gc.collect()
    baseline = dict(np.load(OUT.parent / "generated-quality-torch.npz"))

    def score(q, d):
        ranks = []
        for case, order in zip(corpus["cases"], np.argsort(-(q @ d.T), axis=1)):
            sources = list(dict.fromkeys(corpus["passages"][int(i)]["source"] for i in order))
            ranks.append(sources.index(case["source"]) + 1)
        return {"top1": sum(r == 1 for r in ranks), "top3": sum(r <= 3 for r in ranks), "ranks": ranks}

    report = {"runtime": f"torchao-0.17.0-int8-group{GROUP}/" + ("float32-text/bfloat16-vision" if FP32 else "bfloat16"), "seconds": time.perf_counter() - start,
              "baseline": score(baseline["queries"], baseline["docs"]),
              "rebuilt": score(outputs["queries"], outputs["docs"]),
              "queries_on_float32": score(outputs["queries"], baseline["docs"]),
              "query_min_cosine": float(np.sum(outputs["queries"] * baseline["queries"], axis=1).min()),
              "document_min_cosine": float(np.sum(outputs["docs"] * baseline["docs"], axis=1).min()),
              "photo_top1": int(np.sum(np.argmax(outputs["photo_queries"] @ outputs["photo_vectors"].T, axis=1) == np.arange(10) % 5)),
              "limitations": ["Generated regression labels, not independently reviewed production quality.",
                              "80 questions, 141 manually split guide passages, five real public photographs.",
                              "No live index access; this is a trial, not an active runtime change."]}
    np.savez(OUT / f"{LABEL}-vectors.npz", **outputs)
    (OUT / f"{LABEL}.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: ({a:b for a,b in v.items() if a != "ranks"} if isinstance(v,dict) else v) for k,v in report.items()}, indent=2))
    assert "mlx.core" not in sys.modules


if __name__ == "__main__":
    run()
