import { join } from 'node:path';
import { opendir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { ConversationChange, ConversationTurnState, TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import type { DaemonStateReply } from '../../core/daemon/processProtocol.js';
import { ConversationChangeSchema, StoredTurnSchema } from './eventRecord.js';
import { ApprovalSchema, ConversationAgentOverridesSchema, ConversationIdSchema, ConversationRecordSchema,
  PendingSummarySchema, type ConversationRecord } from '../conversations/schema.js';
import { FileAsyncLock } from './lock.js';
import { appendPrivateFile, ensurePrivateDirectory, readEntirePrivateFile, writePrivateFile } from './privateFile.js';
import { ToolActivityEntrySchema, ToolActivityTurnStateSchema } from '../../shared/tool-activity/schema.js';
import type { ToolActivityEntry, ToolActivityTurnState } from '../../shared/tool-activity/types.js';

const MAX_RECEIPTS = 32;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const id = z.string().min(1).max(128);
const text = z.string();
const messageDigest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptChange = z.object({
  operationId: id, expectedVersion: version,
  session: z.object({ provider: id, model: text.nullable(), sessionId: text.nullable(), contextKey: id.optional(),
    agentOverrides: ConversationAgentOverridesSchema.optional() }).strict().optional(),
  proposal: z.object({ revision: version, pending: PendingSummarySchema.nullable() }).strict().optional(),
  approval: ApprovalSchema.nullable().optional(),
  interruptedMessageDigest: messageDigest.nullable().optional(),
}).strict().refine((value) => value.session !== undefined || value.proposal !== undefined || value.approval !== undefined
  || value.interruptedMessageDigest !== undefined);
const receipt = z.union([
  // 既存 receipt は中断本文をそのまま保持する形式で読み込む。
  z.object({ turn: StoredTurnSchema, change: ConversationChangeSchema, version }).strict(),
  z.object({ turn: StoredTurnSchema, change: receiptChange, version }).strict(),
]);
// ツール履歴を会話ファイルに持っていた形式も読めるようにする。その履歴は使わず、次の保存で消える。
const metadata = z.object({ version, receipts: z.array(receipt), toolHistory: z.unknown().optional() }).strict().superRefine((value, context) => {
  const operations = new Set<string>();
  if (value.version < value.receipts.length) context.addIssue({ code: 'custom', message: 'Conversation receipt count does not match version' });
  for (const [index, entry] of value.receipts.entries()) {
    if (entry.version !== value.version - value.receipts.length + index + 1 || entry.change.expectedVersion !== entry.version - 1 || operations.has(entry.change.operationId)) {
      context.addIssue({ code: 'custom', message: 'Invalid conversation receipt sequence' });
    }
    operations.add(entry.change.operationId);
  }
});
type StoredMetadata = Omit<z.infer<typeof metadata>, 'toolHistory'>;
interface StoredConversation {
  record: ConversationRecord;
  metadata: StoredMetadata;
}
// ツール履歴ファイルは 1 行 1 記録。ターンの開始、変わった entry、確定の順に並ぶ。
// 以前は change にイベント ID も書いていた。そのファイルも読めるようにし、イベント ID は使わない。
const toolHistoryRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), operationId: id, generation: version }).strict(),
  z.object({ kind: z.literal('change'), eventIds: z.array(id).optional(), sequence: version, entries: z.array(ToolActivityEntrySchema) }).strict(),
  z.object({ kind: z.literal('finished') }).strict(),
]);
type ToolHistoryRecord = z.infer<typeof toolHistoryRecord>;

function receiptChangeFor(change: ConversationChange): z.infer<typeof receiptChange> | ConversationChange {
  const { interruptedMessage, ...fields } = change;
  if (interruptedMessage === undefined) return change;
  return { ...fields, interruptedMessageDigest: interruptedMessage === null ? null
    : createHash('sha256').update(interruptedMessage).digest('hex') };
}

function receiptMatches(entry: z.infer<typeof receipt>, turn: TurnIdentity, change: ConversationChange): boolean {
  if (!isDeepStrictEqual(entry.turn, turn)) return false;
  if ('interruptedMessageDigest' in entry.change) {
    return isDeepStrictEqual(entry.change, receiptChangeFor(change));
  }
  return isDeepStrictEqual(entry.change, change);
}

