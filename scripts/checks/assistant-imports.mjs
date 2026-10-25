// Parse TypeScript syntax and resolve tsconfig aliases; regex misses type imports,
// re-exports, multiline imports, and dynamic imports. Run from architecture.py.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "frontend/package.json"));
const ts = require("typescript");
export const core = path.join(root, "frontend/src/features/assistant/core");
const configFile = ts.readConfigFile(
  path.join(root, "frontend/tsconfig.json"),
  ts.sys.readFile,
);
if (configFile.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
  );
const config = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.join(root, "frontend"),
);
const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export function checkSource(source, filename, options = config.options) {
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  function fail(node, reason) {
    const line =
      tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    violations.push(`${path.relative(root, filename)}:${line}: ${reason}`);
  }
  function check(node, specifier) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      fail(node, "generic assistant core has an unverifiable dynamic import");
      return;
    }
    const name = specifier.text;
    const resolved = ts.resolveModuleName(
      name,
      filename,
      options,
      ts.sys,
    ).resolvedModule;
    const target =
      resolved?.resolvedFileName ??
      (name.startsWith(".")
        ? path.resolve(path.dirname(filename), name)
        : null);
    if (
      target &&
      !inside(core, target) &&
      (name.startsWith(".") ||
        !target.includes(`${path.sep}node_modules${path.sep}`))
    ) {
      fail(
        node,
        `generic assistant core imports outside its extraction boundary: ${name}`,
      );
    } else if (
      !target &&
      !require.resolve.paths(name)?.some((dir) =>
        fs.existsSync(
          path.join(
            dir,
            name
              .split("/")
              .slice(0, name.startsWith("@") ? 2 : 1)
              .join("/"),
          ),
        ),
      )
    ) {
      fail(
        node,
        `generic assistant core imports an unresolved dependency: ${name}`,
      );
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      check(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      check(
        node,
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null,
      );
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      check(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(filename)
      : /\.[cm]?[jt]sx?$/.test(filename)
        ? [filename]
        : [];
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const violations = fs.existsSync(core)
    ? files(core).flatMap((file) =>
        checkSource(fs.readFileSync(file, "utf8"), file),
      )
    : [];
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
