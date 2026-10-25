"""Pinned EmbeddingGemma runtimes owned by one serialized, idle-expiring manager."""

from __future__ import annotations

import gc
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import sys
import threading
import time
from functools import lru_cache

import numpy as np

from symbiknow.embeddings.scheduling import ModelTurns
from symbiknow.core.cache import ByteLRU, CoalescingCache, dependency_key, reuse_success
from symbiknow.search.metrics import add

MODEL_ID = "google/embeddinggemma-2"
MODEL_REVISION = "2c791de4ddbe5cabd592cc93692f7acb67e52555"
MLX_VLM_REVISION = "3d87e88402f307efbf68e568971aa887ee7d9ed0"
TORCHAO_VERSION = "0.17.0"
TORCH_INT8_GROUP = 16
# Padded tokens per torch forward pass; indexing sends four 512-token chunks.
TOKEN_BUDGET = 4096
_RUNTIME_LOCK = threading.RLock()


class EmbeddingUnavailable(RuntimeError):
    pass


def runtime_name():
    if os.getenv("SYMBIKNOW_EMBEDDING_REVISION", MODEL_REVISION) != MODEL_REVISION:
        raise EmbeddingUnavailable("This release pins EmbeddingGemma revision " + MODEL_REVISION)
    requested = os.getenv("SYMBIKNOW_EMBEDDING_RUNTIME", "auto")
    if requested == "auto":
        # Normal searches use the regular PyTorch runtime, including on Apple Silicon.
        return "torch"
    if requested not in {"torch", "mlx"}:
        raise EmbeddingUnavailable("SYMBIKNOW_EMBEDDING_RUNTIME must be auto, torch or mlx")
    if requested == "mlx" and (platform.system() != "Darwin" or platform.machine() != "arm64"):
        raise EmbeddingUnavailable("MLX requires Apple Silicon macOS; select torch on CPU/CUDA")
    return requested


def torch_quantization():
    requested = os.getenv("SYMBIKNOW_TORCH_QUANTIZATION", "none")
    if requested not in {"none", "int8"}:
        raise EmbeddingUnavailable("SYMBIKNOW_TORCH_QUANTIZATION must be none or int8")
    return requested


def descriptor():
    return {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "runtime": runtime_name(),
        "torch_version": importlib.metadata.version("torch"),
        "transformers_version": importlib.metadata.version("transformers"),
        "quantization": "affine-8-group64-text/bfloat16-vision"
        if runtime_name() == "mlx"
        else (
            f"torchao-{TORCHAO_VERSION}-int8-group{TORCH_INT8_GROUP}/float32-text/bfloat16-vision"
            if torch_quantization() == "int8"
            else "float32-or-cuda-bfloat16"
        ),
        "dimensions": int(os.getenv("SYMBIKNOW_EMBEDDING_DIMENSION", "768")),
        "query_prefix": "task: search result | query: ",
        "document_prefix": "title: {title} | text: {text}",
        "pooling": "masked-mean",
        "normalize": True,
        "audio": False,
        "max_tokens": 2048,
        "mlx": "0.32.3",
        "mlx_vlm": MLX_VLM_REVISION,
    }


def _approved_precision(base, requested, approval):
    """An explicit measured approval, never automatic legacy-index adoption."""
    try:
        def comparable(d):
            return {k: v for k, v in d.items() if k != "quantization"}

        proof = approval["validation"]
        return (
            approval["format"] == 1
            and approval["base"] == base
            and approval["compatible"] == requested
            and base["runtime"] == requested["runtime"] == "torch"
            and base["quantization"] == "float32-or-cuda-bfloat16"
            and requested["quantization"]
            == f"torchao-{TORCHAO_VERSION}-int8-group{TORCH_INT8_GROUP}/float32-text/bfloat16-vision"
            and comparable(base) == comparable(requested)
            and proof["existing_index_queries"] >= 80
            and 0.995 <= proof["minimum_query_cosine"] <= 1.0001
            and 0.95 <= proof["existing_index_top1_agreement"] <= 1
            and 0.95 <= proof["existing_index_top3_overlap"] <= 1
            and 0 <= proof["existing_index_expected_top1_losses"] <= 1
            and proof["existing_index_expected_top3_losses"] == 0
            and 0 <= proof["production_expected_top1_losses"] <= 1
            and proof["production_expected_top3_losses"] == 0
            and proof["image_top1_correct"] == proof["image_total"] >= 10
            and proof["resource_checks_passed"] is True
            and proof["original_byte_checks_passed"] is True
        )
    except (KeyError, TypeError, ValueError):
        return False


