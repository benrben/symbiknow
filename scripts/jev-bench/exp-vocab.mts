// Frozen vocabulary pairs judged by the shipped lifecycle and automatic merge paths.
// Independently authored heldout texts require separate approval before external execution.
import { createHash } from 'node:crypto';
import { atlas, context, jev, save, usage } from './common.mts';
import { JEV_MODEL } from '../../server/jev.ts';
import type { JevVocabularyTerm } from '../../shared/jev-types.ts';
import { vocabularyHeldout } from './data/vocabulary-heldout.mts';
import { vocabularyCorpus, vocabularyHeldoutContext } from './vocabulary-heldout-context.mts';
import { evaluateVocabularyPair, type VocabularyPairFixture } from './vocabulary-pair-evaluation.mts';
const run = process.argv[2] ?? 'r1';
const corpus = vocabularyCorpus(process.argv.slice(3));
type Term = { name: string; definition: string; doc: string };
const t = (name: string, definition: string, doc: string): Term => ({ name, definition, doc });
const pairs: Array<[Term, Term, boolean]> = corpus === 'heldout' ? [
  [t('Chat proposals', 'Changes the assistant suggests for review', 'chat-internals'), t('Suggested edits', 'Edits proposed by the chat assistant that a person reviews', 'assistant-and-research'), true],
  [t('Acceptance tests', 'Cucumber scenarios that check user workflows', 'testing'), t('Feature scenarios', 'Gherkin scenarios that describe and test workflows', 'testing'), true],
  [t('Self-hosting', 'Running SymbiKnow on your own server', 'operations'), t('On-premise deployment', 'Deploying SymbiKnow on infrastructure you control', 'operations'), true],
  [t('Error codes', 'HTTP status codes the API returns', 'errors'), t('Status codes', 'The HTTP statuses returned for API errors', 'errors'), true],
  [t('Chat proposals', 'Changes the assistant suggests for review', 'chat-internals'), t('Research canvas', 'A temporary canvas the assistant draws answers on', 'assistant-and-research'), false],
  [t('Acceptance tests', 'Cucumber scenarios that check user workflows', 'testing'), t('Unit tests', 'Vitest tests for single modules', 'testing'), false],
  [t('Self-hosting', 'Running SymbiKnow on your own server', 'operations'), t('Environment variables', 'Settings passed to the server at start', 'operations'), false],
  [t('Error codes', 'HTTP status codes the API returns', 'errors'), t('Validation messages', 'Form field errors shown in the browser', 'errors'), false],
] : [  [t('Access tokens', 'Bearer tokens that let agents call the API', 'security-and-access'), t('API tokens', 'Tokens agents use to authenticate their API calls', 'mcp-and-api'), true],
  [t('Canvas search', 'Finding cards on the board', 'canvas-ui'), t('Board search', 'Searching for documents on the canvas board', 'canvas-ui'), true],
  [t('Git history', 'Per-document revision history stored in Git', 'safe-collaboration'), t('Version history', 'Past revisions of each document', 'document-operations'), true],
  [t('Color tokens', 'CSS variables for the brand colors', 'brand-and-ui'), t('Colour palette tokens', 'Design tokens for the brand color palette', 'brand-and-ui'), true],
  [t('Access tokens', 'Bearer tokens that let agents call the API', 'security-and-access'), t('Secrets', 'Provider keys stored in settings', 'security-and-access'), false],
  [t('Canvas search', 'Finding cards on the board', 'canvas-ui'), t('Semantic search', 'Embedding search across all documents', 'search-and-brain-tools'), false],
  [t('Git history', 'Per-document revision history stored in Git', 'safe-collaboration'), t('Undo', 'Reverting a chat proposal after it was applied', 'chat-internals'), false],
  [t('Color tokens', 'CSS variables for the brand colors', 'brand-and-ui'), t('Typography', 'Fonts and the type scale', 'brand-and-ui'), false],
  [t('Zoom levels', 'Card detail shown at each zoom band', 'canvas-ui'), t('Canvas navigation', 'Moving around the board and its history', 'canvas-ui'), false],
];
function term(value: Term, id: string): JevVocabularyTerm {
  return { id, name: value.name, definition: value.definition, kind: 'label', aliases: [],
    state: 'active', version: 1, members: [{ canvasId: atlas[value.doc].canvasId, blockId: atlas[value.doc].block.id }] };
}
function atlasPair([source, target, truth]: [Term, Term, boolean], index: number): VocabularyPairFixture {
  const documents = [...new Set([source.doc, target.doc])].map(id => atlas[id]);
  const input = context(documents, [{ id: 'atlas', name: 'Project Atlas' }]);
  input.vocabulary = [term(source, `source-${index}`), term(target, `target-${index}`)];
  return { caseId: `${corpus}-${index + 1}`, pair: `${source.name}~${target.name}`, truth, input };
}
const fixtures = corpus === 'independent-heldout' ? vocabularyHeldout.map(item => ({ caseId: item.id,
  pair: `${item.source.name}~${item.target.name}`, truth: item.expectedMerge,
  input: vocabularyHeldoutContext(item, (_key, state, questions) => jev(state, questions)) })) : pairs.map(atlasPair);
const rows = await Promise.all(fixtures.map(item => evaluateVocabularyPair(item, (_key, state, questions) => jev(state, questions))));
const positive = rows.filter(row => row.truth), negative = rows.filter(row => !row.truth);
const frozenInputs = fixtures.map(item => ({ caseId: item.caseId, truth: item.truth,
  terms: item.input.vocabulary, documents: item.input.documents }));
const report = { variant: 'shipped vocabulary paths', model: JEV_MODEL, run, corpus,
  fixtureSha256: createHash('sha256').update(JSON.stringify(frozenInputs)).digest('hex'),
  cases: rows.length, memberDocuments: fixtures.reduce((count, item) => count + item.input.documents.length, 0),
  merges: `${positive.filter(row => row.accepted).length}/${positive.length}`,
  wrongMerges: `${negative.filter(row => row.accepted).length}/${negative.length}`,
  automaticMerges: `${positive.filter(row => row.automaticAccepted).length}/${positive.length}`,
  automaticWrongMerges: `${negative.filter(row => row.automaticAccepted).length}/${negative.length}`,
  automaticAssessedCases: `${rows.filter(row => row.automaticAssessed).length}/${rows.length}`,
  providerRequests: usage.calls };
console.log(JSON.stringify(report));
save(`vocab-${corpus}-${run}`, { report, rows });
