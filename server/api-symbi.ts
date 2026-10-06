import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AskSymbiMatch, AskSymbiResult, SymbiCoverage, SymbiPassage, SymbiProviderUsage, SymbiReflexResult } from '../shared/symbi-contract.js';
import { SYMBI_CONTRACT_VERSION } from '../shared/symbi-contract.js';
import { publicOrigin } from './auth.js';
import type { RouteContext } from './api-context.js';
import { readBody, sendJson } from './api-http.js';
import { ApiError } from './errors.js';
import { choice, decideWithJev, JEV_MODEL, onJevUsage, type JevQuestion } from './jev.js';
import { jevApiPrincipal } from './jev-api-principal.js';
import { getJevRuntime } from './jev/runtime.js';

const scope = { canvasId: z.string().min(1).max(64).optional(), documentIds: z.array(z.string().min(1).max(64)).max(20).optional() };
const askSchema = z.strictObject({ ...scope, question: z.string().min(1).max(1000), mode: z.enum(['semantic', 'logic', 'combined']),
  limit: z.number().int().min(1).max(24).optional(), cursor: z.string().max(2000).optional(),
  continuationId: z.string().max(128).optional(), navigate: z.boolean().optional() });
const reflexSchema = z.strictObject({ ...scope, claim: z.string().min(1).max(1000), comparisonDocumentId: z.string().min(1).max(64).optional() });
type AskInput = z.infer<typeof askSchema>;
type AskCandidate = [string, SymbiPassage[]];
type ReflexInput = z.infer<typeof reflexSchema>;
const relatedSchema = z.strictObject({ canvasId: z.string().min(1).max(64), blockId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2000).optional() });
const emptyUsage = (): SymbiProviderUsage => ({ requests: 0, questions: 0, inputTokens: 0, outputTokens: 0 });
const usageContext = new AsyncLocalStorage<SymbiProviderUsage>();
onJevUsage(event => {
  const current = usageContext.getStore();
  if (!current) return;
  current.inputTokens += event.inputTokens;
  current.outputTokens += event.outputTokens;
  current.model = event.model;
});

type Principal = Awaited<ReturnType<typeof jevApiPrincipal>>;

async function principalFor(context: RouteContext, name: 'ask_symbi' | 'symbi_reflex' | 'related' | 'find_by'): Promise<Principal> {
  const principal = await jevApiPrincipal(context.store, context.request, true);
  if (principal.tools && !principal.tools.includes(name)) throw new ApiError(403, 'This token does not permit that brain tool');
  return principal;
}

async function related(context: RouteContext, input: z.infer<typeof relatedSchema>, principal: Principal) {
  if (principal.allowedCanvasIds && !principal.allowedCanvasIds.includes(input.canvasId)) throw new ApiError(404, 'Canvas not found');
  const source = await context.store.getCanvasBlock(input.canvasId, input.blockId);
  const canvas = await context.store.getCanvasSummary(input.canvasId);
  const index = indexFor(context);
  const expectedDocumentIds = await index.expectedDocumentIds(principal.allowedCanvasIds, input.canvasId);
  const search = await index.search({ query: [source.title, source.purpose, ...(source.tags ?? [])].filter(Boolean).join(' '),
    mode: 'hybrid', canvasId: input.canvasId, allowedCanvasIds: principal.allowedCanvasIds,
    allowedDocumentIds: expectedDocumentIds, expectedDocumentIds, limit: 100 });
  const checked = await safePassages(context, search.passages);
  const candidates = relatedCandidates(context, input.canvasId, source, canvas.blocks, groups(checked.valid));
  const cursor = relatedCursor(input.cursor);
  const limit = input.limit ?? 25;
  return { items: candidates.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < candidates.length ? String(cursor + limit) : undefined,
    coverage: coverageWithStale(search.coverage, checked.stale) };
}
function relatedCursor(value?: string): number {
  const cursor = Number(value ?? 0);
  if (!Number.isInteger(cursor) || cursor < 0) throw new ApiError(400, 'Invalid related cursor');
  return cursor;
}
function relatedCandidates(context: RouteContext, canvasId: string,
  source: Awaited<ReturnType<RouteContext['store']['getCanvasBlock']>>,
  blocks: Awaited<ReturnType<RouteContext['store']['getCanvasSummary']>>['blocks'], evidence: Map<string, SymbiPassage[]>) {
  return blocks.filter(block => block.id !== source.id).map(block => ({ canvasId, blockId: block.id, title: block.title,
    reasons: relatedReasons(source, block, evidence, canvasId),
    passages: evidence.get(`${canvasId}\0${block.id}`) ?? [], href: href(context, canvasId, block.id) }))
    .filter(item => item.reasons.length)
    .sort((left, right) => right.reasons.length - left.reasons.length || left.title.localeCompare(right.title));
}
function relatedReasons(source: Awaited<ReturnType<RouteContext['store']['getCanvasBlock']>>,
  block: Awaited<ReturnType<RouteContext['store']['getCanvasBlock']>>, evidence: Map<string, SymbiPassage[]>, canvasId: string): string[] {
  const reasons: string[] = [];
  if (linkedEitherWay(source, block)) reasons.push('linked');
  if (source.group && source.group === block.group) reasons.push('same group');
  if (sharedTopic(source, block)) reasons.push('same topic');
  if (evidence.has(`${canvasId}\0${block.id}`)) reasons.push('source similarity');
  return reasons;
}
function linkedEitherWay(source: { id: string; links: string[] }, block: { id: string; links: string[] }): boolean {
  return source.links.includes(block.id) || block.links.includes(source.id);
}
function sharedTopic(source: { tags?: string[] }, block: { tags?: string[] }): boolean {
  return source.tags?.some(tag => block.tags?.includes(tag)) ?? false;
}

