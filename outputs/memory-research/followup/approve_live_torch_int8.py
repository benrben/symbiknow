"""Explicit guarded precision approval + graceful restart for this workspace.

Run --check-gates first. Then pass the CURRENT verified server PID. The only
derived-index write is an atomic compatible-encoder receipt. OCFL originals and
the base float32 manifest stay unchanged. Failure restarts the float32 owner.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).parent
DATA = ROOT / "data"
LAUNCH_ENV = os.environ.copy()
os.environ.update(SYMBIKNOW_EMBEDDING_RUNTIME="torch", SYMBIKNOW_TORCH_QUANTIZATION="none",
                  SYMBIKNOW_EMBEDDING_DEVICE="mps", HF_HOME=str(DATA / "models"),
                  HF_HUB_OFFLINE="1", TYPESAFE_API_KEY="")
sys.path.insert(0, str(ROOT))
import numpy as np
from filelock import FileLock
from app import embeddings, search


def read(name):
    return json.loads((OUT / name).read_text())


def inventory():
    files = sorted((DATA / "files").rglob("inventory.json"))
    h = hashlib.sha256()
    for path in files:
        h.update(str(path.relative_to(DATA / "files")).encode() + b"\0" + path.read_bytes())
    return {"inventory_files": len(files), "aggregate_sha256": h.hexdigest()}


def request(route):
    with urllib.request.urlopen("http://127.0.0.1:8765" + route, timeout=30) as response:
        return json.load(response)


def prerequisite_proof():
    tests = read("full-tests-result.json")
    assert tests["exit_code"] == 0 and tests["passed"] >= 249, "Full test suite has not passed"
    baseline = read("production-guide-torch.json")["modes"]
    candidate = read("production-guide-torch-int8.json")
    assert candidate["quantization"] == "int8" and candidate["production_chunking"]
    losses = []
    for variant in (candidate["modes"], candidate["float32_queries_on_int8"]):
        for mode in ("semantic", "hybrid"):
            a = baseline[mode]["cases"]; b = variant[mode]["cases"]
            assert len(a) == len(b) == 80
            rank = lambda c: c["rank_in_five"] if c["rank_in_five"] is not None else 99
            losses.append((sum(rank(x) == 1 and rank(y) > 1 for x, y in zip(a, b)),
                           sum(rank(x) <= 3 and rank(y) > 3 for x, y in zip(a, b))))
    photos = read("torch-int8-production-adapter.json")
    image_compatibility = read("torch-int8-image-compatibility.json")
    assert image_compatibility["int8_query_float32_photos"] == image_compatibility["float32_query_int8_photos"] == 10
    assert image_compatibility["min_photo_cosine"] >= .995
    benchmark = read("server-int8-bench.json")
    assert benchmark["server_exit_code"] == 0 and benchmark["library_total"] == 7
    assert len(benchmark["workloads"]) == 7 and all(w["original_sha256_verified"] for w in benchmark["workloads"])
    idle = next(s for s in benchmark["stages"] if s["stage"] == "idle_66s")
    assert idle["runtime"]["model"]["loaded"] is False
    matched = read("server-int8-matched10-bench.json")
    assert matched["server_exit_code"] == 0 and matched["library_total"] == 5
    assert len(matched["workloads"]) == 5 and all(w["original_sha256_verified"] for w in matched["workloads"])
    assert read("torch-int8-real-pdf.json")["passed"]
    overlap = read("torch-int8-overlap.json")
    assert overlap["image_status"] == "indexed" and overlap["visual_search_has_photo"]
    cycles = read("torch-cycles-int8.json")
    settled = [s["physical_bytes"] for s in cycles["samples"] if s["stage"].endswith("text_idle")]
    assert len(settled) == 3 and abs(settled[2] - settled[1]) <= max(64 * 1024**2, settled[1] * .05)
    return {"production_expected_top1_losses": max(x for x, _ in losses),
            "production_expected_top3_losses": max(y for _, y in losses),
            "image_top1_correct": photos["photo_top1"], "image_total": 10,
            "resource_checks_passed": True, "original_byte_checks_passed": True,
            "validation_artifacts": {name: hashlib.sha256((OUT / name).read_bytes()).hexdigest() for name in (
                "full-tests-result.json", "production-guide-torch-int8.json", "torch-int8-production-adapter.json",
                "server-int8-bench.json", "server-int8-matched10-bench.json", "torch-int8-image-compatibility.json",
                "torch-int8-real-pdf.json", "torch-int8-overlap.json", "torch-cycles-int8.json")}}


def evaluate(precision, cases):
    os.environ["SYMBIKNOW_TORCH_QUANTIZATION"] = precision
    manager = embeddings.ModelManager(timeout=0)
    vectors = {}

    class Probe:
        # Explicit offline, read-only encoder validation while owning server.lock.
        # Application requests retain the normal manifest guard.
        model_id = embeddings.MODEL_ID

        def embed_query(self, query):
            if query not in vectors:
                vectors[query] = manager.embed_query(query)
            return vectors[query]

    proxy = Probe()
    result = {}
    manifest = DATA / "index/embedding-runtime.json"
    frozen = manifest.read_bytes()

    def verify_probe_index(directory):
        # Offline read-only encoder evaluation before approval. The application
        # keeps its strict guard; model ID must still match the vector filter.
        assert Path(directory).resolve() == DATA.resolve() and manifest.read_bytes() == frozen

    try:
        with patch.object(embeddings, "validate_index", verify_probe_index):
            for mode in ("semantic", "hybrid"):
                rows = []
                for c in cases:
                    matches = search.find_documents(DATA, c["question"], mode=mode, limit=5,
                                                    embedder=proxy, defer_links=True)
                    assert matches, "A compatibility query returned no matches"
                    filenames = [m["filename"] for m in matches]
                    rows.append({"first": matches[0]["document_id"],
                                 "top3": {m["document_id"] for m in matches[:3]},
                                 "rank": filenames.index(c["source"]) + 1 if c["source"] in filenames else 99})
                result[mode] = rows
    finally:
        manager.unload(force=True)
    return result, np.stack([vectors[c["question"]] for c in cases])


def configure(value):
    path = ROOT / ".env"
    lines = [line for line in path.read_text().splitlines() if not line.startswith("SYMBIKNOW_TORCH_QUANTIZATION=")]
    if value is not None:
        lines.append("SYMBIKNOW_TORCH_QUANTIZATION=" + value)
    # Preserve every other setting; never print or copy secrets to an artifact.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=ROOT, prefix=".env.precision-", delete=False) as f:
            temporary = Path(f.name)
            os.chmod(temporary, path.stat().st_mode & 0o777)
            f.write("\n".join(lines) + "\n"); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None: temporary.unlink(missing_ok=True)


def start_owner(precision):
    env = {**LAUNCH_ENV, "SYMBIKNOW_EMBEDDING_RUNTIME": "torch", "SYMBIKNOW_TORCH_QUANTIZATION": precision,
           "SYMBIKNOW_DATA_DIR": str(DATA), "HF_HOME": str(DATA / "models")}
    env.pop("PYTHONPATH", None)
    with (OUT.parent / "restarted-server.log").open("ab") as log:
        owner = subprocess.Popen([str(ROOT / ".venv/bin/python"), "-m", "app.server", "--web", "--port", "8765"],
                                 cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for _ in range(240):
            assert owner.poll() is None, "New owner exited; see restarted-server.log"
            try:
                runtime = request("/api/runtime")
                if runtime["pid"] == owner.pid and runtime["model"]["torch_quantization"] == precision:
                    return owner
            except (OSError, ValueError): pass
            time.sleep(.25)
        raise RuntimeError("New owner did not become ready")
    except BaseException:
        if owner.poll() is None:
            owner.send_signal(signal.SIGINT); owner.wait(timeout=90)
        raise


proof = prerequisite_proof()
if "--check-gates" in sys.argv:
    print(json.dumps({"prerequisites_passed": True, "proof": {k:v for k,v in proof.items() if k != "validation_artifacts"}}, indent=2))
    raise SystemExit(0)
old = int(sys.argv[1])
expected = str(ROOT / ".venv/bin/python") + " -m app.server --web --port 8765"
assert subprocess.check_output(["ps", "-p", str(old), "-o", "command="], text=True).strip() == expected
before = request("/api/library?limit=100")
assert not before["processing"] and before["library_total"] > 0
report = {"before_pid": old, "library_total": before["library_total"], "before_inventories": inventory()}
original_flag = next((line.split("=", 1)[1] for line in (ROOT / ".env").read_text().splitlines() if line.startswith("SYMBIKNOW_TORCH_QUANTIZATION=")), None)
passed = False
stopped = False
configured = False
try:
    os.kill(old, signal.SIGINT)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try: os.kill(old, 0)
        except ProcessLookupError: break
        time.sleep(.25)
    else: raise RuntimeError("Existing owner did not stop; no new owner started")
    stopped = True
    with FileLock(DATA / "server.lock", timeout=0):
        assert inventory() == report["before_inventories"], "Original inventories changed before validation"
        embeddings.validate_index(DATA)
        cases = read("../generated-quality-corpus.json")["cases"]
        base, base_vectors = evaluate("none", cases)
        candidate, candidate_vectors = evaluate("int8", cases)
        cosine = np.sum(base_vectors * candidate_vectors, axis=1)
        assert np.isfinite(cosine).all()
        agreements, overlaps, top1_losses, top3_losses = [], [], [], []
        for mode in ("semantic", "hybrid"):
            a, b = base[mode], candidate[mode]
            agreements.append(sum(x["first"] == y["first"] for x, y in zip(a,b)) / len(a))
            overlaps.append(float(np.mean([len(x["top3"] & y["top3"]) / len(x["top3"]) for x,y in zip(a,b)])))
            top1_losses.append(sum(x["rank"] == 1 and y["rank"] > 1 for x,y in zip(a,b)))
            top3_losses.append(sum(x["rank"] <= 3 and y["rank"] > 3 for x,y in zip(a,b)))
        proof.update(existing_index_queries=len(cases), minimum_query_cosine=float(cosine.min()),
                     existing_index_top1_agreement=min(agreements), existing_index_top3_overlap=min(overlaps),
                     existing_index_expected_top1_losses=max(top1_losses), existing_index_expected_top3_losses=max(top3_losses))
        assert inventory() == report["before_inventories"]
        report["validation"] = proof
        embeddings.record_validated_precision(DATA, proof)
        embeddings.validate_index(DATA)
        configure("int8")
        configured = True
        passed = True
        report["validation"] = proof
finally:
    if stopped:
        try:
            owner = start_owner("int8" if passed else "none")
        except BaseException:
            if configured: configure(original_flag)
            passed = False
            owner = start_owner("none")
        report["after_pid"] = owner.pid
    else:
        report["after_pid"] = old
    report["approved"] = passed
    report["after_inventories"] = inventory()
    (OUT / "live-int8-approval.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"approved": passed, "pid": report["after_pid"], "inventories_unchanged": report["before_inventories"] == report["after_inventories"]}), flush=True)
