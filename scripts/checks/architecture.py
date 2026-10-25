"""Reject domain bypasses and retired implementations, including aliased imports."""

import ast
from importlib.util import resolve_name
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PATH = "backend/symbiknow/api/agents/bridge/"
BRIDGE_MODULE = "symbiknow.api.agents.bridge"
INFRASTRUCTURE = {"backend/symbiknow/search/index.py", "backend/symbiknow/organization/store.py"}
TRANSPORTS = {"backend/symbiknow/api/mcp.py", "backend/symbiknow/api/http.py"}
RETIRED = {
    "_schedule",
    "_refresh_matches",
    "indexed_document",
    "_set_chunk_filters",
    "recover_organization_filters",
    "_judge_matches_legacy",
    "_organize_document_legacy",
    "route_answer",
    "_cross_document_disagreement",
    "_JUDGMENTS",
    "_DISAGREEMENTS",
}


def check_source(source, relative):
    tree = ast.parse(source)
    aliases = {}
    bridge = relative.startswith(BRIDGE_PATH)
    if (ROOT / "scripts/benchmark-review8.py").exists():
        raise SystemExit("Retired rebuild benchmark reintroduced; use benchmarks/rebuild.py")
    violations = []

    def fail(node, message):
        violations.append(f"{relative}:{node.lineno}: {message}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name.split(".")[0]] = (
                    alias.name if alias.asname else alias.name.split(".")[0]
                )
                if alias.name in {"symbiknow.api.mcp", "symbiknow.api.http"} and relative not in TRANSPORTS:
                    fail(node, "domain imports transport")
                if bridge and alias.name.split(".")[0] == "symbiknow":
                    fail(node, "generic bridge imports Symbiknow; use relative imports internally")
        elif isinstance(node, ast.ImportFrom):
            package = ".".join(Path(relative).parent.parts[1:])
            module = (resolve_name("." * node.level + (node.module or ""), package)
                      if node.level else (node.module or ""))
            if bridge and (
                (node.level and module != BRIDGE_MODULE and not module.startswith(BRIDGE_MODULE + "."))
                or (not node.level and module.split(".")[0] == "symbiknow")
            ):
                fail(node, "generic bridge imports outside its extraction boundary")
            for alias in node.names:
                target = module + "." + alias.name
                aliases[alias.asname or alias.name] = target
                if alias.name in RETIRED:
                    fail(node, "imports retired symbol " + alias.name)
                if relative not in TRANSPORTS and (
                    module in {"symbiknow.api.mcp", "symbiknow.api.http"} or target in {"symbiknow.api.mcp", "symbiknow.api.http"}
                ):
                    fail(node, "domain imports transport")

    def resolve(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return resolve(node.value) + "." + node.attr
        return ""

    for node in ast.walk(tree):
        name = None
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.Name):
            name = node.id
        elif isinstance(node, ast.Attribute):
            name = node.attr
        if name in RETIRED:
            fail(node, "retired symbol " + name)
        if isinstance(node, ast.Call):
            target = resolve(node.func)
            if bridge and target in {"importlib.import_module", "__import__"}:
                name = node.args[0] if node.args else None
                if not isinstance(name, ast.Constant) or not isinstance(name.value, str):
                    fail(node, "generic bridge has an unverifiable dynamic import")
                elif name.value.startswith(".") or name.value.split(".")[0] == "symbiknow":
                    fail(node, "generic bridge must use static relative imports internally")
            if target == "sqlite3.connect" and relative not in {
                "backend/symbiknow/library/storage.py", "backend/symbiknow/organization/edits.py",
                "backend/symbiknow/freshness/store.py", "backend/symbiknow/organization/readmodel.py",
                "backend/symbiknow/core/work.py",
                "backend/symbiknow/organization/receipts.py",
                "backend/symbiknow/organization/history.py", "backend/symbiknow/library/catalog.py",
                "backend/symbiknow/organization/corrections.py",
                "backend/symbiknow/organization/projects.py",
            }:
                fail(node, "opens database outside its declared owner")
            if relative not in INFRASTRUCTURE and (
                target == "lancedb.connect"
                or target.split(".")[-1] in {"open_table", "create_table", "drop_table"}
            ):
                fail(node, "opens derived database outside index infrastructure")
            if target.endswith(".from_pretrained") and relative != "backend/symbiknow/embeddings/runtime.py":
                fail(node, "loads model outside model owner")
            if relative in {"backend/symbiknow/search/service.py", "backend/symbiknow/core/application.py"} and target.endswith(
                ".current_version"
            ):
                fail(node, "scalar head validation in shared snapshot service")
            if (
                target in {"importlib.import_module", "__import__"}
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                if node.args[0].value in {"symbiknow.api.mcp", "symbiknow.api.http"} and relative not in TRANSPORTS:
                    fail(node, "domain dynamically imports transport")
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in {"rocfl", "symbiknow-ocfl-reader"} and relative != "backend/symbiknow/library/storage.py":
                fail(node, "invokes originals backend outside storage owner")
    return violations


def main():
    for retired_path in ("app", "client.py"):
        if (ROOT / retired_path).exists():
            raise SystemExit(f"Retired package path reintroduced: {retired_path}")
    if (ROOT / "scripts/benchmark-review8.py").exists():
        raise SystemExit("Retired rebuild benchmark reintroduced; use benchmarks/rebuild.py")
    sources = sorted((ROOT / "backend/symbiknow").rglob("*.py"))
    if not sources:
        raise SystemExit("Backend package is missing")
    violations = [
        violation
        for path in sources
        for violation in check_source(path.read_text(), str(path.relative_to(ROOT)))
    ]
    if violations:
        raise SystemExit("\n".join(violations))
    core = ROOT / "frontend/src/features/assistant/core"
    if core.exists():
        subprocess.run(["node", str(ROOT / "scripts/checks/assistant-imports.mjs")], check=True)
    print("Architecture ownership and retirement checks passed")


if __name__ == "__main__":
    main()
