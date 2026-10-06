import type { AnswerCanvasResult, CanvasNavigationTarget, ResearchCanvasPatch } from '../shared/answer-canvas';
import type { AgentStep, ChatProposal } from './chat-stream-types';

type Payload = Record<string, unknown>;
type Validator = (value: unknown) => boolean;

function isObject(value: unknown): value is Payload { return value !== null && typeof value === 'object'; }
function isString(value: unknown): value is string { return typeof value === 'string'; }
function hasStrings(value: Payload, fields: string[]) { return fields.every(field => isString(value[field])); }
function isArrayOf(value: unknown, validate: Validator) { return Array.isArray(value) && value.every(validate); }
function optional(value: unknown, validate: Validator) { return value === undefined || validate(value); }
function isBoolean(value: unknown) { return typeof value === 'boolean'; }
function isNullableObject(value: unknown) { return value === null || typeof value === 'object'; }

export function isAgentStep(value: unknown): value is AgentStep {
  if (!isObject(value)) return false;
  return ['thinking', 'tool_start', 'tool_end'].includes(value.type as string) && isString(value.message);
}

function isAnswerSource(value: unknown) {
  if (!isObject(value)) return false;
  return hasStrings(value, ['canvasId', 'blockId', 'title', 'excerpt']);
}

export function isAnswerCanvas(value: unknown): value is AnswerCanvasResult {
  if (!isObject(value)) return false;
  return hasStrings(value, ['query', 'canvasId']) && ['jev', 'local'].includes(value.selection as string)
    && isArrayOf(value.sources, isAnswerSource);
}

function isNavigationKind(value: Payload) {
  if (value.kind === 'document') return isString(value.blockId);
  if (value.kind === 'group') return isString(value.group);
  return false;
}

export function isNavigation(value: unknown): value is CanvasNavigationTarget {
  if (!isObject(value)) return false;
  return hasStrings(value, ['canvasId', 'title']) && isNavigationKind(value);
}

function isResearchKind(value: unknown) { return ['markdown', 'html', 'slides', 'website', 'mdx'].includes(value as string); }

function isResearchBlock(value: unknown) {
  if (!isObject(value)) return false;
  return hasStrings(value, ['id', 'title', 'content']) && optional(value.kind, isResearchKind)
    && ['text', 'diagram', 'task', 'section'].includes(value.type as string) && Array.isArray(value.sourceIds);
}

function isResearchEdge(value: unknown) {
  if (!isObject(value)) return false;
  return hasStrings(value, ['from', 'to']);
}

export function isResearchPatch(value: unknown): value is ResearchCanvasPatch {
  if (!isObject(value)) return false;
  return isString(value.query) && isArrayOf(value.blocks, isResearchBlock) && isArrayOf(value.edges, isResearchEdge);
}

function isProposalChange(value: unknown) {
  if (!isObject(value)) return false;
  return hasStrings(value, ['id', 'blockId', 'title']) && ['create', 'edit', 'delete', 'move', 'link'].includes(value.type as string)
    && isNullableObject(value.before) && isNullableObject(value.after) && optional(value.canApply, isBoolean);
}

export function isChatProposal(value: unknown): value is ChatProposal {
  if (!isObject(value)) return false;
  return hasStrings(value, ['id', 'canvasId']) && value.status === 'pending' && isArrayOf(value.changes, isProposalChange)
    && optional(value.expiresAt, isString);
}
