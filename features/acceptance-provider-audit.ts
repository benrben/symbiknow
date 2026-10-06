import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { acceptanceReflexProvider } from './acceptance-reflex-provider.js';

/** Observe the real SDK boundary in an isolated synthetic fixture; omit headers and provider credentials. */
export function auditedReflexProvider(dataDir: string): typeof fetch {
  return async (url, options) => {
    const input = JSON.parse(String(options?.body)) as { model: string; state: unknown; questions: unknown };
    try {
      await appendFile(path.join(dataDir, 'reflex-provider-requests.jsonl'),
        JSON.stringify({ model: input.model, state: input.state, questions: input.questions }) + '\n');
    } catch (error) { throw new Error('Native acceptance provider request audit could not be saved', { cause: error }); }
    return acceptanceReflexProvider(url, options);
  };
}
