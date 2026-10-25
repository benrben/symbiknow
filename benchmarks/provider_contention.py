"""Hosted Jev contention: does background provider load delay interactive answers?

Production runs every answer check on one ``ask`` job thread, while at most
three background callers use Jev (one ingest organization and two freshness
comparisons). This probe keeps N background threads issuing judgments and
times one sequential foreground thread on the same four shared provider slots.
Above the slot count, waiting callers queue in arrival order.
Background requests are frozen hosted-quality judgments of similar size, not
literal organization prompts. Never reads the live document library; no
judgment cache namespace is used, so every judgment reaches the provider.
"""

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import statistics
import sys
import threading
import time

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "benchmarks/fixtures/hosted-quality.json"


def percentile(values, q):
    ordered = sorted(values)
    return ordered[math.ceil(q * len(ordered)) - 1] if ordered else None


def scenario(jev, cases, background, foreground_rounds):
    from symbiknow.search.metrics import CURRENT

    done = threading.Event()
    lock = threading.Lock()
    load = {"judgments": 0, "failures": 0, "slot_wait_seconds": 0.0}

    def background_worker(offset):
        metrics = {}
        CURRENT.set(metrics)
        index = offset
        while not done.is_set():
            case = cases[index % len(cases)]
            index += 1
            result = jev.judge_matches(case["query"], case["matches"], cache_namespace=None)
            with lock:
                load["judgments"] += 1
                load["failures"] += result.get("status") == "unavailable"
        with lock:
            load["slot_wait_seconds"] += metrics.get("provider_slot_wait_seconds", 0.0)

    threads = [threading.Thread(target=background_worker, args=(i * 3,), daemon=True)
               for i in range(background)]
    for thread in threads:
        thread.start()
    time.sleep(1 if background else 0)  # Let the background load reach steady state.
    samples = []
    for _ in range(foreground_rounds):
        for case in cases:
            metrics = {}
            token = CURRENT.set(metrics)
            start = time.perf_counter()
            try:
                result = jev.judge_matches(case["query"], case["matches"], cache_namespace=None)
            finally:
                CURRENT.reset(token)
            samples.append(dict(case=case["id"], seconds=time.perf_counter() - start,
                                unavailable=result.get("status") == "unavailable",
                                slot_wait_seconds=metrics.get("provider_slot_wait_seconds", 0.0),
                                provider_seconds=metrics.get("provider_seconds", 0.0),
                                provider_calls=metrics.get("provider_calls", 0)))
    done.set()
    for thread in threads:
        thread.join(timeout=60)
    seconds = [s["seconds"] for s in samples if not s["unavailable"]]
    waits = [s["slot_wait_seconds"] for s in samples]
    return {"background_threads": background, "foreground_judgments": len(samples),
            "foreground_unavailable": sum(s["unavailable"] for s in samples),
            "foreground_p50_seconds": statistics.median(seconds) if seconds else None,
            "foreground_p95_seconds": percentile(seconds, .95),
            "foreground_slot_wait_total_seconds": sum(waits),
            "foreground_slot_wait_max_seconds": max(waits) if waits else None,
            "foreground_provider_calls": sum(s["provider_calls"] for s in samples),
            "background": load, "samples": samples}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--background", type=int, nargs="+", default=[0, 3, 6])
    parser.add_argument("--rounds", type=int, default=2, help="Foreground passes over every case")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(REPO / ".env")
    sys.path.insert(0, str(REPO / "backend"))
    from symbiknow.ai import jev

    cases = json.loads(args.fixture.read_text())["cases"]
    report = {"started_utc": datetime.now(timezone.utc).isoformat(),
              "provider_slots": jev._PROVIDER_SLOTS.count,
              "fixture": str(args.fixture.relative_to(REPO)), "scenarios": []}
    for background in args.background:
        result = scenario(jev, cases, background, args.rounds)
        report["scenarios"].append(result)
        print(json.dumps({k: v for k, v in result.items() if k != "samples"}), flush=True)
    report["completed_utc"] = datetime.now(timezone.utc).isoformat()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
