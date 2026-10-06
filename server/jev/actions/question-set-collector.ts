import type { JevAnswer, JevDecider, JevQuestion } from '../../jev.js';

export interface JevQuestionSet { state: Record<string, unknown>; questions: Record<string, JevQuestion> }
type Answers = Record<string, JevAnswer>;
type Pending = { set: JevQuestionSet; resolve: (answers: Answers) => void; reject: (error: unknown) => void };
const collectors = new WeakSet<JevDecider>();

function rejectCollectedRequests(batch: Pending[], error: unknown): void {
  batch.forEach(item => item.reject(error));
}

export function isQuestionSetCollector(decider: JevDecider | undefined): decider is JevDecider {
  return decider !== undefined && collectors.has(decider);
}

/** Collect one independent wave without changing callers' original question and source identities. */
export function questionSetCollector(run: (sets: JevQuestionSet[]) => Promise<Answers[]>,
  schedule: (flush: () => void) => void = queueMicrotask): JevDecider {
  const pending: Pending[] = [];
  let scheduled = false;
  async function flush(): Promise<void> {
    scheduled = false;
    const batch = pending.splice(0);
    try {
      const answers = await run(batch.map(item => item.set));
      batch.forEach((item, index) => item.resolve(answers[index]));
    } catch (error) { rejectCollectedRequests(batch, error); }
  }
  const decider: JevDecider = (_key, state, questions) => new Promise((resolve, reject) => {
    pending.push({ set: { state: state as Record<string, unknown>, questions }, resolve, reject });
    if (scheduled) return;
    scheduled = true;
    schedule(() => { void flush(); });
  });
  collectors.add(decider);
  return decider;
}
