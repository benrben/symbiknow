import type { AddressInfo } from 'node:net';
import { appendFile } from 'node:fs/promises';
import { AIMessage } from '@langchain/core/messages';
import { createApiServer } from '../server/index.js';
import type { JevAnswer, JevDecider, JevQuestion } from '../server/jev.js';
import type { DeepAgentFactory } from '../server/chat-stream.js';

type Document = { title: string; kind?: string };
type Pair = { first: Document; second: Document; existingLink: string };
type State = { document?: Document; documents?: Document[]; pair?: Pair; pairs?: Pair[] };

function matchingPair(first: string, second: string, a: string, b: string): boolean {
  return (first === a && second === b) || (first === b && second === a);
}

function usefulPair(pair: Pair): boolean {
  const first = pair.first.title;
  const second = pair.second.title;
  return matchingPair(first, second, 'Automation source', 'Automation target')
    || matchingPair(first, second, 'Group A1', 'Group A2')
    || matchingPair(first, second, 'Group A1', 'Group B1')
    || matchingPair(first, second, 'Group B1', 'Group B2');
}

function answer(id: string, question: JevQuestion, state: State): JevAnswer {
  const document = state.document ?? state.documents?.[Number(id.match(/^d(\d+)/)?.[1] ?? -1)];
  const pair = state.pair ?? state.pairs?.[Number(id.match(/^p(\d+)/)?.[1] ?? -1)];
  if (question.type === 'noul') {
    if (id === 'authorized') {
      const context = state as State & { userRequest?: string; previousAssistant?: string; target?: { title?: string } };
      const proposed = context.previousAssistant?.includes(`delete ${context.target?.title}`) ?? false;
      return { type: 'noul', noul: context.userRequest === 'yes' && proposed ? 0.99 : 0.05 };
    }
    if (id.endsWith('_merge_safe')) return { type: 'noul', noul: 0.96 };
    const removeSavedLink = id.endsWith('_keep') && pair
      && matchingPair(pair.first.title, pair.second.title, 'Roadmap overview', 'Launch checklist');
    return { type: 'noul', noul: id.endsWith('_keep') ? (removeSavedLink ? 0.1 : 0.95) : 0.05 };
  }
  if (question.type === 'score') {
    const score = id.endsWith('_link_strength') && pair && usefulPair(pair) ? 4
      : id.endsWith('_related') || id.endsWith('_strength') || id.endsWith('_dup_degree') ? 4 : 0;
    return { type: 'score', score, confidence: 0.95,
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), Number(index === score)])) };
  }
  const choices = Object.keys(question.criteria);
  let choice = choices[0];
  if (id === 'intent') choice = (state as State & { latest?: string }).latest === 'yes' ? 'delete' : choice;
  else if (id.endsWith('_dup_kind')) choice = 'identical';
  else if (id.endsWith('_newer')) choice = (state as State & { a?: { title?: string } }).a?.title === 'Setup v2' ? 'a' : 'b';
  else if (id.endsWith('_relation')) choice = 'same_topic';
  else if (id.endsWith('_direction')) choice = 'a_to_b';
  else if (id.endsWith('_domain')) choice = 'engineering' in question.criteria ? 'engineering' : choices[0];
  else if (id.endsWith('_work_area')) choice = 'software_engineering' in question.criteria ? 'software_engineering' : choices.find(key => key !== 'other') ?? choices[0];
  else if (id.endsWith('_lane')) choice = document?.title.startsWith('Group B') ? 'work' : 'overview';
  else if (id.endsWith('_loader')) choice = document?.kind ?? 'markdown';
  else if (id.endsWith('_purpose') || id.endsWith('_reviewer')) choice = 'other' in question.criteria ? 'other' : 'none';
  else if (id.endsWith('_link')) choice = pair && usefulPair(pair) ? 'a_to_b' : 'none';
  return { type: 'choice', choice, confidence: 0.95,
    probabilities: Object.fromEntries(choices.map(key => [key, Number(key === choice)])) };
}

const jevDecider: JevDecider = async (_apiKey, value, questions) => {
  const state = value as State;
  await appendFile(`${dataDir}/jev-questions.jsonl`, `${JSON.stringify(Object.keys(questions))}\n`);
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question, state)]));
};

const agentFactory: DeepAgentFactory = (_settings, tools) => async function* (messages) {
  const latest = String(messages.at(-1)?.content ?? '');
  if (latest === 'yes') {
    const target = tools.find(item => item.name === 'delete_doc');
    if (!target) throw new Error('Delete tool was not available to the confirmation');
    const canvas = await fetch(`http://127.0.0.1:${port}/api/workspaces`).then(response => response.json()) as Array<{ canvases: Array<{ id: string }> }>;
    const current = await fetch(`http://127.0.0.1:${port}/api/canvases/${canvas[0].canvases[0].id}`).then(response => response.json()) as { blocks: Array<{ id: string; title: string }> };
    const block = current.blocks.find(item => item.title === 'Temporary Note');
    if (!block) throw new Error('Temporary Note was not found');
    await target.invoke({ blockId: block.id });
    yield { messages: [...messages, new AIMessage('Deleted Temporary Note.')] };
    return;
  }
  if (latest.includes('Draft a merge of these documents:')) {
    yield { messages: [...messages, new AIMessage('```markdown\n# Setup\n\nInstall the client and check configuration.\n```')] };
    return;
  }
  yield { messages: [...messages, new AIMessage('Ready.')] };
};

const port = Number(process.env.PORT);
const dataDir = process.env.DATA_DIR;
if (!Number.isInteger(port) || !dataDir) throw new Error('Acceptance server needs PORT and DATA_DIR');
const server = await createApiServer({ dataDir, jevDecider, agentFactory });
server.listen(port, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  console.log(`SymbiKnow acceptance server listening on ${address.port}`);
});
