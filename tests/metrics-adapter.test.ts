import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The quality adapter is a JavaScript command-line module.
import { isProductionSource, promiseCatchPath } from './metrics-boundaries.mjs';

function callbacks(text: string) {
  const source = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true);
  const nodes: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (ts.isArrowFunction(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { source, nodes };
}

describe('quality measurement boundaries', () => {
  it('keeps production modules and excludes standard test sources including fixtures', () => {
    for (const name of ['app.ts', 'View.tsx', 'worker.js', 'cli.mjs']) expect(isProductionSource(name)).toBe(true);
    for (const name of ['app.test.ts', 'app.spec.tsx', 'api-insights.test.fixture.ts', 'styles.css']) expect(isProductionSource(name)).toBe(false);
  });

  it('records Promise.catch execution independently of the promise and success callback', () => {
    const { source, nodes } = callbacks('request().then(() => 1)\n  .catch(failure => { report(failure); });');
    expect(promiseCatchPath(nodes[0], source, 10)).toEqual([]);
    expect(promiseCatchPath(nodes[1], source, 0)).toMatchObject([{ line: 2, covered: false, silent: false, coverage_measured: true }]);
    expect(promiseCatchPath(nodes[1], source, 1)).toMatchObject([{ line: 2, covered: true, silent: false }]);
  });

  it('retains silent-handler detection and does not confuse unrelated callbacks', () => {
    const { source, nodes } = callbacks('request().catch(() => {}); request().catch(() => report()); request().then(() => {}); wrap(() => {});');
    expect(promiseCatchPath(nodes[0], source, 1)).toMatchObject([{ silent: true }]);
    expect(promiseCatchPath(nodes[1], source, 1)).toMatchObject([{ silent: false }]);
    expect(promiseCatchPath(nodes[2], source, 1)).toEqual([]);
    expect(promiseCatchPath(nodes[3], source, 1)).toEqual([]);
  });
});
