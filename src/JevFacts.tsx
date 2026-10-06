import type { JevJson, JevMutation, JevValues } from '../shared/jev-types';

function fieldLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

export function JevFacts({ values }: { values: JevValues }) {
  return <dl className="jev-facts">{Object.entries(values).map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd><FactValue value={value}/></dd></div>)}</dl>;
}

function FactValue({ value }: { value: JevJson }) {
  if (value === null) return <>Clear this value</>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (Array.isArray(value)) return <FactArray values={value}/>;
  if (typeof value === 'object') return <JevFacts values={value}/>;
  return <>{String(value).replaceAll('_', ' ')}</>;
}

function FactArray({ values }: { values: JevJson[] }) {
  return values.length ? <ul>{values.map((item, index) => <li key={index}><FactValue value={item}/></li>)}</ul> : <>None</>;
}

export function JevMutationSummary({ mutation }: { mutation: JevMutation }) {
  if (mutation.kind === 'content') return <><p>Replace saved content with this reviewed draft:</p><blockquote>{mutation.content}</blockquote></>;
  if (mutation.kind === 'document') return <JevFacts values={mutation.patch as JevValues}/>;
  if (mutation.kind === 'task_create') return <><p>Create task: {mutation.task.title}</p><p>{mutation.task.detail}</p></>;
  if (mutation.kind === 'task_update') return <JevFacts values={mutation.patch as unknown as JevValues}/>;
  return <OtherMutationSummary mutation={mutation}/>;
}

function OtherMutationSummary({ mutation }: { mutation: Extract<JevMutation, { kind: 'task_delete' | 'move' | 'vocabulary' | 'derived' }> }) {
  if (mutation.kind === 'task_delete') return <p>Delete the selected task after checking its current revision.</p>;
  if (mutation.kind === 'move') return <p>Move the source document to canvas {mutation.targetCanvasId}.</p>;
  if (mutation.kind === 'vocabulary') return <><p>{fieldLabel(mutation.operation)} {mutation.term.kind}: <strong>{mutation.term.name}</strong></p><p>{mutation.term.definition}</p>
    <p>{mutation.term.members.length} proposed members · {mutation.term.state}</p></>;
  return <JevFacts values={mutation.values}/>;
}
