import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { ConversationChange, ConversationTurnState, TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import type { DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { ConversationChangeSchema, StoredTurnSchema } from './eventRecord.js';
import { ConversationIdSchema, ConversationRecordSchema, type ConversationRecord } from '../conversations/schema.js';
import { FileAsyncLock } from './lock.js';
import { readPrivateFile, writePrivateFile } from './privateFile.js';

const MAX_CONVERSATION_BYTES = 4 * 1024 * 1024;
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receipt = z.object({ turn: StoredTurnSchema, change: ConversationChangeSchema, version }).strict();
const metadata = z.object({ version, receipts: z.array(receipt) }).strict().superRefine((value, context) => {
  const operations = new Set<string>();
  if (value.version !== value.receipts.length) context.addIssue({ code: 'custom', message: 'Conversation receipt count does not match version' });
  for (const [index, entry] of value.receipts.entries()) {
    if (entry.version !== index + 1 || entry.change.expectedVersion !== index || operations.has(entry.change.operationId)) {
      context.addIssue({ code: 'custom', message: 'Invalid conversation receipt sequence' });
    }
    operations.add(entry.change.operationId);
  }
});
interface StoredConversation {
  record: ConversationRecord;
  metadata: z.infer<typeof metadata>;
}

export class ConversationStateStore {
  private readonly directory: string;
  private readonly lock = new FileAsyncLock();

  constructor(configDirectory: string) { this.directory = join(configDirectory, 'conversations'); }

  private path(id: string): string { return join(this.directory, `${ConversationIdSchema.parse(id)}.json`); }

  private async load(id: string): Promise<StoredConversation | undefined> {
    const content = await readPrivateFile(this.path(id), MAX_CONVERSATION_BYTES);
    if (content === undefined) return undefined;
    const value: unknown = JSON.parse(content.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored conversation');
    const { daemonState, ...raw } = value as Record<string, unknown>;
    const record = ConversationRecordSchema.parse(raw);
    if (record.id !== id) throw new Error('Stored conversation identity mismatch');
    const state = daemonState === undefined ? { version: 0, receipts: [] } : metadata.parse(daemonState);
    if (state.receipts.some((entry) => entry.turn.conversationId !== id)) throw new Error('Conversation receipt belongs to another conversation');
    return { record, metadata: state };
  }

  private state(stored: StoredConversation): ConversationTurnState {
    const { record } = stored;
    return { version: stored.metadata.version, assignment: record.assignment,
      session: { provider: record.provider, model: record.model, sessionId: record.sessionId },
      revision: record.revision, pending: record.pending, approval: record.approval };
  }

  async read(id: string): Promise<{ record: ConversationRecord; state: ConversationTurnState } | undefined> {
    const stored = await this.load(id);
    return stored === undefined ? undefined : { record: stored.record, state: this.state(stored) };
  }

  async create(input: ConversationRecord): Promise<ConversationTurnState> {
    const record = ConversationRecordSchema.parse(input);
    return this.lock.exclusive(`${this.path(record.id)}.lock`, async () => {
      const existing = await this.load(record.id);
      if (existing !== undefined) return this.state(existing);
      const stored: StoredConversation = { record, metadata: { version: 0, receipts: [] } };
      await this.write(stored);
      return this.state(stored);
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async write(stored: StoredConversation, signal?: AbortSignal): Promise<void> {
    const content = JSON.stringify({ ...ConversationRecordSchema.parse(stored.record), daemonState: stored.metadata });
    if (Buffer.byteLength(content) > MAX_CONVERSATION_BYTES) throw new Error('Conversation exceeds storage capacity');
    await writePrivateFile(this.path(stored.record.id), content, signal);
  }

  async save(turn: TurnIdentity, input: ConversationChange, signal: AbortSignal): Promise<DaemonStateReply> {
    const identity = StoredTurnSchema.parse(turn);
    const change = ConversationChangeSchema.parse(input);
    return this.lock.exclusive(`${this.path(identity.conversationId)}.lock`, async () => {
      signal.throwIfAborted();
      const stored = await this.load(identity.conversationId);
      if (stored === undefined) return { kind: 'error', code: 'forbidden', message: 'Unknown conversation' };
      const previous = stored.metadata.receipts.find((entry) => entry.change.operationId === change.operationId);
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous.change, change) || !isDeepStrictEqual(previous.turn, identity)) {
          return { kind: 'error', code: 'forbidden', message: 'Operation ID was reused with different content or turn' };
        }
        return { kind: 'state_saved', version: previous.version, duplicate: true };
      }
      if (change.expectedVersion !== stored.metadata.version) return { kind: 'error', code: 'version_conflict', message: 'Conversation version changed' };
      const checked = ConversationRecordSchema.safeParse({ ...stored.record,
        ...(change.session === undefined ? {} : { provider: change.session.provider, model: change.session.model, sessionId: change.session.sessionId }),
        ...(change.proposal === undefined ? {} : { revision: change.proposal.revision, pending: change.proposal.pending }),
        ...(change.approval === undefined ? {} : { approval: change.approval }),
      });
      if (!checked.success) return { kind: 'error', code: 'forbidden', message: 'Conversation change violates saved assignment or proposal' };
      const nextVersion = stored.metadata.version + 1;
      if (!Number.isSafeInteger(nextVersion)) throw new Error('Conversation version exhausted');
      await this.write({ record: checked.data, metadata: { version: nextVersion,
        receipts: [...stored.metadata.receipts, { turn: identity, change, version: nextVersion }] } }, signal);
      return { kind: 'state_saved', version: nextVersion, duplicate: false };
    }, { signal, timeoutMs: 5000 });
  }

  async apply(result: TurnResult): Promise<void> {
    if (result.outcome.change === undefined) return;
    const reply = await this.save({ conversationId: result.conversationId, operationId: result.operationId, generation: result.generation },
      result.outcome.change, new AbortController().signal);
    if (reply.kind !== 'state_saved') throw new Error(`Conversation result could not be applied: ${JSON.stringify(reply)}`);
  }
}
