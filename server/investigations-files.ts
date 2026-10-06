import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { id, parseSaved } from './investigations-schema.js';
import type { SavedInvestigation } from './investigations-types.js';

async function readRecord(file: string): Promise<unknown> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Investigation not found');
    throw error;
  }
  try { return JSON.parse(raw); }
  catch { throw new ApiError(500, 'Saved investigation is invalid'); }
}

export class InvestigationFiles {
  constructor(private readonly root: string) {}

  file(recordId: string): string {
    if (!id.safeParse(recordId).success) throw new ApiError(400, 'Invalid investigation ID');
    return path.join(this.root, 'investigations', `${recordId}.json`);
  }

  async read(recordId: string): Promise<SavedInvestigation> {
    return parseSaved(await readRecord(this.file(recordId)), recordId);
  }

  async save(saved: SavedInvestigation): Promise<void> {
    const file = this.file(saved.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } finally { await rm(temporary, { force: true }); }
  }

  async list(): Promise<SavedInvestigation[]> {
    let files: string[];
    try { files = await readdir(path.join(this.root, 'investigations')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(files.filter(file => /^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(file))
      .map(file => this.read(file.slice(0, -5))));
  }

  async delete(recordId: string): Promise<void> { await rm(this.file(recordId)); }
}
