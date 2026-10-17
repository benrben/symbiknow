"""Real EmbeddingGemma 2 text/image and optional live Jev probes. No substitutes."""

import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
os.environ.setdefault("HF_HOME", str(Path("data/models").resolve()))

from PIL import Image  # noqa: E402
from app.embeddings import get_embedder  # noqa: E402
from app.jev import judge_matches  # noqa: E402

started = time.perf_counter()
embedder = get_embedder()
query = embedder.embed_query("What is the capital of France?")
document = embedder.embed_documents(["France's capital is Paris."], "France")[0]
image = embedder.embed_images([Image.new("RGB", (128, 128), "red")])[0]
visual_query = embedder.embed_query("a bright red square")
colors = embedder.embed_images([Image.new("RGB", (512, 512), color) for color in ("red", "blue")])
visual_scores = [sum(a * b for a, b in zip(visual_query, vector)) for vector in colors]
report = {
    "model": embedder.model_id,
    "dimension": len(query),
    "text_similarity": sum(a * b for a, b in zip(query, document)),
    "image_dimension": len(image),
    "elapsed_seconds": time.perf_counter() - started,
    "device": str(embedder.model.device),
}
report["native_visual_retrieval"] = {
    "red_score": visual_scores[0],
    "blue_score": visual_scores[1],
    "red_ranks_first": visual_scores[0] > visual_scores[1],
}
report["jev"] = judge_matches(
    "What is France's capital?",
    [
        {
            "document_id": "runtime-probe",
            "version": "v1",
            "evidence": [
                {
                    "evidence_id": "runtime-probe:v1:0",
                    "text": "France's capital is Paris.",
                    "basis": "text",
                }
            ],
        }
    ],
)
print(json.dumps(report, indent=2))
if report["jev"]["status"] != "evaluated":
    print("Live Jev check incomplete; set TYPESAFE_API_KEY in .env.", file=sys.stderr)