def record_validated_precision(data_dir, proof):
    """Caller must own server.lock; publish approval before changing configuration.

    Keep the base manifest: original float32 vectors and the supported unquantized
    fallback remain explicit. This one atomic receipt adds a compatible encoder.
    """
    from symbiknow.organization.edits import atomic
    from symbiknow.search.index import INDEX_LOCK

    with INDEX_LOCK:
        path = Path(data_dir) / "index/embedding-runtime.json"
        base, requested = json.loads(path.read_text()), descriptor()
        approval = {"format": 1, "base": base, "compatible": requested, "validation": proof}
        if not _approved_precision(base, requested, approval):
            raise EmbeddingUnavailable("Precision compatibility validation has not passed")
        atomic(path.with_name("embedding-runtime-compatibility.json"), approval)


def validate_index(data_dir):
    """Never silently mix quantization, preprocessing, revision or dimensions."""
    from symbiknow.organization.edits import atomic
    from symbiknow.search.index import INDEX_LOCK, _table

    with INDEX_LOCK:
        path = Path(data_dir) / "index" / "embedding-runtime.json"
        requested = descriptor()
        if path.exists():
            recorded = json.loads(path.read_text())
            if recorded != requested:
                approval_path = path.with_name("embedding-runtime-compatibility.json")
                try:
                    approval = (
                        json.loads(approval_path.read_text())
                        if approval_path.stat().st_size <= 131072
                        else {}
                    )
                except (OSError, ValueError):
                    approval = {}
                if _approved_precision(recorded, requested, approval):
                    return
                raise EmbeddingUnavailable(
                    "Embedding runtime differs from the index manifest. Rebuild the derived index in an isolated directory and validate retrieval before migration. Originals are unchanged."
                )
        else:
            chunks = _table(data_dir, "chunks")
            if chunks is not None and chunks.count_rows() and (
                requested["runtime"] != "torch" or torch_quantization() != "none"
            ):
                raise EmbeddingUnavailable(
                    "Legacy index has no compatibility record. Validate/rebuild it before changing precision; "
                    "use unquantized torch for existing float32 vectors."
                )
            atomic(path, requested)


def get_tokenizer():
    with _RUNTIME_LOCK:
        return _tokenizer()


@lru_cache(maxsize=1)
def _tokenizer():
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)


def get_processor():
    with _RUNTIME_LOCK:
        return _processor()


@lru_cache(maxsize=1)
def _processor():
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    processor.tokenizer = get_tokenizer()
    return processor


def _features(processor, items, images=False):
    # HF fast-tokenizer truncation/padding configuration is mutable. Chunking
    # shares the tokenizer, so serialize preprocessing independently of weights.
    with _RUNTIME_LOCK:
        return processor(
            **(
                {"images": [[item] for item in items], "padding": True}
                if images
                else {"text": items, "padding": True, "truncation": True, "max_length": 2048}
            ),
            return_tensors="np",
        )


def _token_groups(items, budget=TOKEN_BUDGET):
    """Split text so one padded forward pass stays within the token budget."""
    if len(items) < 2:
        return [items]
    with _RUNTIME_LOCK:
        lengths = [len(ids) for ids in get_tokenizer()(list(items), truncation=True, max_length=2048)["input_ids"]]
    groups, start, longest = [], 0, 0
    for index, length in enumerate(lengths):
        longest = max(longest, length)
        if index > start and longest * (index - start + 1) > budget:
            groups.append(items[start:index])
            start, longest = index, length
    groups.append(items[start:])
    return groups


