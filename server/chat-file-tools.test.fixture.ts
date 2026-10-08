import { writeFile } from 'node:fs/promises';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { workspacePath } from './agent-workspace.js';

/** Fake model boundary; the actual canonical tools perform checkout and proposal persistence. */
export async function uploadLocalEdit(tools: StructuredToolInterface[], workdir: string, blockId: string, content: string, signal?: AbortSignal) {
  const downloaded = JSON.parse(String(await tools.find(tool => tool.name === 'download_file')!.invoke({ blockId }, { signal }))) as { savedTo: string };
  await writeFile(await workspacePath(workdir, downloaded.savedTo), content);
  return tools.find(tool => tool.name === 'upload_file')!.invoke({ sourcePath: downloaded.savedTo, mode: 'propose' }, { signal });
}
