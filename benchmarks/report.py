"""Write compact review evidence from isolated runner outputs, without raw passages.

Each input is NAME=PATH. Raw source hashes and result fingerprints are preserved;
large sample/evidence bodies stay in the original artifact referenced by SHA256.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import statistics
from pathlib import Path


OMIT = {"samples", "ordered_results", "matches", "cases", "raw_response", "responses", "document", "evidence", "attempts"}


def compact(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key == "samples" and isinstance(item, list) and item and isinstance(item[0], dict) and "projects" in item[0]:
                result[key] = [compact(row) for row in item]
            elif key in OMIT:
                encoded = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
                result[key + "_sha256"] = hashlib.sha256(encoded).hexdigest()
                if isinstance(item, (list, dict)):
                    result[key + "_count"] = len(item)
                if key == "samples" and isinstance(item, list):
                    metrics = [row["metrics"] for row in item if isinstance(row, dict) and isinstance(row.get("metrics"), dict)]
                    if metrics:
                        fields = {field for row in metrics for field, number in row.items()
                                  if isinstance(number, (int, float))}
                        result["sample_metrics_mean"] = {field: statistics.mean(row.get(field, 0) for row in metrics) for field in sorted(fields)}
                        result["sample_metrics_max"] = {field: max(row.get(field, 0) for row in metrics) for field in sorted(fields)}
            else:
                result[key] = compact(item)
        return result
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", nargs="+", help="Unique NAME=PATH runner outputs")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "artifacts": {}}
    for item in args.artifacts:
        name, separator, location = item.partition("=")
        if not separator or not name or name in report["artifacts"]:
            parser.error("Use distinct NAME=PATH arguments")
        path = Path(location)
        raw = path.read_bytes()
        value = json.loads(raw)
        report["artifacts"][name] = {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                                      "bytes": len(raw), "result": compact(value)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