export class ConversationStateStore {
  private readonly directory: string;
  private readonly toolHistoryDirectory: string;
  private readonly lock = new FileAsyncLock();

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, 'conversations');
    this.toolHistoryDirectory = join(configDirectory, 'conversation-tool-history');
  }

  private path(id: string): string { return join(this.directory, `${ConversationIdSchema.parse(id)}.json`); }

  private toolHistoryPath(id: string): string { return join(this.toolHistoryDirectory, `${ConversationIdSchema.parse(id)}.jsonl`); }

  private async load(id: string): Promise<StoredConversation | undefined> {
    const content = await readEntirePrivateFile(this.path(id));
    if (content === undefined) return undefined;
    const value: unknown = JSON.parse(content.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored conversation');
    const { daemonState, ...raw } = value as Record<string, unknown>;
    const record = ConversationRecordSchema.parse(raw);
    if (record.id !== id) throw new Error('Stored conversation identity mismatch');
    const parsed = daemonState === undefined ? { version: 0, receipts: [] } : metadata.parse(daemonState);
    if (parsed.receipts.some((entry) => entry.turn.conversationId !== id)) throw new Error('Conversation receipt belongs to another conversation');
    return { record, metadata: { version: parsed.version, receipts: parsed.receipts } };
  }

  private state(stored: StoredConversation): ConversationTurnState {
    const { record } = stored;
    return { version: stored.metadata.version, assignment: record.assignment,
      session: { provider: record.provider, model: record.model, sessionId: record.sessionId,
        ...(record.contextKey === undefined ? {} : { contextKey: record.contextKey }),
        ...(record.agentOverrides === undefined ? {} : { agentOverrides: record.agentOverrides }) },
      revision: record.revision, pending: record.pending, approval: record.approval,
      ...(record.interruptedMessage === undefined ? {} : { interruptedMessage: record.interruptedMessage }) };
  }

  async read(id: string): Promise<{ record: ConversationRecord; state: ConversationTurnState } | undefined> {
    const stored = await this.load(id);
    return stored === undefined ? undefined : { record: stored.record, state: this.state(stored) };
  }

  async readToolHistory(id: string): Promise<ToolActivityTurnState | undefined> {
    const content = await readEntirePrivateFile(this.toolHistoryPath(id));
    if (content === undefined) return undefined;
    const lines = content.toString('utf8').split('\n');
    // 改行で終わっていない最後の行は、追記の途中で止まった記録なので読まない。
    lines.pop();
    const [header, ...records] = lines.map((line) => toolHistoryRecord.parse(JSON.parse(line)));
    if (header?.kind !== 'turn') throw new Error('Tool history file does not start with its turn');
    const entries = new Map<string, ToolActivityEntry>();
    let sequence = 0;
    let finished = false;
    for (const record of records) {
      if (record.kind === 'turn' || finished) throw new Error('Invalid tool history record order');
      if (record.kind === 'finished') { finished = true; continue; }
      sequence = record.sequence;
      for (const entry of record.entries) entries.set(entry.key, entry);
    }
    return ToolActivityTurnStateSchema.parse({ operationId: header.operationId, generation: header.generation, finished,
      history: { entries: [...entries.values()], sequence } });
  }

  /** 新しいターンの履歴を始める。前のターンの履歴は置き換わる。 */
  async startToolHistory(turn: TurnIdentity): Promise<void> {
    const record: ToolHistoryRecord = { kind: 'turn', operationId: turn.operationId, generation: turn.generation };
    await writePrivateFile(this.toolHistoryPath(turn.conversationId), `${JSON.stringify(record)}\n`);
  }

  /** startToolHistory 後の変更を、履歴全体を読み書きせずに追記する。 */
  async appendToolHistory(conversationId: string, change: { sequence: number; entries: ToolActivityEntry[] }): Promise<void> {
    const record: ToolHistoryRecord = { kind: 'change', sequence: change.sequence, entries: change.entries };
    await appendPrivateFile(this.toolHistoryPath(conversationId), `${JSON.stringify(record)}\n`);
  }

  /** 確定した履歴で、追記してきたファイルを置き換える。 */
  async writeToolHistory(conversationId: string, state: ToolActivityTurnState): Promise<void> {
    const saved = ToolActivityTurnStateSchema.parse(state);
    const records: ToolHistoryRecord[] = [
      { kind: 'turn', operationId: saved.operationId, generation: saved.generation },
      { kind: 'change', sequence: saved.history.sequence, entries: saved.history.entries },
      ...(saved.finished ? [{ kind: 'finished' as const }] : []),
    ];
    await writePrivateFile(this.toolHistoryPath(conversationId), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  }

  async removeToolHistory(conversationId: string): Promise<void> {
    await rm(this.toolHistoryPath(conversationId), { force: true });
  }

  async *iterate(): AsyncGenerator<ConversationRecord> {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const stored = await this.load(ConversationIdSchema.parse(entry.name.slice(0, -5)));
      if (stored === undefined) throw new Error('Conversation disappeared during recovery');
      yield stored.record;
    }
  }

  async retireLegacy(id: string, operationId: string | null): Promise<void> {
    await this.lock.exclusive(`${this.path(id)}.lock`, async () => {
      const stored = await this.load(id);
      if (stored === undefined) throw new Error('Unknown legacy conversation');
      stored.record = { ...stored.record, running: operationId === null ? null : stored.record.running, directorMessages: operationId === null ? stored.record.directorMessages
        : stored.record.directorMessages?.filter((message) => message.operationId !== operationId) };
      await this.write(stored);
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
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
    await writePrivateFile(this.path(stored.record.id), content, signal);
  }

  async save(turn: TurnIdentity, input: ConversationChange, signal: AbortSignal): Promise<DaemonStateReply> {
    return this.saveChange(turn, input, signal, false);
  }

  private async saveChange(turn: TurnIdentity, input: ConversationChange, signal: AbortSignal, rebaseInterrupted: boolean): Promise<DaemonStateReply> {
    const identity = StoredTurnSchema.parse(turn);
    const change = ConversationChangeSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    let committed: Extract<DaemonStateReply, { kind: 'state_saved' }> | undefined;
    try {
      return await this.lock.exclusive(`${this.path(identity.conversationId)}.lock`, async () => {
        signal.throwIfAborted();
        const stored = await this.load(identity.conversationId);
        if (stored === undefined) return { kind: 'error', code: 'forbidden', message: 'Unknown conversation' };
        const previous = stored.metadata.receipts.find((entry) => entry.change.operationId === change.operationId);
        if (previous !== undefined) {
          if (rebaseInterrupted && change.expectedVersion < previous.change.expectedVersion) change.expectedVersion = previous.change.expectedVersion;
          if (!receiptMatches(previous, identity, change)) {
            return { kind: 'error', code: 'forbidden', message: 'Operation ID was reused with different content or turn' };
          }
          return committed = { kind: 'state_saved', version: previous.version, duplicate: true };
        }
        // 中断時は、確定後に子へ届かなかった保存の版へ後片付けを載せ直す。
        if (rebaseInterrupted && change.expectedVersion < stored.metadata.version) change.expectedVersion = stored.metadata.version;
        if (change.expectedVersion !== stored.metadata.version) return { kind: 'error', code: 'version_conflict', message: 'Conversation version changed' };
        const checked = ConversationRecordSchema.safeParse({ ...stored.record,
          ...(change.session === undefined ? {} : { provider: change.session.provider, model: change.session.model, sessionId: change.session.sessionId,
            contextKey: change.session.contextKey, agentOverrides: change.session.agentOverrides }),
          ...(change.proposal === undefined ? {} : { revision: change.proposal.revision, pending: change.proposal.pending }),
          ...(change.approval === undefined ? {} : { approval: change.approval }),
          ...(change.interruptedMessage === undefined ? {} : { interruptedMessage: change.interruptedMessage }),
        });
        if (!checked.success) return { kind: 'error', code: 'forbidden', message: 'Conversation change violates saved assignment or proposal' };
        const nextVersion = stored.metadata.version + 1;
        if (!Number.isSafeInteger(nextVersion)) throw new Error('Conversation version exhausted');
        // 中断本文は会話レコードに保存済みのため、receipt ではダイジェストだけを保持する。
        const savedChange = receiptChangeFor(change);
        const receipts = [...stored.metadata.receipts, { turn: identity, change: savedChange, version: nextVersion }].slice(-MAX_RECEIPTS);
        while (receipts.length > 1 && Buffer.byteLength(JSON.stringify(receipts)) > MAX_RECEIPT_BYTES) receipts.shift();
        await this.write({ record: checked.data, metadata: { version: nextVersion,
          receipts } }, signal);
        return committed = { kind: 'state_saved', version: nextVersion, duplicate: false };
      }, { signal, timeoutMs: 5000 });
    } catch (error) {
      // 公開が完了した保存を、その後の取消によって未確定へ戻さない。
      if (committed !== undefined && signal.aborted && error === signal.reason) return committed;
      throw error;
    }
  }

  async apply(result: TurnResult): Promise<void> {
    if (result.outcome.change === undefined) return;
    const reply = await this.saveChange({ conversationId: result.conversationId, operationId: result.operationId, generation: result.generation },
      result.outcome.change, new AbortController().signal, result.outcome.kind === 'interrupted');
    if (reply.kind !== 'state_saved') throw new Error(`Conversation result could not be applied: ${JSON.stringify(reply)}`);
  }
}
