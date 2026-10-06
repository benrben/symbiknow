import path from 'node:path';
import ts from 'typescript';

const extensions = new Set(['.ts', '.tsx', '.js', '.mjs']);

export function isProductionSource(filename) {
  // The manifest's standard *.test.* / *.spec.* exclusions include fixtures.
  return extensions.has(path.extname(filename)) && !/\.(test|spec)\./.test(filename);
}

export function promiseCatchPath(node, source, hits) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return [];
  if (call.expression.name.text !== 'catch' || call.arguments[0] !== node) return [];
  return [{ line: source.getLineAndCharacterOfPosition(node.body.getStart(source)).line + 1,
    kind: 'catch', covered: hits > 0,
    silent: ts.isBlock(node.body) && node.body.statements.length === 0,
    parser: 'typescript-ast', coverage_measured: true, coverage_kind: 'istanbul-v8' }];
}
