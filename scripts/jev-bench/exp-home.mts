/** Measure the shipped home action, including its selected-canvas exact-evidence round. */
import { atlas, context, jev, save, usage, type Doc } from './common.mts';
import { canvases, homeCases, visibleCanvases } from './data/placement-cases.mts';
import { heldoutHomeCanvases, heldoutHomeExamples, heldoutHomeCases } from './data/home-heldout.mts';
import { homeCanvas } from '../../server/jev/actions/placement.ts';
import type { JevAnswer, JevQuestion } from '../../server/jev.ts';
const [run = 'r1', corpus = 'atlas-only'] = process.argv.slice(2);
const alternates: Record<string, string[]> = { 'sdk-and-webmcp': ['6f1c2a90-search', '8d3e5b11-collab'],
  'mcp-and-api': ['8d3e5b11-collab', '6f1c2a90-search'], architecture: ['4b8d1e77-eng', '8d3e5b11-collab'],
  'plan-status': ['4b8d1e77-eng', '6f1c2a90-search'] };
const clone = (document: Doc, canvasId: string): Doc => ({ ...document, canvasId,
  snapshot: { ...document.snapshot, canvasId }, block: { ...document.block } });
if (!['atlas-only', 'all', 'heldout', 'heldout-only'].includes(corpus)) throw new Error('Choose atlas-only, all, heldout, or heldout-only');
const cases = [
  ...(corpus === 'heldout-only' ? [] : homeCases.filter(item => corpus !== 'atlas-only' || item.right !== null).map(item => ({ ...item, heldout: false }))),
  ...(['heldout', 'heldout-only'].includes(corpus) ? heldoutHomeCases.map(item => ({ ...item, heldout: true })) : []),
];
const rows = await Promise.all(cases.map(async item => {
  const documents = item.heldout ? heldoutHomeExamples.map(document => clone(document, document.canvasId))
    : visibleCanvases(item.doc.block.id).flatMap(canvas => canvas.docs.map(id => clone(atlas[id], canvas.id)));
  const source = clone(item.doc, item.current); documents.push(source);
  const input = context(documents, item.heldout ? heldoutHomeCanvases : canvases);
  const rounds: Array<{ state: unknown; questions: Record<string, JevQuestion>; answers: Record<string, JevAnswer> }> = [];
  input.decider = async (_key, state, questions) => {
    const answers = await jev(state, questions); rounds.push({ state, questions, answers }); return answers;
  };
  let result: Awaited<ReturnType<typeof homeCanvas>> = { result: { documents: {} }, proposals: [] };
  let providerError: string | undefined;
  try { result = await homeCanvas(input, { action: 'suggest_home_canvas', canvasId: item.current, blockIds: [source.block.id] }); }
  catch (error) { providerError = error instanceof Error ? error.message : String(error); }
  const proposal = result.proposals[0];
  const moveTo = proposal?.mutation.kind === 'move' ? proposal.mutation.targetCanvasId : null;
  const acceptable = item.right === null ? [] : alternates[source.block.id] ?? [item.right];
  const outcomeMatches = item.right === null ? !moveTo : acceptable.includes(item.current) ? !moveTo || acceptable.includes(moveTo)
    : !!moveTo && acceptable.includes(moveTo);
  const good = !providerError && outcomeMatches;
  const wrongMove = Boolean(moveTo && !acceptable.includes(moveTo));
  const evidence = proposal?.evidence ?? [];
  const exact = evidence.every(passage => JSON.stringify(passage.source) === JSON.stringify(source.snapshot)
    && source.block.content.slice(passage.start, passage.end) === passage.quote);
  if (!exact) throw new Error(`Home action returned inexact source evidence for ${source.block.id}`);
  return { doc: source.block.id, heldout: item.heldout, current: item.current, right: item.right, acceptable, moveTo, good, wrongMove,
    decision: (result.result.documents as Record<string, unknown>)[source.block.id], evidence,
    decisionConfidences: proposal?.decisionConfidences, providerError, rounds };
}));
const stateBytes = rows.flatMap(row => row.rounds.map(round => Buffer.byteLength(JSON.stringify(round.state))));
const heldout = rows.filter(row => row.heldout);
const summary = { action: 'home', run, corpus, right: `${rows.filter(row => row.good).length}/${rows.length}`,
  wrongMoves: rows.filter(row => row.wrongMove).length,
  ...(heldout.length ? { heldout: { right: `${heldout.filter(row => row.good).length}/${heldout.length}`, wrongMoves: heldout.filter(row => row.wrongMove).length } } : {}), failed: rows.filter(row => !row.good).map(row => ({ doc: row.doc,
    current: row.current, acceptable: row.acceptable, moveTo: row.moveTo, reason: row.providerError ?? (row.decision as { reason?: string } | undefined)?.reason })), usage: { ...usage },
  stateBytes: { total: stateBytes.reduce((total, size) => total + size, 0), maximum: Math.max(0, ...stateBytes) } };
save(`home-production-${run}`, { summary, rows });
console.log(JSON.stringify(summary));
if (rows.some(row => row.providerError)) process.exitCode = 1;
