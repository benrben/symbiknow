"""Native-PDF ingestion, actual-page preprocessing and natural-idle diagnosis.

Uses runtime.py's --source-root/--output options; --samples is the number of
counterbalanced resident-model trials. Run current then archived baseline only
in a reserved quiet window. This synthetic probe never accesses a live library.
Historical preprocessing is loaded from the recorded Git archive, not maintained
as another application implementation.
"""

import ast
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import tempfile
import time

import numpy as np

import runtime as b


def source_function(path, name, namespace=None):
    tree = ast.parse(path.read_text())
    function = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name)
    scope = dict(namespace or {})
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"), scope)
    return scope[name]


def inputs():
    # Reuse the exact maintained supplemental generators without executing a run.
    path = b.REPO / "benchmarks/supplemental.py"
    tree = ast.parse(path.read_text())
    text = next(node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "long_text" for target in node.targets))
    return eval(compile(ast.Expression(text), str(path), "eval")), source_function(path, "pdf_bytes")()


def state(owner):
    rss = subprocess.check_output(["/bin/ps", "-o", "rss=", "-p", str(os.getpid())], text=True)
    budgets = ({name: dict(entries=cache.max_entries, bytes=cache.max_bytes)
                for name, cache in [("query", owner.query_vectors), ("documents", owner.document_vectors)]}
               if hasattr(owner, "query_vectors") else {"supported": False})
    return dict(process_rss_bytes=int(rss.strip()) * 1024, model=owner.stats(), vector_budgets=budgets)