def _valid(vectors, dimension):
    result = np.asarray(vectors, dtype=np.float32)
    if result.ndim != 2 or result.shape[1] != dimension or not np.isfinite(result).all():
        raise EmbeddingUnavailable("EmbeddingGemma 2 returned invalid embeddings")
    return result


class EmbeddingGemma2:
    model_id = MODEL_ID

    def __init__(self, vision=False):
        import torch
        from transformers import AutoConfig, AutoModel

        device = os.getenv("SYMBIKNOW_EMBEDDING_DEVICE", "auto")
        if device == "auto":
            device = (
                "cuda"
                if torch.cuda.is_available()
                else ("mps" if torch.backends.mps.is_available() else "cpu")
            )
        quantized = torch_quantization() == "int8"
        if quantized and (device != "mps" or not torch.backends.mps.is_available()):
            raise EmbeddingUnavailable(
                "INT8 embeddings currently require tested Apple Silicon MPS. "
                "Set SYMBIKNOW_TORCH_QUANTIZATION=none for the supported CPU/CUDA fallback."
            )
        if quantized:
            try:
                installed = importlib.metadata.version("torchao")
            except importlib.metadata.PackageNotFoundError:
                installed = None
            if installed != TORCHAO_VERSION:
                raise EmbeddingUnavailable(
                    f"INT8 embeddings require torchao=={TORCHAO_VERSION}; sync the locked environment "
                    "or set SYMBIKNOW_TORCH_QUANTIZATION=none before loading weights."
                )
        dtype = (
            torch.bfloat16
            if quantized or (device.startswith("cuda") and torch.cuda.is_bf16_supported())
            else torch.float32
        )
        self.dimension = int(os.getenv("SYMBIKNOW_EMBEDDING_DIMENSION", "768"))
        if self.dimension not in (128, 256, 512, 768):
            raise EmbeddingUnavailable("Embedding dimension must be 128, 256, 512 or 768")
        config = AutoConfig.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
        config.audio_config = None
        if not vision:
            config.vision_config = None
        self.model = AutoModel.from_pretrained(
            MODEL_ID, revision=MODEL_REVISION, config=config, torch_dtype=dtype
        )
        if quantized:
            from symbiknow.embeddings.quantization import quantize_text

            quantize_text(self.model)
        self.model.to(device).eval()
        self.processor = get_processor() if vision else get_tokenizer()
        self.vision = vision
        self.device, self.dtype = device, dtype

    def encode(self, items, images=False):
        groups = [items] if images else _token_groups(items)
        if len(groups) > 1:
            return np.concatenate([self._encode(group) for group in groups])
        return self._encode(items, images)

    def _encode(self, items, images=False):
        import torch

        features = _features(self.processor, items, images)
        with torch.inference_mode():
            inputs = {k: torch.from_numpy(v).to(self.device) for k, v in features.items()}
            if "pixel_values" in inputs:
                inputs["pixel_values"] = inputs["pixel_values"].to(self.dtype)
            hidden = self.model(**inputs).last_hidden_state.float()
            mask = inputs["attention_mask"].unsqueeze(-1)
            vectors = ((hidden * mask).sum(1) / mask.sum(1).clamp(min=1))[:, : self.dimension]
            vectors = torch.nn.functional.normalize(vectors, dim=-1).cpu().numpy()
        return _valid(vectors, self.dimension)

    def clear(self):
        import torch

        if torch.backends.mps.is_available():
            torch.mps.synchronize()
            torch.mps.empty_cache()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()


