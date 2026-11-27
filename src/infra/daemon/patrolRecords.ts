import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { PatrolRecordStore } from '../../features/daemon/patrols.js';
import { readPrivateFile, writePrivateFile } from './privateFile.js';

const record = z.object({ lastQueued: z.number().int().nonnegative() }).strict();

export class FilePatrolRecords implements PatrolRecordStore {
  constructor(private readonly directory: string) {}

  private path(repositoryDirectory: string): string {
    const key = createHash('sha256').update(repositoryDirectory).digest('hex');
    return join(this.directory, 'daemon-patrols', `${key}.json`);
  }

  async read(repositoryDirectory: string): Promise<number | undefined> {
    const bytes = await readPrivateFile(this.path(repositoryDirectory), 16 * 1024);
    if (bytes === undefined) return undefined;
    const input: unknown = JSON.parse(bytes.toString('utf8'));
    return record.parse(input).lastQueued;
  }

  async write(repositoryDirectory: string, lastQueued: number): Promise<void> {
    await writePrivateFile(this.path(repositoryDirectory), JSON.stringify(record.parse({ lastQueued })));
  }
}
