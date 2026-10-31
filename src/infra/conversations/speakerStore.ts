import { join } from 'node:path';
import { opendir } from 'node:fs/promises';
import { z } from 'zod/v4';
import { ConversationActorSchema, ConversationIdSchema } from './schema.js';
import { ensurePrivateDirectory, readPrivateFileState, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';

const speakerRecordSchema = z.object({
  conversationId: ConversationIdSchema, operationId: z.uuid(), actor: ConversationActorSchema,
}).strict();
export type ConversationSpeakerRecord = z.infer<typeof speakerRecordSchema>;

export class ConversationSpeakerStore {
  constructor(private readonly configDirectory: string) {}

  write(input: ConversationSpeakerRecord): void {
    const record = speakerRecordSchema.parse(input);
    const directory = this.directory(record.conversationId);
    ensurePrivateDirectory(directory);
    writeNewPrivateFileWithMode(join(directory, `${record.operationId}.json`), JSON.stringify(record), 0o600);
  }

  async *iterate(conversationId: string): AsyncGenerator<ConversationSpeakerRecord> {
    const directory = this.directory(conversationId);
    assertSafePath(directory, true);
    if (lstatOrUndefined(directory) === undefined) return;
    for await (const entry of await opendir(directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const operationId = z.uuid().parse(entry.name.slice(0, -5));
      const file = readPrivateFileState(join(directory, entry.name));
      if (!('content' in file)) throw new Error('Speaker record disappeared');
      const record = speakerRecordSchema.parse(JSON.parse(file.content.toString('utf8')) as unknown);
      if (record.conversationId !== conversationId || record.operationId !== operationId) throw new Error('Speaker record identity mismatch');
      yield record;
    }
  }

  private directory(id: string): string {
    return join(this.configDirectory, 'conversation-speakers', ConversationIdSchema.parse(id));
  }
}
