import { context, save, usage, type Doc } from './common.mts';
import { groups, fileCases, canvases, homeCases, visibleCanvases } from './data/placement-cases.mts';
import { file } from '../../server/jev/actions/profile.ts';
import { homeCanvas } from '../../server/jev/actions/placement.ts';
const run = process.argv[2] ?? 'baseline-r1';
const action = process.argv[3];
const atlasOnly = process.argv[4] === 'atlas-only';
const selectedFileCases = atlasOnly ? fileCases.filter(item => item.ok.length > 0) : fileCases;
const clone = (doc: Doc, canvasId: string): Doc => ({ ...doc, canvasId, snapshot: { ...doc.snapshot, canvasId }, block: { ...doc.block } });
async function fileCase(item: typeof fileCases[number]) {
  const documents = selectedFileCases.map(({ doc }) => {
    const copy = clone(doc, 'atlas');
    if (doc.block.id !== item.doc.block.id) copy.block.group = groups.find(group => group.members.includes(doc.block.id))?.key;
    return copy;
  });
  const input = context(documents, [{ id: 'atlas', name: 'Atlas', groups: groups.map(group => ({ id: group.key, name: group.name, definition: group.definition })) }]);
  const result = await file(input, { action: 'file', canvasId: 'atlas', blockIds: [item.doc.block.id] });
  const mutation = result.proposals.find(candidate => candidate.mutation.kind === 'document' && candidate.mutation.patch.group)?.mutation;
  const filed = mutation?.kind === 'document' ? mutation.patch.group ?? null : null;
  const good = item.ok.length ? item.ok.includes(String(filed)) : !filed || !groups.some(group => group.key === filed);
  return { variant: 'shipped-production', doc: item.doc.block.id, ok: item.ok, filed, good, proposals: result.proposals.length };
}
async function homeCase(item: typeof homeCases[number]) {
  const visible = visibleCanvases(item.doc.block.id);
  const documents = visible.flatMap(canvas => canvas.docs.map(id => clone(fileCases.find(({ doc }) => doc.block.id === id)!.doc, canvas.id)));
  documents.push(clone(item.doc, item.current));
  const input = context(documents, canvases);
  const result = await homeCanvas(input, { action: 'suggest_home_canvas', canvasId: item.current, blockIds: [item.doc.block.id] });
  const mutation = result.proposals[0]?.mutation;
  const moveTo = mutation?.kind === 'move' ? mutation.targetCanvasId : null;
  const alternates: Record<string, string[]> = { 'sdk-and-webmcp': ['6f1c2a90-search', '8d3e5b11-collab'], 'mcp-and-api': ['8d3e5b11-collab', '6f1c2a90-search'], architecture: ['4b8d1e77-eng', '8d3e5b11-collab'], 'plan-status': ['4b8d1e77-eng', '6f1c2a90-search'] };
  const acceptable = item.right === null ? [] : alternates[item.doc.block.id] ?? [item.right];
  const good = item.right === null ? !moveTo : acceptable.includes(item.current) ? !moveTo || acceptable.includes(moveTo) : !!moveTo && acceptable.includes(moveTo);
  return { variant: 'shipped-production', doc: item.doc.block.id, current: item.current, right: item.right, moveTo, good };
}
if (!['file', 'home'].includes(action)) throw new Error('baseline-placement requires file or home');
const rows = action === 'file' ? await Promise.all(selectedFileCases.map(fileCase)) : await Promise.all(homeCases.filter(item => !atlasOnly || item.right !== null).map(homeCase));
const summary = { action, run, right: `${rows.filter(row => row.good).length}/${rows.length}`, failed: rows.filter(row => !row.good), usage };
save(`${action}-${run}`, { summary, rows });
console.log(JSON.stringify(summary));