def run():
    if b.ARGS.reference_pair is None or b.ARGS.historical_source is None:
        b.parser.error("native_vision.py requires --reference-pair and --historical-source")
    reference_path = b.ARGS.reference_pair.resolve()
    baseline = b.ARGS.historical_source.resolve()
    if not (baseline / "backend/symbiknow/embeddings/runtime.py").is_file():
        b.parser.error("--historical-source must contain backend/symbiknow/embeddings/runtime.py")
    with tempfile.TemporaryDirectory(prefix="symbiknow-native-vision-") as temporary:
        root = Path(temporary)
        os.environ["SYMBIKNOW_DATA_DIR"] = str(root)
        from symbiknow.embeddings import runtime as embeddings
        from symbiknow.ingestion import service as ingest
        from symbiknow.library import storage
        import torch

        assert torch.backends.mps.is_available(), "GPU unavailable; do not substitute CPU timings"
        owner = embeddings.get_embedder()
        b.MODEL = owner
        b.report["scope"] = __doc__
        b.report["runtime"] = embeddings.descriptor()
        b.report["runner_sha256"]["benchmarks/native_vision.py"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        for obj, attr, label in [
            (ingest, "extract_units", "extract_and_chunk"),
            (ingest, "put_chunks", "index_write"),
            (embeddings.EmbeddingGemma2, "__init__", "model_load"),
            (embeddings.EmbeddingGemma2, "encode", "model_inference"),
            (embeddings.ModelManager, "embed_documents", "text_embedding"),
            (embeddings.ModelManager, "embed_images", "image_embedding"),
            (embeddings, "_features", "preprocessing"),
        ]:
            b.instrument(obj, attr, label)
        canonical = embeddings._features
        images = []
        try:
            long_text, pdf = inputs()
            b.report["inputs"] = {name: dict(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
                                  for name, content in [("large.txt", long_text), ("native-10-pages.pdf", pdf)]}
            expected = json.loads(reference_path.read_text())["inputs"]
            assert b.report["inputs"]["large.txt"]["sha256"] == expected["long_text_sha256"]
            assert b.report["inputs"]["native-10-pages.pdf"]["sha256"] == expected["native_pdf_sha256"]
            b.report["reference_pair_inputs_equal"] = True
            b.report["configuration"] = dict(reference_pair=str(reference_path), historical_source=str(baseline))
            b.measure("storage_initialize", lambda: storage.init_storage(root))
            b.measure("prelude_query", lambda: owner.embed_query("Harbor"))
            for name, content in [("large.txt", long_text), ("native-10-pages.pdf", pdf)]:
                meta = b.save_fixture(storage, root, content, name)
                result = b.measure("ingest_" + name, lambda: ingest.index_document(root, meta, content))
                assert result["status"] == "indexed", result

            # Default ingestion's heavy boundary already drops vision weights.
            # Observe the real text owner's idle timer, without forced cleanup.
            b.measure("query_before_natural_idle", lambda: owner.embed_query("Harbor native-page idle probe"))
            b.measure("documents_before_natural_idle", lambda: owner.embed_documents(
                ["Original native-page evidence."], "Native idle probe"))
            before = state(owner)
            started = time.perf_counter()
            print("START natural_idle", flush=True)
            while owner.stats()["loaded"] and time.perf_counter() - started < owner.timeout + 15:
                time.sleep(.25)
            after = state(owner)
            b.report["natural_idle"] = dict(before=before, after=after,
                                            elapsed_seconds=time.perf_counter() - started,
                                            configured_seconds=owner.timeout)
            if after["model"]["loaded"]:
                b.report["failures"].append(dict(label="natural_idle", error_type="WeightsStillLoaded"))
            b.flush()
            print("DONE natural_idle", flush=True)

            lock = {"_RUNTIME_LOCK": embeddings._RUNTIME_LOCK}
            functions = {
                "archived_flat": source_function(baseline / "backend/symbiknow/embeddings/runtime.py", "_features", lock),
                "current_nested": source_function(b.REPO / "backend/symbiknow/embeddings/runtime.py", "_features", lock),
            }
            b.report["preprocessing_sources"] = {
                name: hashlib.sha256(path.read_bytes()).hexdigest()
                for name, path in [("archived", baseline / "backend/symbiknow/embeddings/runtime.py"), ("current", b.REPO / "backend/symbiknow/embeddings/runtime.py")]
            }
            visual = ingest.VisualUnits(pdf)
            visual.pages = list(range(1, 11))
            images = [unit["image"].copy() for unit in visual]
            processor = embeddings.get_processor()
            parity = []
            for page, image in enumerate(images, 1):
                previous = functions["archived_flat"](processor, [image], True)
                current = functions["current_nested"](processor, [image], True)
                equal = set(previous) == set(current) and all(
                    previous[key].dtype == current[key].dtype and np.array_equal(previous[key], current[key])
                    for key in previous)
                parity.append(dict(page=page, image_size=list(image.size), exact=equal,
                                   fields={key: dict(shape=list(current[key].shape), dtype=str(current[key].dtype),
                                                     old_strides=list(previous[key].strides), new_strides=list(current[key].strides),
                                                     old_c_contiguous=bool(previous[key].flags.c_contiguous),
                                                     new_c_contiguous=bool(current[key].flags.c_contiguous),
                                                     sha256=hashlib.sha256(current[key].tobytes()).hexdigest())
                                           for key in current}))
                del previous, current
            b.report["native_page_preprocessing"] = parity
            if not all(row["exact"] for row in parity):
                b.report["failures"].append(dict(label="native_page_preprocessing", error_type="TensorMismatch"))

            # One selected backend owner/runtime remains resident while its processor
            # call changes. Timed groups exclude image rendering and tensor parity.
            b.measure("resident_vision_load", lambda: owner.embed_images(images[:1]))
            reference = None
            rng = random.Random(20261020)
            for trial in range(b.ARGS.samples):
                modes = list(functions)
                rng.shuffle(modes)
                for mode in modes:
                    embeddings._features = functions[mode]
                    b.instrument(embeddings, "_features", "preprocessing")
                    vectors = b.measure(f"resident_{mode}_{trial}", lambda: np.vstack(
                        [owner.embed_images([image]) for image in images]))
                    if reference is None:
                        reference = vectors
                    cosine = np.sum(vectors * reference, axis=1) / (
                        np.linalg.norm(vectors, axis=1) * np.linalg.norm(reference, axis=1))
                    row = b.report["runs"][-1]
                    row["min_cosine"] = float(np.min(cosine))
                    row["trial"] = trial
                    row["variant"] = mode
                    if row["min_cosine"] < .99999:
                        b.report["failures"].append(dict(label=row["label"], error_type="VectorMismatch"))
                    b.flush()
            b.report["resident_final"] = state(owner)
            b.report["completed"] = True
        finally:
            embeddings._features = canonical
            owner.unload(force=True)
            b.report["forced_cleanup"] = state(owner)
            for image in images:
                image.close()
            if (b.SOURCE / "backend/symbiknow/ingestion/conversion/manager.py").exists():
                from symbiknow.ingestion.conversion.manager import close_conversion_manager
                close_conversion_manager()
            b.flush()


if __name__ == "__main__":
    run()