function indexFor(context: RouteContext) {
  if (!context.symbiIndex) throw new ApiError(503, 'The local search index is unavailable');
  return context.symbiIndex;
}

async function safePassages(context: RouteContext, passages: SymbiPassage[]): Promise<{ valid: SymbiPassage[]; stale: number }> {
  const valid: SymbiPassage[] = [];
  let stale = 0;
  for (const passage of passages) {
    if (await passageCurrent(context, passage)) valid.push(passage);
    else stale += 1;
  }
  return { valid, stale };
}
async function passageCurrent(context: RouteContext, passage: SymbiPassage): Promise<boolean> {
  try {
    const block = await context.store.getCanvasBlock(passage.canvasId, passage.blockId);
    return block.contentHash === passage.contentHash
      && block.content.slice(passage.startOffset, passage.endOffset) === passage.excerpt;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return false;
  }
}

function coverageWithStale(coverage: SymbiCoverage, stale: number): SymbiCoverage {
  return stale ? { ...coverage, status: 'pending', pendingDocuments: coverage.pendingDocuments + stale,
    reason: `${stale} source passage(s) changed after indexing` } : coverage;
}

function groups(passages: SymbiPassage[]): Map<string, SymbiPassage[]> {
  const grouped = new Map<string, SymbiPassage[]>();
  for (const passage of passages) {
    const key = `${passage.canvasId}\0${passage.blockId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), passage].slice(0, 3));
  }
  return grouped;
}

async function providerAccess(context: RouteContext, principal: Principal, canvasIds: string[]) {
  if (!canvasIds.length) return { available: false as const, reason: 'No scoped source evidence was found' };
  const policy = await providerPolicy(context, principal, canvasIds);
  if (!policy.available) return policy;
  const settings = await context.store.secretSettings();
  const key = settings.secrets?.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY;
  if (!key) return { available: false as const, reason: 'No provider is configured' };
  return { available: true as const, key, policyFingerprint: policy.fingerprint };
}
async function providerPolicy(context: RouteContext, principal: Principal, canvasIds: string[]) {
  const workspaceIds = new Set<string>();
  const policies: Array<[string, unknown, unknown]> = [];
  for (const id of canvasIds) workspaceIds.add((await context.store.getCanvasSummary(id)).workspaceId);
  for (const workspaceId of workspaceIds) {
    const state = await getJevRuntime(context.store, { fetcher: context.fetcher }).read(workspaceId, principal, true);
    if (!state.settings.externalProcessing) return { available: false as const, reason: 'Provider processing is disabled for this workspace' };
    policies.push([workspaceId, state.settings, state.vocabulary]);
  }
  return { available: true as const,
    fingerprint: createHash('sha256').update(JSON.stringify(policies.sort(([a], [b]) => a.localeCompare(b)))).digest('hex') };
}

function judgmentKey(principal: Principal, key: string, policyFingerprint: string,
  state: unknown, questions: Record<string, JevQuestion>, passages: SymbiPassage[]): string {
  return createHash('sha256').update(JSON.stringify({ version: 'brain-v1', principal: principal.id,
    access: principal.access, tools: principal.tools, allowedCanvasIds: principal.allowedCanvasIds,
    policyFingerprint, keyFingerprint: createHash('sha256').update(key).digest('hex'),
    model: JEV_MODEL, state, questions, sources: passages.map(passage => [passage.canvasId, passage.blockId, passage.contentHash]) })).digest('hex');
}

async function evaluate(context: RouteContext, principal: Principal, key: string, policyFingerprint: string, state: unknown,
  questions: Record<string, JevQuestion>, passages: SymbiPassage[], continuationId?: string) {
  if (!context.symbiJudgments) throw new ApiError(503, 'Judgment recovery is unavailable');
  const id = judgmentKey(principal, key, policyFingerprint, state, questions, passages);
  if (continuationId && continuationId !== id) throw new ApiError(409, 'Continuation source or scope changed; start a new question');
  const usage: SymbiProviderUsage = { requests: 1, questions: Object.keys(questions).length,
    inputTokens: 0, outputTokens: 0, model: JEV_MODEL };
  const result = await context.symbiJudgments.getOrRun(id, async () => {
    const answers = await usageContext.run(usage,
      () => decideWithJev(key, state, questions, context.fetcher, { signal: context.signal, maxRetries: 0 }));
    return { answers, usage };
  });
  if (result.state !== 'complete') return { id, state: result.state, reason: result.reason } as const;
  return { id, state: 'complete' as const, answers: result.value.answers,
    usage: result.reused ? emptyUsage() : result.value.usage };
}

async function titles(context: RouteContext, canvasIds: string[]): Promise<Map<string, { title: string; canvasName: string }>> {
  const result = new Map<string, { title: string; canvasName: string }>();
  for (const canvasId of new Set(canvasIds)) {
    const canvas = await context.store.getCanvasSummary(canvasId);
    for (const block of canvas.blocks) result.set(`${canvasId}\0${block.id}`, { title: block.title, canvasName: canvas.name });
  }
  return result;
}

function href(context: RouteContext, canvasId: string, blockId?: string): string {
  const params = new URLSearchParams({ canvas: canvasId });
  if (blockId) params.set('doc', blockId);
  return `${publicOrigin(context.request)}/?${params}`;
}

function askPage(cursor?: string): { cursor?: string; offset: number } {
  if (cursor?.startsWith('brain:')) {
    try {
      const page = JSON.parse(Buffer.from(cursor.slice(6), 'base64url').toString('utf8')) as { cursor?: string; offset: number };
      if (!validAskPage(page)) throw new Error();
      return page;
    } catch { throw new ApiError(400, 'Invalid ask_symbi cursor'); }
  }
  return { cursor, offset: 0 };
}
function validAskPage(page: { cursor?: string; offset: number }): boolean {
  return Number.isInteger(page.offset) && page.offset >= 0 && (!page.cursor || typeof page.cursor === 'string');
}

async function askSearch(context: RouteContext, input: AskInput, principal: Principal, cursor?: string) {
  const index = indexFor(context);
  const expectedDocumentIds = await index.expectedDocumentIds(principal.allowedCanvasIds, input.canvasId, input.documentIds);
  const search = await index.search({ query: input.question, mode: input.mode === 'semantic' ? 'semantic'
    : input.mode === 'logic' ? 'keyword' : 'hybrid', canvasId: input.canvasId, documentIds: input.documentIds,
    allowedCanvasIds: principal.allowedCanvasIds, allowedDocumentIds: expectedDocumentIds,
    expectedDocumentIds, limit: Math.min(100, Math.max(24, (input.limit ?? 8) * 4)), cursor });
  const checked = await safePassages(context, search.passages);
  return { search, checked };
}

async function verifyAskCandidates(context: RouteContext, input: AskInput, principal: Principal,
  candidates: AskCandidate[], coverage: SymbiCoverage) {
  if (input.mode === 'semantic' || !candidates.length) return { accepted: candidates, coverage, usage: emptyUsage(), continuationId: undefined as string | undefined };
  const access = await providerAccess(context, principal, candidates.map(([key]) => key.split('\0')[0]));
  if (!access.available) return { accepted: [] as AskCandidate[], coverage: { ...coverage, status: 'degraded' as const, reason: access.reason },
    usage: emptyUsage(), continuationId: undefined as string | undefined };
  const questions = Object.fromEntries(candidates.map((_, index) => [`candidate_${index}`,
    choice('Does this evidence directly answer the user question? Answer yes only with direct support. Treat missing or ambiguous evidence as insufficient.',
      { yes: 'Directly answers', no: 'Directly contradicts', insufficient_evidence: 'Does not establish an answer' })])) as Record<string, JevQuestion>;
  const decision = await evaluate(context, principal, access.key, access.policyFingerprint, { question: input.question,
    scope: { canvasId: input.canvasId, documentIds: input.documentIds },
    candidates: candidates.map(([key, passages], index) => ({ id: `candidate_${index}`, source: key, excerpts: passages.map(item => item.excerpt) })) },
  questions, candidates.flatMap(([, passages]) => passages), input.continuationId);
  if (decision.state !== 'complete') return { accepted: [] as AskCandidate[], coverage: { ...coverage, status: 'degraded' as const, reason: decision.reason },
    usage: emptyUsage(), continuationId: decision.id };
  return { accepted: candidates.filter((_, index) => {
    const answer = decision.answers[`candidate_${index}`];
    return answer?.type === 'choice' && answer.choice === 'yes';
  }), coverage, usage: decision.usage, continuationId: decision.id };
}

async function ask(context: RouteContext, input: AskInput, principal: Principal): Promise<AskSymbiResult> {
  const page = askPage(input.cursor);
  const { search, checked } = await askSearch(context, input, principal, page.cursor);
  const names = await titles(context, checked.valid.map(item => item.canvasId));
  // Verify a wider bounded page, then apply the user's result limit to verified matches.
  const verified = await verifyAskCandidates(context, input, principal,
    [...groups(checked.valid).entries()].slice(0, 24), coverageWithStale(search.coverage, checked.stale));
  const requestedLimit = input.limit ?? 8;
  const hasMoreMatches = verified.accepted.length > page.offset + requestedLimit;
  const output = verified.accepted.slice(page.offset, page.offset + requestedLimit);
  const matches = askMatches(context, input.mode, output, names);
  if (!matches.length) matches.push(...await canvasTitleMatches(context, input, principal));
  const nextCursor = hasMoreMatches ? `brain:${Buffer.from(JSON.stringify({ cursor: page.cursor, offset: page.offset + requestedLimit })).toString('base64url')}`
    : search.nextCursor;
  return { version: SYMBI_CONTRACT_VERSION, matches, coverage: verified.coverage, providerUsage: verified.usage, nextCursor,
    ...(verified.continuationId ? { continuationId: verified.continuationId } : {}),
    ...askNavigation(context, input, matches) };
}
function askNavigation(context: RouteContext, input: AskInput, matches: AskSymbiMatch[]) {
  const canvasIds = [...new Set(matches.map(match => match.canvasId))];
  return input.navigate && canvasIds.length === 1
    ? { navigation: { canvasId: canvasIds[0], href: href(context, canvasIds[0]), activated: false } } : {};
}
function askMatches(context: RouteContext, mode: AskInput['mode'], output: AskCandidate[],
  names: Map<string, { title: string; canvasName: string }>): AskSymbiMatch[] {
  return output.map(([key, passages]) => {
    const [canvasId, blockId] = key.split('\0');
    return { canvasId, blockId, title: names.get(key)?.title ?? blockId,
      reason: mode === 'semantic' ? 'Local semantic and metadata evidence' : 'Provider-validated source evidence',
      passages, href: href(context, canvasId, blockId) };
  });
}
async function canvasTitleMatches(context: RouteContext, input: AskInput, principal: Principal): Promise<AskSymbiMatch[]> {
  const query = input.question.toLocaleLowerCase();
  const workspaces = await context.store.listWorkspaces();
  const matches: AskSymbiMatch[] = [];
  for (const canvas of workspaces.flatMap(workspace => workspace.canvases)) {
    if (!canvasAllowedForAsk(canvas.id, input.canvasId, principal.allowedCanvasIds)) continue;
    if (canvas.name.toLocaleLowerCase().includes(query)) matches.push({ canvasId: canvas.id, title: canvas.name,
      reason: 'Canvas title match', passages: [], href: href(context, canvas.id) });
  }
  return matches;
}
function canvasAllowedForAsk(canvasId: string, requested: string | undefined, allowed: string[] | undefined): boolean {
  return (!allowed || allowed.includes(canvasId)) && (!requested || requested === canvasId);
}

function reflexFallback(passages: SymbiPassage[], coverage: SymbiCoverage, reason: string): SymbiReflexResult {
  return { version: SYMBI_CONTRACT_VERSION, verdict: 'insufficient_evidence', confidence: 0,
    explanation: reason, passages, coverage, providerUsage: emptyUsage() };
}

function reflexDecision(answer: Awaited<ReturnType<typeof evaluate>> & { state: 'complete' },
  passages: SymbiPassage[], coverage: SymbiCoverage): SymbiReflexResult {
  const value = answer.answers.verdict;
  const verdict = value.type === 'choice' ? value.choice as SymbiReflexResult['verdict'] : 'insufficient_evidence';
  return { version: SYMBI_CONTRACT_VERSION,
    verdict: verdict === 'no' && coverage.status !== 'ready' ? 'insufficient_evidence' : verdict,
    confidence: value.type === 'choice' ? value.confidence : 0,
    explanation: reflexExplanation(verdict, coverage.status),
    passages, coverage, providerUsage: answer.usage };
}
function reflexExplanation(verdict: SymbiReflexResult['verdict'], status: SymbiCoverage['status']): string {
  if (verdict === 'yes') return 'The checked passages support the claim.';
  if (verdict === 'no' && status === 'ready') return 'The checked passages contradict the claim.';
  return 'The checked passages do not establish a reliable answer.';
}

async function reflexSearch(context: RouteContext, input: ReflexInput, principal: Principal) {
  const index = indexFor(context);
  const documentIds = [...new Set([...(input.documentIds ?? []), ...(input.comparisonDocumentId ? [input.comparisonDocumentId] : [])])];
  const expectedDocumentIds = await index.expectedDocumentIds(principal.allowedCanvasIds, input.canvasId, documentIds.length ? documentIds : undefined);
  const search = await index.search({ query: input.claim, mode: 'hybrid', canvasId: input.canvasId,
    documentIds: documentIds.length ? documentIds : undefined, allowedCanvasIds: principal.allowedCanvasIds,
    allowedDocumentIds: expectedDocumentIds, expectedDocumentIds, limit: 24 });
  return { documentIds, search };
}

async function reflex(context: RouteContext, input: ReflexInput, principal: Principal): Promise<SymbiReflexResult> {
  const { documentIds, search } = await reflexSearch(context, input, principal);
  const checked = await safePassages(context, search.passages);
  let coverage = coverageWithStale(search.coverage, checked.stale);
  if (!checked.valid.length) return reflexFallback(checked.valid, coverage, 'No current source passage establishes the claim.');
  const access = await providerAccess(context, principal, checked.valid.map(item => item.canvasId));
  if (!access.available) {
    coverage = { ...coverage, status: 'degraded', reason: access.reason };
    return reflexFallback(checked.valid, coverage, access.reason);
  }
  const questions = { verdict: choice('Decide whether the exact scoped passages support or contradict the claim. Choose no only for direct contradictory evidence; absence or incomplete coverage is insufficient.',
    { yes: 'Directly supported', no: 'Directly contradicted', insufficient_evidence: 'Unclear or missing evidence' }) };
  const decision = await evaluate(context, principal, access.key, access.policyFingerprint, { claim: input.claim,
    scope: { canvasId: input.canvasId, documentIds, comparisonDocumentId: input.comparisonDocumentId },
    passages: checked.valid.map((passage, index) => ({ id: `p${index}`, canvasId: passage.canvasId,
      blockId: passage.blockId, excerpt: passage.excerpt })) }, questions, checked.valid);
  if (decision.state !== 'complete') {
    coverage = { ...coverage, status: 'degraded', reason: decision.reason };
    return reflexFallback(checked.valid, coverage, decision.reason);
  }
  return reflexDecision(decision, checked.valid, coverage);
}

const symbiRouteNames: Record<string, 'ask_symbi' | 'find_by' | 'related' | 'symbi_reflex'> = {
  '/api/symbi/ask': 'ask_symbi', '/api/symbi/find': 'find_by',
  '/api/symbi/related': 'related', '/api/symbi/reflex': 'symbi_reflex',
};

async function symbiResponse(context: RouteContext, name: 'ask_symbi' | 'find_by' | 'related' | 'symbi_reflex',
  principal: Principal, input: unknown): Promise<unknown> {
  if (name === 'related') {
    const parsed = relatedSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'Invalid related request');
    return related(context, parsed.data, principal);
  }
  if (name === 'symbi_reflex') {
    const parsed = reflexSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'Invalid symbi_reflex request');
    return reflex(context, parsed.data, principal);
  }
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'Invalid ask_symbi request');
  return ask(context, parsed.data, principal);
}

export async function symbiRoutes(context: RouteContext): Promise<boolean> {
  const name = symbiRouteNames[context.route];
  if (context.method !== 'POST' || !name) return false;
  const principal = await principalFor(context, name);
  sendJson(context.response, 200, await symbiResponse(context, name, principal, await readBody(context.request)));
  return true;
}
