type SourcePath = Array<string | number>;
type Visitor = (value: unknown, path: SourcePath) => void;
const jobFields = ['sources', 'contextSources', 'followupSources'];
const mutationFields = ['before', 'after'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function field(value: unknown, path: SourcePath, name: string, visit: Visitor): void {
  if (record(value) && Object.hasOwn(value, name)) visit(value[name], [...path, name]);
}
function list(value: unknown, path: SourcePath, visit: Visitor): void {
  if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
}
function profile(value: unknown, path: SourcePath, visit: Visitor): void {
  field(value, path, 'scopedSources', visit);
}
function mutation(value: unknown, path: SourcePath, visit: Visitor): void {
  if (!record(value) || value.kind !== 'derived') return;
  field(value, path, 'values', (values, point) => profile(values, point, visit));
}
function proposal(value: unknown, path: SourcePath, visit: Visitor): void {
  field(value, path, 'sources', visit);
  field(value, path, 'mutation', (item, point) => mutation(item, point, visit));
}
function job(value: unknown, path: SourcePath, visit: Visitor): void {
  for (const name of jobFields) field(value, path, name, visit);
}
function historyMutations(value: unknown, path: SourcePath, visit: Visitor): void {
  for (const name of mutationFields) field(value, path, name, (item, point) => mutation(item, point, visit));
}
function receipt(value: unknown, path: SourcePath, visit: Visitor): void {
  field(value, path, 'sourcesAfter', visit);
  historyMutations(value, path, visit);
}
function prepared(value: unknown, path: SourcePath, visit: Visitor): void {
  field(value, path, 'proposal', (item, point) => proposal(item, point, visit));
  historyMutations(value, path, visit);
}
function profiles(value: unknown, path: SourcePath, visit: Visitor): void {
  if (!record(value)) return;
  for (const key of Object.keys(value)) profile(value[key], [...path, key], visit);
}
function rootList(value: unknown, name: string, visit: Visitor): void {
  field(value, [], name, (items, path) => list(items, path, visit));
}

/** Inspect only the codec's explicit source-vector locations, without copying history or reading unrelated payloads. */
export function visitWorkspaceSourceReferences(value: unknown, visit: Visitor): void {
  rootList(value, 'jobs', (item, path) => job(item, path, visit));
  rootList(value, 'proposals', (item, path) => proposal(item, path, visit));
  rootList(value, 'receipts', (item, path) => receipt(item, path, visit));
  field(value, [], 'profiles', (items, path) => profiles(items, path, visit));
  rootList(value, 'prepared', (item, path) => prepared(item, path, visit));
}