class MLXEmbeddingGemma2:
    """Uses the same HF processor and pinned MLX encoder as the controlled probes."""

    def __init__(self, vision=False):
        import mlx.core as mx
        from mlx_vlm.embedding_loader import load_embedding_model

        if importlib.metadata.version("mlx") != "0.32.3":
            raise EmbeddingUnavailable("MLX 0.32.3 is required")
        origin = json.loads(
            importlib.metadata.distribution("mlx-vlm").read_text("direct_url.json") or "{}"
        )
        if origin.get("vcs_info", {}).get("commit_id") != MLX_VLM_REVISION:
            raise EmbeddingUnavailable(f"Install mlx-vlm at {MLX_VLM_REVISION}")
        path = Path(os.environ.get("SYMBIKNOW_MLX_MODEL", ""))
        record = json.loads((path / "conversion.json").read_text())
        if any(
            record.get(k) != v
            for k, v in {
                "source_revision": MODEL_REVISION,
                "bits": 8,
                "group_size": 64,
                "audio": False,
                "vision_precision": "bfloat16",
            }.items()
        ):
            raise EmbeddingUnavailable("MLX conversion does not match the pinned 8-bit checkpoint")
        config = json.loads((path / "config.json").read_text())
        if config.get("quantization") != {"group_size": 64, "bits": 8, "mode": "affine"}:
            raise EmbeddingUnavailable("MLX quantization configuration changed")
        if not record.get("weights_sha256"):
            raise EmbeddingUnavailable(
                "Conversion has no weight integrity record; run scripts/setup/prepare_mlx.py"
            )
        from symbiknow.library.storage import _digest_path

        if _digest_path(path / "model.safetensors") != record["weights_sha256"]:
            raise EmbeddingUnavailable("MLX converted weight checksum mismatch")
        if not vision:
            config["vision_config"] = None
        config["audio_config"] = None
        self.model = load_embedding_model(path, config=config)
        self.processor = get_processor() if vision else get_tokenizer()
        self.dimension = int(os.getenv("SYMBIKNOW_EMBEDDING_DIMENSION", "768"))
        if self.dimension not in (128, 256, 512, 768):
            raise EmbeddingUnavailable("Invalid embedding dimension")
        self.vision = vision
        # No speculative tight cache budget: configurable for controlled measurements.
        if os.getenv("SYMBIKNOW_MLX_CACHE_MIB"):
            mx.set_cache_limit(int(os.environ["SYMBIKNOW_MLX_CACHE_MIB"]) * 2**20)

    def encode(self, items, images=False):
        import mlx.core as mx

        features = _features(self.processor, items, images)
        inputs = {k: mx.array(v) for k, v in features.items()}
        if "pixel_values" in inputs:
            inputs["pixel_values"] = inputs["pixel_values"].astype(mx.bfloat16)
        output = self.model(**inputs).text_embeds[:, : self.dimension].astype(mx.float32)
        output = output / mx.maximum(mx.linalg.norm(output, axis=-1, keepdims=True), 1e-12)
        mx.eval(output)
        return _valid(np.array(output), self.dimension)

    def clear(self):
        import mlx.core as mx

        mx.synchronize()
        mx.clear_cache()


