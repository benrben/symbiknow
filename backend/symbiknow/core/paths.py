"""Repository assets shared by the local application and developer launchers."""
from pathlib import Path

REPO_ROOT = next(
    (parent for parent in Path(__file__).resolve().parents
     if (parent / "pyproject.toml").is_file() and (parent / "backend/symbiknow").is_dir()),
    Path.cwd(),
)
