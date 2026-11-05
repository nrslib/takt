import { join } from 'node:path';
import { EventInputSchema } from './eventRecord.js';
import { z } from 'zod/v4';
import type { WatchRecord, WatchRecordStore } from '../../features/daemon/watchers/observations.js';
import { readPrivateFile, writePrivateFile } from './privateFile.js';

const record = z.object({ retry: z.object({
  attempts: z.number().int().nonnegative(), lastAttemptAt: z.iso.datetime(), limitNotified: z.boolean().optional(),
}).strict().optional(), episode: z.number().int().positive(), active: z.boolean(), accepted: z.boolean(), input: EventInputSchema.nullable() }).strict();

export class FileWatchRecords implements WatchRecordStore {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid watch record key');
    return join(this.directory, 'daemon-watches', `${key}.json`);
  }
  async read(key: string): Promise<WatchRecord | undefined> {
    const bytes = await readPrivateFile(this.path(key), 1024 * 1024);
    return bytes === undefined ? undefined : record.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  }
  async write(key: string, value: WatchRecord): Promise<void> { await writePrivateFile(this.path(key), JSON.stringify(record.parse(value))); }
}
