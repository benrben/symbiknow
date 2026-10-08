import { atlas, context, jev, save, usage, type Doc } from './common.mts';
import { groups, fileCases, canvases, homeCases, visibleCanvases } from './data/placement-cases.mts';
import { filingQuestionSet, filingDecision, filingEvidenceQuestionSet } from '../../server/jev/actions/filing-selection.ts';
import { homeQuestionSet, homeDecision, homeEvidenceQuestionSet } from '../../server/jev/actions/home-selection.ts';
const [run = 'r1', action = 'file', corpus = 'all', mode = 'same-call'] = process.argv.slice(2);
const clone = (doc: Doc, canvasId: string): Doc => ({ ...doc, canvasId, snapshot: { ...doc.snapshot, canvasId }, block: { ...doc.block } });
async function fileCase(item: typeof fileCases[number]) {
  const documents = Object.values(atlas).map(doc => {
    const copy = clone(doc, 'atlas');
    if (doc.block.id !== item.doc.block.id) copy.block.group = groups.find(group => group.members.includes(doc.block.id))?.key;
    return copy;
  });
  const source = documents.find(doc => doc.block.id === item.doc.block.id) ?? clone(item.doc, 'atlas');
  const input = context(documents, [{ id: 'atlas', name: 'Atlas' }]);
  const set = filingQuestionSet(input, source, groups, mode !== 'separate');
  let answers = await jev(set.state, set.questions);
  const selected = filingDecision(input, source, groups, answers);
  if (mode === 'separate' && selected) {
    const evidence = filingEvidenceQuestionSet(source, selected.group);
    answers = { ...answers, ...await jev(evidence.state, evidence.questions) };
  }
  const decision = filingDecision(input, source, groups, answers);
  const filed = decision?.evidence.length ? decision.group.key : null;
  const good = item.ok.length ? item.ok.includes(String(filed)) : !filed;
  return { doc: source.block.id, ok: item.ok, filed, good, answers, evidence: decision?.evidence };
}
const alternates: Record<string, string[]> = { 'sdk-and-webmcp': ['6f1c2a90-search', '8d3e5b11-collab'], 'mcp-and-api': ['8d3e5b11-collab', '6f1c2a90-search'], architecture: ['4b8d1e77-eng', '8d3e5b11-collab'], 'plan-status': ['4b8d1e77-eng', '6f1c2a90-search'] };
async function homeCase(item: typeof homeCases[number]) {
  const documents = visibleCanvases(item.doc.block.id).flatMap(canvas => canvas.docs.map(id => clone(atlas[id], canvas.id)));
  const source = clone(item.doc, item.current);
  documents.push(source);
  const input = context(documents, canvases);
  const set = homeQuestionSet(input, source, mode !== 'separate');
  let answers = await jev(set.state, set.questions);
  const selected = homeDecision(input, source, answers);
  if (mode === 'separate' && selected) {
    const evidence = homeEvidenceQuestionSet(source, selected.target);
    answers = { ...answers, ...await jev(evidence.state, evidence.questions) };
  }
  const decision = homeDecision(input, source, answers);
  const moveTo = decision?.evidence.length ? decision.target.id : null;
  const acceptable = item.right === null ? [] : alternates[source.block.id] ?? [item.right];
  const good = item.right === null ? !moveTo : acceptable.includes(item.current) ? !moveTo || acceptable.includes(moveTo) : !!moveTo && acceptable.includes(moveTo);
  return { doc: source.block.id, current: item.current, right: item.right, moveTo, good, answers, evidence: decision?.evidence };
}
if (!['file', 'home'].includes(action)) throw new Error('Expected file or home');
const rows = action === 'file' ? await Promise.all(fileCases.filter(item => corpus !== 'atlas-only' || item.ok.length > 0).map(fileCase)) : await Promise.all(homeCases.filter(item => corpus !== 'atlas-only' || item.right !== null).map(homeCase));
const summary = { action, run, mode, right: `${rows.filter(row => row.good).length}/${rows.length}`, failed: rows.filter(row => !row.good).map(row => row.doc), usage };
save(`${action}-evidence-${run}`, { summary, rows });
console.log(JSON.stringify(summary));
