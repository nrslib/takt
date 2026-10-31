import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import { z } from 'zod/v4';
import { conversationId } from './identity.js';
import { ConversationIdSchema } from './schema.js';
import { ensurePrivateDirectory, readPrivateFileState } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { writeFileAtomic } from '../config/project/sessionStore.js';

const resultSchema = z.object({
  operationId: z.uuid(),
  conversationId: ConversationIdSchema.refine((id) => id.startsWith('manager-')),
  directorConversationId: ConversationIdSchema.refine((id) => id === conversationId({ kind: 'daemon' })),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('reply'), message: z.string() }).strict(),
    z.object({ kind: z.literal('error'), code: z.string().min(1), message: z.string() }).strict(),
  ]),
}).strict();
type DirectorMessageResult = z.infer<typeof resultSchema>;

export class DirectorMessageResultStore {
  private readonly directory: string;

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, 'director-message-results');
  }

  read(operationId: string): DirectorMessageResult | undefined {
    const path = this.path(operationId);
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return undefined;
    const file = readPrivateFileState(path);
    if (!('content' in file)) return undefined;
    const record = resultSchema.parse(JSON.parse(file.content.toString('utf8')) as unknown);
    if (record.operationId !== operationId) throw new Error('Director message result identity mismatch');
    return record;
  }

  write(value: DirectorMessageResult): void {
    const record = resultSchema.parse(value);
    const existing = this.read(record.operationId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Director message result already exists');
      return;
    }
    ensurePrivateDirectory(this.directory);
    const path = this.path(record.operationId);
    assertSafePath(path, false);
    writeFileAtomic(path, JSON.stringify(record), 0o600);
  }

  async *iterate(id: string): AsyncGenerator<DirectorMessageResult> {
    ConversationIdSchema.parse(id);
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const result = this.read(z.uuid().parse(entry.name.slice(0, -5)));
      if (result === undefined) throw new Error('Director message result disappeared');
      if (result.conversationId === id) yield result;
    }
  }

  private path(operationId: string): string {
    return join(this.directory, `${z.uuid().parse(operationId)}.json`);
  }
}
