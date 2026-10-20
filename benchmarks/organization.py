from pathlib import Path
import subprocess
import sys
import time
import json
import argparse
import pstats

root = Path(__file__).resolve().parents[1]

parser = argparse.ArgumentParser(
    description="Organization candidate preparation only, plus mocked-provider rebuild contention"
)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
runs = []
for count, projects in [(1000, 0), (10000, 0), (100000, 0), (100000, 100000)]:
    name = f"organization-{count}-{projects}"
    print("START " + name, flush=True)
    start = time.perf_counter()
    command = [
        sys.executable,
        "benchmarks/probes/organization.py",
        "--documents",
        str(count),
        "--projects",
        str(projects),
        "--output",
        str(out / (name + ".json")),
    ]
    with (out / (name + ".log")).open("w") as log:
        result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
    runs.append(
        {
            "name": name,
            "returncode": result.returncode,
            "process_wall_seconds": time.perf_counter() - start,
        }
    )
    print("DONE " + name + " " + str(runs[-1]), flush=True)
# A separately profiled 10k run is diagnostic only, not a benchmark sample.
subprocess.run(
    [
        sys.executable,
        "-m",
        "cProfile",
        "-o",
        str(out / "organization.prof"),
        "benchmarks/probes/organization.py",
        "--documents",
        "10000",
    ],
    cwd=root,
    stdout=subprocess.DEVNULL,
    check=True,
)

with (out / "organization-profile.txt").open("w") as stream:
    pstats.Stats(str(out / "organization.prof"), stream=stream).strip_dirs().sort_stats(
        "cumulative"
    ).print_stats(40)
print("START rebuild", flush=True)
start = time.perf_counter()
with (out / "rebuild.log").open("w") as log:
    result = subprocess.run(
        [
            sys.executable,
            str(root / "benchmarks/rebuild.py"),
            "--output",
            str(out / "rebuild.json"),
        ],
        cwd=root,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
runs.append(
    {
        "name": "rebuild",
        "returncode": result.returncode,
        "process_wall_seconds": time.perf_counter() - start,
    }
)
(out / "remaining-status.json").write_text(json.dumps(runs, indent=2))
print("DONE " + str(runs[-1]), flush=True)
