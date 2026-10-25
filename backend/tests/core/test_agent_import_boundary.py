"""Generic agent code must stay movable without Symbiknow dependencies."""

from pathlib import Path
import runpy

import pytest

ROOT = Path(__file__).resolve().parents[3]
check_source = runpy.run_path(str(ROOT / "scripts/checks/architecture.py"))["check_source"]
BRIDGE = "backend/symbiknow/api/agents/bridge/driver.py"


@pytest.mark.parametrize("source", [
    "import symbiknow.core.application as app",
    "from symbiknow.api.agents.bridge.driver import Event",
    "from ..symbiknow import tools",
    "from ....core import application",
    "from importlib import import_module as load; load('symbiknow.core.application')",
    "__import__('symbiknow')",
    "import importlib; importlib.import_module(module_name)",
])
def test_rejects_product_dependencies_and_opaque_imports(source):
    assert check_source(source, BRIDGE)


@pytest.mark.parametrize("source", [
    "from .driver import Event",
    "from . import sessions",
    "import asyncio\nfrom typing import Protocol",
    "from mcp import Client",
])
def test_allows_internal_and_external_dependencies(source):
    assert not check_source(source, BRIDGE)


def test_nested_bridge_modules_can_import_parent_inside_boundary():
    assert not check_source("from ..driver import Event", BRIDGE.replace("driver.py", "providers/claude.py"))


def test_glue_can_import_application_context():
    assert not check_source(
        "from symbiknow.core.application import ApplicationContext",
        "backend/symbiknow/api/agents/symbiknow.py",
    )
