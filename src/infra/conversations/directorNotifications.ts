import { randomUUID } from 'node:crypto';
import { opendirSync } from 'node:fs';
import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import { z } from 'zod/v4';
import { ensurePrivateDirectory, readPrivateFileState, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';

const subjectSchema = z.object({ key: z.string().min(1), state: z.string().min(1) }).strict();
const notificationSchema = z.object({ id: z.uuid(), message: z.string().min(1), subject: subjectSchema.optional() }).strict();
export type DirectorNotification = { id: string; message: string };
export type DirectorNotificationSubject = z.infer<typeof subjectSchema>;

export class DirectorNotificationStore {
  private readonly directory: string;

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, 'director-notifications');
  }

  create(message: string): DirectorNotification;
  create(message: string, subject: DirectorNotificationSubject): DirectorNotification | undefined;
  create(message: string, subject?: DirectorNotificationSubject): DirectorNotification | undefined {
    ensurePrivateDirectory(this.directory);
    if (subject !== undefined) {
      subjectSchema.parse(subject);
      const directory = opendirSync(this.directory);
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          if (!entry.name.endsWith('.json')) continue;
          const saved = this.read(z.uuid().parse(entry.name.slice(0, -5)));
          if (saved.subject?.key === subject.key && saved.subject.state === subject.state) return undefined;
        }
      } finally {
        directory.closeSync();
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const notification = notificationSchema.parse({ id: randomUUID(), message, ...(subject === undefined ? {} : { subject }) });
      const path = join(this.directory, `${notification.id}.json`);
      // Existing identities are never replaced, including a collision from the ID generator.
      assertSafePath(path, false);
      if (lstatOrUndefined(path) !== undefined) continue;
      writeNewPrivateFileWithMode(path, JSON.stringify(notification), 0o600);
      return { id: notification.id, message: notification.message };
    }
    throw new Error('Cannot allocate an unused director notification ID');
  }

  private read(id: string): z.infer<typeof notificationSchema> {
    const file = readPrivateFileState(join(this.directory, `${id}.json`));
    if (!('content' in file)) throw new Error('Director notification disappeared');
    const notification = notificationSchema.parse(JSON.parse(file.content.toString('utf8')) as unknown);
    if (notification.id !== id) throw new Error('Director notification identity mismatch');
    return notification;
  }

  async *iterate(): AsyncGenerator<DirectorNotification> {
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const id = z.uuid().parse(entry.name.slice(0, -5));
      const notification = this.read(id);
      yield { id: notification.id, message: notification.message };
    }
  }
}
