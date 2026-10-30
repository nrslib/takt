import { isAbsolute, join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { readPrivateFileState } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';
import { writeFileAtomic } from '../config/project/sessionStore.js';
import { ConversationIdSchema, ConversationRecordSchema, type ConversationAssignment, type ConversationRecord } from './schema.js';
import { conversationId, conversationIdentity } from './identity.js';

export class ConversationStore {
  private readonly directory: string;

  constructor(configDirectory: string) {
    if (!isAbsolute(configDirectory)) throw new Error('Conversation configuration directory must be absolute');
    this.directory = join(configDirectory, 'conversations');
  }

  read(id: string, assignment: ConversationAssignment): ConversationRecord | undefined {
    const path = this.path(id);
    if (id !== conversationId(assignment)) throw new Error('Conversation identity does not match requested assignment');
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return undefined;
    const snapshot = readPrivateFileState(path);
    if (!('content' in snapshot)) return undefined;
    const record = ConversationRecordSchema.parse(JSON.parse(snapshot.content.toString('utf8')) as unknown);
    if (record.id !== id || JSON.stringify(conversationIdentity(record.assignment)) !== JSON.stringify(conversationIdentity(assignment))) {
      throw new Error('Stored conversation does not match requested identity');
    }
    return record;
  }

  write(value: ConversationRecord): void {
    const record = ConversationRecordSchema.parse(value);
    assertSafePath(this.directory, true);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
    const path = this.path(record.id);
    assertSafePath(path, false);
    writeFileAtomic(path, JSON.stringify(record), 0o600);
  }

  async *iterate(): AsyncGenerator<ConversationRecord> {
    assertSafePath(this.directory, true);
    if (lstatOrUndefined(this.directory) === undefined) return;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const id = ConversationIdSchema.parse(entry.name.slice(0, -5));
      const file = readPrivateFileState(this.path(id));
      if (!('content' in file)) throw new Error('Conversation disappeared during recovery');
      const record = ConversationRecordSchema.parse(JSON.parse(file.content.toString('utf8')) as unknown);
      if (record.id !== id) throw new Error('Stored conversation identity mismatch');
      yield record;
    }
  }

  private path(id: string): string {
    return join(this.directory, `${ConversationIdSchema.parse(id)}.json`);
  }
}
