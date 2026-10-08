/** Audit recorded outcomes against frozen answer keys; no network or threshold tuning. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const alternates = { 'sdk-and-webmcp': ['6f1c2a90-search', '8d3e5b11-collab'],
  'mcp-and-api': ['8d3e5b11-collab', '6f1c2a90-search'],
  architecture: ['4b8d1e77-eng', '8d3e5b11-collab'], 'plan-status': ['4b8d1e77-eng', '6f1c2a90-search'] };
function acceptable(row) { return row.right === null ? [] : row.acceptable ?? alternates[row.doc] ?? [row.right]; }
function matches(row, allowed) {
  if (row.right === null) return !row.moveTo;
  if (allowed.includes(row.current)) return !row.moveTo || allowed.includes(row.moveTo);
  return allowed.includes(row.moveTo);
}
for (const argument of process.argv.slice(2)) {
  const filename = argument.endsWith('.json') ? path.resolve(argument) : path.join(here, 'out', `home-production-${argument}.json`);
  const report = JSON.parse(readFileSync(filename, 'utf8'));
  const rows = Array.isArray(report) ? report : report.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Missing home outcomes in ${filename}`);
  const variants = new Set(rows.map(row => row.variant ?? 'shipped-production'));
  for (const variant of variants) {
    const selected = rows.filter(row => (row.variant ?? 'shipped-production') === variant);
    const failures = selected.filter(row => row.providerError || !matches(row, acceptable(row)));
    const wrongMoves = selected.filter(row => row.moveTo && !acceptable(row).includes(row.moveTo));
    console.log(JSON.stringify({ filename, variant, right: `${selected.length - failures.length}/${selected.length}`,
      wrongMoves: wrongMoves.length, failures: failures.map(row => ({ doc: row.doc, current: row.current,
        acceptable: acceptable(row), moveTo: row.moveTo, providerError: row.providerError })) }));
  }
}
