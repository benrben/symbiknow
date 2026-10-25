import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  checkSource,
  core,
} from "../../../scripts/checks/assistant-imports.mjs";

const file = path.join(core, "events.tsx");
test("generic assistant rejects product imports across syntax forms", () => {
  for (const source of [
    'import { api } from "../../../shared/api/client";',
    'export { api } from "../../../shared/api/client";',
    'type Result = import("../../../shared/api/client").Doc;',
    'const module = import("../cards/search");',
    'const module = require("../cards/search");',
    'import adapter = require("../cards/search");',
    "import(moduleName);",
  ])
    assert.ok(checkSource(source, file).length, source);
});
test("generic assistant resolves aliases to product modules", () => {
  assert.ok(
    checkSource('import { api } from "@product/client";', file, {
      baseUrl: core,
      paths: { "@product/*": ["../../../shared/api/*"] },
    }).length,
  );
});
test("generic assistant allows its own modules and bundled dependencies", () => {
  for (const source of [
    'import type { Event } from "./events";',
    'import { useState } from "react";',
    'import "./cards.css";',
    '// import { api } from "../../../shared/api/client";',
  ])
    assert.deepEqual(checkSource(source, file), [], source);
});