class ModelManager:
    """Only this owner holds weights. The lock covers load, inference and unload.

    Callers retain a lightweight facade, never an unleased model reference. Vision
    replaces text under the same lock, then exits at the heavy-job boundary.
    """

    model_id = MODEL_ID

    def __init__(self, factory=None, timeout=None):
        self.lock = threading.RLock()
        self.turns = ModelTurns()
        self.cache_lock = threading.RLock()
        self.query_vectors = ByteLRU(max_entries=128, max_bytes=1024**2)
        self.document_vectors = ByteLRU(max_entries=64, max_bytes=8 * 1024**2)
        self.query_flights = CoalescingCache(max_entries=0, max_bytes=0, max_inflight=32)
        self.document_flights = CoalescingCache(max_entries=0, max_bytes=0, max_inflight=32)
        self.cache_epoch = 0
        # One immutable identity assignment permits a cache hit while an unrelated
        # inference holds the model lock. None means no weights are resident.
        self._runtime_identity = None
        self.runtime = None
        self.timer = None
        self.last_used = 0.0
        self.loads = 0
        self.factory = factory
        self.timeout = (
            float(os.getenv("SYMBIKNOW_MODEL_IDLE_SECONDS", "0")) if timeout is None else timeout
        )

    @property
    def tokenizer(self):
        return get_tokenizer()

    @property
    def chunk_tokenizer(self):
        return _chunk_tokenizer()

    def _unload(self):
        if self.runtime is not None:
            runtime = self.runtime
            runtime.clear()
            self.runtime = None
            self._runtime_identity = None
            # Drop weights BEFORE allocator collection.
            del runtime.model
            gc.collect()
            runtime.clear()
            del runtime

    def unload(self, force=False):
        # Maintenance joins the background lane so it cannot overtake queued
        # queries and force an avoidable model reload between their inferences.
        with self.turns.turn(), self.lock:
            if force or time.monotonic() - self.last_used >= self.timeout:
                self._unload()
                if force:
                    self._clear_vectors()
                if self.timer:
                    self.timer.cancel()
                    self.timer = None

    def _configuration(self):
        return dict(descriptor(), device_requested=os.getenv("SYMBIKNOW_EMBEDDING_DEVICE", "auto"),
                    factory=id(self.factory) if self.factory is not None else "configured-runtime")

    def _clear_vectors(self):
        with self.cache_lock:
            self.cache_epoch += 1
            self.query_vectors.clear()
            self.document_vectors.clear()

    def _encode(self, items, vision=False, *, interactive=False, with_identity=False):
        from symbiknow.embeddings.scheduling import BACKGROUND_WORK

        with self.turns.turn(interactive=interactive and not BACKGROUND_WORK.get()), self.lock:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            try:
                configuration = self._configuration()
                if self._runtime_identity and self._runtime_identity[0] != configuration:
                    self._unload()
                if self.runtime is not None and vision and not self.runtime.vision:
                    self._unload()
                if self.runtime is None:
                    factory = self.factory or (
                        MLXEmbeddingGemma2 if runtime_name() == "mlx" else EmbeddingGemma2
                    )
                    self.runtime = factory(vision=vision)
                    self._runtime_identity = (configuration, bool(self.runtime.vision))
                    self.loads += 1
                vectors = np.asarray(self.runtime.encode(items, images=vision), dtype=np.float32)
                if vectors.ndim != 2 or vectors.shape[1] < 1 or len(vectors) != len(items):
                    raise EmbeddingUnavailable("EmbeddingGemma returned a different vector count than its inputs")
                if not np.isfinite(vectors).all():
                    raise EmbeddingUnavailable("EmbeddingGemma returned nonfinite vectors")
                return (vectors, self._runtime_identity) if with_identity else vectors
            except EmbeddingUnavailable:
                raise
            except Exception as exc:
                raise EmbeddingUnavailable(
                    f"{runtime_name()} EmbeddingGemma failed: {exc}. No second fallback model was loaded; select torch explicitly if needed."
                ) from exc
            finally:
                self.last_used = time.monotonic()
                if self.timeout > 0:
                    self.timer = threading.Timer(self.timeout, self.unload)
                    self.timer.daemon = True
                    self.timer.start()

    def _cached_text(self, items, *, interactive=False):
        # No document/evidence/library identity enters these normalized vectors.
        # Inputs already include the exact title/query preprocessing prefix.
        inputs = tuple(items)
        configuration = self._configuration()
        identity = self._runtime_identity
        effective_vision = bool(identity and identity[0] == configuration and identity[1])
        cache = self.query_vectors if interactive else self.document_vectors
        flights = self.query_flights if interactive else self.document_flights
        namespace = "query-vectors" if interactive else "document-vectors"
        with self.cache_lock:
            epoch = self.cache_epoch

        def key_for(actual_identity):
            return dependency_key(namespace, inputs=inputs, runtime=actual_identity[0],
                                  effective_mode="vision-weights" if actual_identity[1] else "text-weights",
                                  epoch=epoch)

        key = key_for((configuration, effective_vision))

        def compute():
            vectors, actual_identity = self._encode(list(inputs), interactive=interactive,
                                                     with_identity=True)
            actual_key = key_for(actual_identity)
            # Own the array's bytes; views into Torch allocations must not bypass
            # accounting or keep a tensor/model allocation alive through a cache.
            return dict(key=actual_key, vectors=np.array(vectors, copy=True))

        payload, hit = reuse_success(
            cache, key, compute, lock=self.cache_lock, flights=flights,
            successful=lambda value: self.cache_epoch == epoch,
            publication_key=lambda value: value["key"],
        )
        # If a queued vision conversion changed the active precision before this
        # inference, compute published only its ACTUAL identity, never the guessed key.
        add("embedding_cache_hits" if hit else "embedding_cache_misses", 1)
        return np.array(payload["vectors"], copy=True)

    def embed_documents(self, texts, title="none"):
        return self._cached_text([f"title: {title or 'none'} | text: {text}" for text in texts])

    def embed_query(self, query):
        return self._cached_text([f"task: search result | query: {query}"], interactive=True)[0]

    def embed_images(self, images):
        return self._encode(images, vision=True)

    def job_boundary(self):
        with self.lock:
            if self.runtime:
                if self.runtime.vision and (self.timeout > 0 or os.environ.get("SYMBIKNOW_RELEASE_MODELS_AFTER_JOB") == "1"):
                    self._unload()
                    self._clear_vectors()
                    if self.timer:
                        self.timer.cancel()
                        self.timer = None
                else:
                    self.runtime.clear()

    def conversion_boundary(self):
        # Keep interactive weights warm by default. Memory-constrained installs
        # can opt into releasing them at conversion/job boundaries.
        if self.timeout > 0 or os.environ.get("SYMBIKNOW_RELEASE_MODELS_AFTER_JOB") == "1":
            self.unload(force=True)

    def _vector_cache_stats(self):
        with self.cache_lock:
            return dict(query=self.query_vectors.stats(), documents=self.document_vectors.stats(),
                        query_inflight=self.query_flights.stats(),
                        documents_inflight=self.document_flights.stats(), epoch=self.cache_epoch)

    def stats(self):
        with self.lock:
            result = {
                "loaded": self.runtime is not None,
                "vision": bool(self.runtime and self.runtime.vision),
                "loads": self.loads,
                "queue": self.turns.stats(),
                "vector_caches": self._vector_cache_stats(),
                "idle_seconds": self.timeout,
                "torch_quantization": torch_quantization(),
            }
            # Observe already initialized allocators without importing/loading a model.
            mx = sys.modules.get("mlx.core")
            if mx is not None:
                result["mlx"] = {
                    "active_bytes": mx.get_active_memory(),
                    "cache_bytes": mx.get_cache_memory(),
                    "peak_bytes": mx.get_peak_memory(),
                }
            torch = sys.modules.get("torch")
            if torch is not None:
                if torch.backends.mps.is_available():
                    result["mps"] = {
                        "active_bytes": torch.mps.current_allocated_memory(),
                        "driver_bytes": torch.mps.driver_allocated_memory(),
                    }
                if torch.cuda.is_initialized():
                    result["cuda"] = {
                        "active_bytes": torch.cuda.memory_allocated(),
                        "reserved_bytes": torch.cuda.memory_reserved(),
                    }
            return result


@lru_cache(maxsize=1)
def _chunk_tokenizer():
    from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer

    class ChunkTokenizer(BaseTokenizer):
        def count_tokens(self, text):
            with _RUNTIME_LOCK:
                return len(get_tokenizer().encode(text, add_special_tokens=False))

        def get_max_tokens(self):
            return 512

        def get_tokenizer(self):
            return get_tokenizer()

    return ChunkTokenizer()


_MANAGER = ModelManager()


def get_embedder():
    return _MANAGER


def unload_idle(force=False):
    _MANAGER.unload(force=force)
