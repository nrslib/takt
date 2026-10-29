import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import { z } from 'zod/v4';
import { ensurePrivateDirectory, readPrivateFileState, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';

const notificationSchema = z.object({ id: z.uuid(), message: z.string().min(1) }).strict();
export type DirectorNotification = z.infer<typeof notificationSchema>;

export class DirectorNotificationStore {
  private readonly directory: string;

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, 'director-notifications');
  }

  create(message: string): DirectorNotification {
    ensurePrivateDirectory(this.directory);
    for (let attempt = 0; attempt < 10; attempt++) {
      const notification = notificationSchema.parse({ id: randomUUID(), message });
      const path = join(this.directory, `${notification.id}.json`);
      // Existing identities are never replaced, including a collision from the ID generator.
      assertSafePath(path, false);
      if (lstatOrUndefined(path) !== undefined) continue;
      writeNewPrivateFileWithMode(path, JSON.stringify(notification), 0o600);
      return notification;
    }
    throw new Error('Cannot allocate an unused director notification ID');
  }

  async *iterate(): AsyncGenerator<DirectorNotification> {
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const id = z.uuid().parse(entry.name.slice(0, -5));
      const file = readPrivateFileState(join(this.directory, entry.name));
      if (!('content' in file)) throw new Error('Director notification disappeared');
      const notification = notificationSchema.parse(JSON.parse(file.content.toString('utf8')) as unknown);
      if (notification.id !== id) throw new Error('Director notification identity mismatch');
      yield notification;
    }
  }
}
