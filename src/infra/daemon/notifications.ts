import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { FileAsyncLock } from './lock.js';
import { ensurePrivateDirectory, readEntirePrivateFile, writePrivateFile } from './privateFile.js';

const notification = z.object({ id: z.string().min(1).max(128), message: z.string().min(1), turnOperationId: z.string().min(1).optional(),
  subject: z.object({ key: z.string().min(1), state: z.string().min(1) }).strict().optional() }).strict();
export type DirectorNotification = Pick<z.infer<typeof notification>, 'id' | 'message'>;
export type DirectorNotificationSubject = NonNullable<z.infer<typeof notification>['subject']>;
const key = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DaemonNotifications {
  private readonly directory: string;
  private readonly lock = new FileAsyncLock();
  constructor(directory: string) { this.directory = join(directory, 'director-notifications'); }

  async save(input: z.infer<typeof notification>, signal: AbortSignal): Promise<boolean> {
    const value = notification.parse(input);
    return this.lock.exclusive(join(this.directory, '.lock'), async () => {
      signal.throwIfAborted();
      const path = join(this.directory, `${key(value.id)}.json`);
      const prior = await readEntirePrivateFile(path)
        ?? (z.uuid().safeParse(value.id).success ? await readEntirePrivateFile(join(this.directory, `${value.id}.json`)) : undefined);
      if (prior !== undefined) {
        if (prior.toString('utf8') !== JSON.stringify(value)) throw new Error('Notification ID reused with different content');
        return false;
      }
      if (value.subject !== undefined) {
        for await (const saved of this.iterate()) {
          if (saved.subject?.key === value.subject.key && saved.subject.state === value.subject.state) return false;
        }
      }
      await writePrivateFile(path, JSON.stringify(value), signal);
      return true;
    }, { signal, timeoutMs: 5000 });
  }

  async *iterate() {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const content = await readEntirePrivateFile(join(this.directory, entry.name));
      if (content === undefined) throw new Error('Notification disappeared during read');
      const value = notification.parse(JSON.parse(content.toString('utf8')) as unknown);
      if (entry.name !== `${key(value.id)}.json` && entry.name !== `${z.uuid().parse(value.id)}.json`) throw new Error('Notification identity mismatch');
      yield value;
    }
  }
}
