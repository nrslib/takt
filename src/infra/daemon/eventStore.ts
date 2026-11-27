import { createHash } from 'node:crypto';
import { lstat, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AcceptedEvent } from '../../core/daemon/events.js';
import { MAX_DIRECTOR_MANAGER_REPLIES, MAX_DIRECTOR_MANAGER_REPLY_CONTEXT_BYTES,
  type DirectorManagerReply, type TurnIdentity, type TurnResult } from '../../core/daemon/messages.js';
import type { ConversationTurns, EventStore, StoredEvent } from '../../core/daemon/ports.js';
import { CLEAR_COMMAND } from '../../features/manager/conversationCommands.js';
import { truncateUtf8WithMarker } from '../../shared/utils/text.js';
import { conversationId as idForAssignment } from '../conversations/identity.js';
import type { ConversationAssignment } from '../conversations/schema.js';
import { AcceptedEventSchema, EventRecordSchema, EventRecordWriteSchema, isRetiredWatchEvent, storedStandaloneInboxAnswer, TurnResultSchema, StoredTurnSchema, type EventRecord } from './eventRecord.js';
import { ensurePrivateDirectory, hasCode, readEntirePrivateFile, writePrivateFile } from './privateFile.js';
import { FileAsyncLock } from './lock.js';
import { ConversationStateStore } from './conversationStateStore.js';
import { DaemonPersistedFiles } from './persistedFiles.js';
import type { DaemonNotifications } from './notifications.js';

const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');
const requestKey = (event: AcceptedEvent): string => JSON.stringify([event.conversationId, event.requestId]);
const directorId = idForAssignment({ kind: 'daemon' });
const MAX_REQUEST_EXCERPT_BYTES = 384;
const omittedBytesMarker = (bytes: number): string => `\n[TRUNCATED: ${bytes} bytes omitted]`;
const REPLY_TRUNCATION_MARKER = '\n[TRUNCATED]';
const jsonStringContentBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value)) - 2;

function excerptForJson(text: string, budget: number): string | undefined {
  const markerBytes = jsonStringContentBytes(REPLY_TRUNCATION_MARKER);
  let bytes = 0;
  let offset = 0;
  let excerptEnd = 0;
  for (const character of text) {
    bytes += jsonStringContentBytes(character);
    if (bytes > budget) return budget < markerBytes ? undefined : text.slice(0, excerptEnd) + REPLY_TRUNCATION_MARKER;
    offset += character.length;
    if (bytes + markerBytes <= budget) excerptEnd = offset;
  }
  return text;
}

function isDirectorClear(event: AcceptedEvent): boolean {
  return event.conversationId === directorId && event.event.kind === 'human_command'
    && event.event.command.kind === 'message' && event.event.command.text.trim() === CLEAR_COMMAND;
}

function isDirectorDelegation(event: AcceptedEvent): event is AcceptedEvent & { event: Extract<AcceptedEvent['event'], { kind: 'director_message' }> } {
  return event.source === 'director' && event.event.kind === 'director_message'
    && event.event.inquiryAnswer === undefined && event.event.directorConversationId === directorId && event.conversationId !== directorId;
}

export class FileEventStore implements EventStore, ConversationTurns {
  private readonly directory: string;
  private readonly ids = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private readonly sequences = new Map<number, string>();
  private readonly byConversation = new Map<string, Map<string, string>>();
  private readonly directorContext = new Map<number, { path: string; kind: 'delegation'; operationId: string } | { path: string; kind: 'clear' }>();
  private readonly knownFiles = new Set<string>();
  private readonly lock = new FileAsyncLock();
  private readonly conversations: ConversationStateStore;
  private readonly files: DaemonPersistedFiles;
  private lastSequence = 0;

  constructor(configDirectory: string, private readonly routing?: {
    permits(assignment: ConversationAssignment, id: string): Promise<boolean>;
  }) {
    this.directory = join(configDirectory, 'daemon-events');
    this.conversations = new ConversationStateStore(configDirectory);
    this.files = new DaemonPersistedFiles(configDirectory);
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock.exclusive(join(this.directory, '.lock'), action, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async read(path: string): Promise<EventRecord> {
    const record = await this.readStored(path);
    if (record === undefined) throw new Error(`Missing stored event: ${path}`);
    return record;
  }

  // The rollback in accept() unlinks after releasing the lock, so a file
  // another instance has just confirmed in refresh() can still disappear
  // before it is read. Callers that iterate stored events tolerate the
  // disappearance through this variant instead of failing the whole read.
  private async readStored(path: string): Promise<EventRecord | undefined> {
    const content = await readEntirePrivateFile(path);
    if (content === undefined) return undefined;
    const input: unknown = JSON.parse(content.toString('utf8'));
    const record = EventRecordSchema.parse(input);
    if (path !== this.path(record.event.eventId)) throw new Error('Stored event identity mismatch');
    if (record.state === 'running') this.assertTurn(record.event, record.turn);
    if (record.state === 'settling' || record.state === 'settled') this.assertResult(record.event, record.result);
    const event = await this.restoreStandaloneInboxAnswer(record.event);
    if (record.state === 'settling' || record.state === 'settled') return { ...record, event, result: { ...record.result, event } };
    return { ...record, event };
  }

  private async restoreStandaloneInboxAnswer(saved: AcceptedEvent): Promise<AcceptedEvent> {
    const answer = storedStandaloneInboxAnswer(saved);
    if (answer === undefined || saved.event.kind !== 'director_message' || this.routing === undefined) return saved;
    const savedAssignment = (await this.conversations.read(saved.conversationId))?.state.assignment;
    if (savedAssignment === undefined || savedAssignment.kind === 'daemon') return saved;
    const repositories = savedAssignment.kind === 'repository' ? [savedAssignment.repositoryDirectory]
      : await this.files.readWorkspaceRepositories(savedAssignment.workspaceId);
    // 保存済み assignment は探索候補であり、現在の配送先を保証しない。
    for (const repository of repositories) {
      let inboxDirectory: string;
      try {
        if (!await this.routing.permits({ kind: 'repository', repositoryDirectory: repository }, saved.conversationId)) continue;
        inboxDirectory = await this.files.inboxDirectory(repository);
      } catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
      const expected = `standalone-answer-${createHash('sha256').update(JSON.stringify([inboxDirectory, answer.questionId])).digest('hex')}`;
      // 旧 inbox の createdAt は回答日時とは別に採番される。
      if (saved.eventId === expected) return { ...saved, event: { ...saved.event, inquiryAnswer: answer } };
    }
    return saved;
  }

  private path(eventId: string): string { return join(this.directory, `${fileKey(eventId)}.json`); }

  private index(record: EventRecord, path: string): void {
    const { event } = record;
    const request = requestKey(event);
    const previous = this.requests.get(request);
    const sequence = this.sequences.get(event.acceptedSequence);
    if (previous !== undefined && previous !== path || sequence !== undefined && sequence !== event.eventId) throw new Error('Conflicting stored event index');
    this.ids.set(event.eventId, path);
    this.requests.set(request, path);
    this.sequences.set(event.acceptedSequence, event.eventId);
    let conversation = this.byConversation.get(event.conversationId);
    if (conversation === undefined) {
      conversation = new Map<string, string>();
      this.byConversation.set(event.conversationId, conversation);
    }
    conversation.set(event.eventId, path);
    if (isDirectorDelegation(event)) this.directorContext.set(event.acceptedSequence, { path, kind: 'delegation', operationId: event.operationId });
    else if (isDirectorClear(event)) this.directorContext.set(event.acceptedSequence, { path, kind: 'clear' });
    this.lastSequence = Math.max(this.lastSequence, event.acceptedSequence);
    this.knownFiles.add(path);
  }

  readTurns(conversationId: string): ReturnType<ConversationTurns['readTurns']> {
    return this.exclusive(async () => {
      await this.refresh();
      const turns: Awaited<ReturnType<ConversationTurns['readTurns']>>[number][] = [];
      // Completed turns and background-turn order must survive missed live
      // delivery. Read the durable events of this conversation through the
      // index that refresh() and accept() maintain, instead of reading every
      // event file in the shared directory on every call.
      const paths = this.byConversation.get(conversationId);
      if (paths === undefined) return turns;
      for (const path of [...paths.values()]) {
        const record = await this.readStored(path);
        if (record === undefined) {
          this.forget(path);
          continue;
        }
        const { event } = record;
        const message = event.event.kind === 'human_command' && event.event.command.kind === 'message'
          && event.event.command.display !== false ? event.event.command.text : undefined;
        turns.push({ operationId: event.operationId, ...(message === undefined ? {} : { message }),
          acceptedSequence: event.acceptedSequence, pending: record.state === 'queued',
          ...(record.state === 'settled' ? { outcome: record.result.outcome } : {}) });
      }
      return turns.sort((left, right) => left.acceptedSequence - right.acceptedSequence);
    });
  }

  readDirectorManagerReplies(notifications: DaemonNotifications): Promise<readonly DirectorManagerReply[]> {
    return this.exclusive(async () => {
      await this.refresh();
      const replies: DirectorManagerReply[] = [];
      for (const path of await this.directorReplyPaths(notifications)) {
        const record = await this.readStored(path);
        if (record === undefined) {
          this.forget(path);
          continue;
        }
        // A reply can be visible from apply() before its event is marked settled.
        if (record.state !== 'settling' && record.state !== 'settled') continue;
        const { event, result: { outcome } } = record;
        if (outcome.kind !== 'completed' || outcome.result.kind !== 'reply' || !isDirectorDelegation(event)) continue;
        const reply = { managerId: event.conversationId, operationId: event.operationId, requestedAt: event.occurredAt,
          request: truncateUtf8WithMarker(event.event.text, MAX_REQUEST_EXCERPT_BYTES, omittedBytesMarker),
          reply: '' };
        const remaining = MAX_DIRECTOR_MANAGER_REPLY_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify([...replies, reply]));
        if (remaining <= 0) break;
        const excerpt = excerptForJson(outcome.result.message, remaining);
        if (excerpt === undefined) break;
        replies.push({ ...reply, reply: excerpt });
        if (replies.length === MAX_DIRECTOR_MANAGER_REPLIES) break;
      }
      return replies;
    });
  }

  private async directorReplyPaths(notifications: DaemonNotifications): Promise<string[]> {
    const candidates: Array<{ path: string; sequence: number; publishedAt: bigint }> = [];
    let clearedAt = await notifications.directorContextClearedAt();
    for (const [sequence, candidate] of [...this.directorContext].sort(([left], [right]) => right - left)) {
      const { path } = candidate;
      if (candidate.kind === 'clear') {
        if (clearedAt !== undefined) continue;
        // Older clears have only the durable event timestamp.
        const record = await this.readStored(path);
        if (record === undefined) this.forget(path);
        else if (record.state === 'settled' && record.result.outcome.kind === 'completed' && record.result.outcome.result.kind === 'notice') {
          clearedAt = (await lstat(path, { bigint: true })).mtimeNs;
        }
        continue;
      }
      // The reply can become visible in a different order from request admission or event settlement.
      const publishedAt = await notifications.managerResultPublishedAt(candidate.operationId);
      if (publishedAt !== undefined) candidates.push({ path, sequence, publishedAt });
    }
    return candidates.filter(({ publishedAt }) => clearedAt === undefined || publishedAt > clearedAt)
      .sort((left, right) => Number(right.publishedAt - left.publishedAt) || right.sequence - left.sequence).map(({ path }) => path);
  }

  private async refresh(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const present = new Set<string>();
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      present.add(join(this.directory, entry.name));
    }
    // A file another instance indexed can disappear afterwards (the
    // rollback in accept() unlinks after releasing the lock). Drop index
    // entries whose file is gone before registering new files: a new
    // event may reuse the vanished event's sequence or request key, and
    // registering it against the stale entry would throw a conflict.
    for (const path of this.knownFiles) {
      if (!present.has(path)) this.forget(path);
    }
    for (const path of present) {
      if (!this.knownFiles.has(path)) {
        const record = await this.readStored(path);
        if (record === undefined) continue;
        this.index(record, path);
      }
    }
  }

  private forget(path: string): void {
    this.knownFiles.delete(path);
    const removedIds = new Set<string>();
    for (const [eventId, candidate] of this.ids) {
      if (candidate === path) {
        this.ids.delete(eventId);
        removedIds.add(eventId);
      }
    }
    for (const [request, candidate] of this.requests) {
      if (candidate === path) this.requests.delete(request);
    }
    if (removedIds.size === 0) return;
    for (const [sequence, eventId] of this.sequences) {
      if (!removedIds.has(eventId)) continue;
      this.sequences.delete(sequence);
      this.directorContext.delete(sequence);
    }
    for (const [conversationId, conversation] of this.byConversation) {
      for (const eventId of removedIds) conversation.delete(eventId);
      if (conversation.size === 0) this.byConversation.delete(conversationId);
    }
  }

  private async write(record: EventRecord): Promise<void> {
    await writePrivateFile(this.path(record.event.eventId), JSON.stringify(EventRecordWriteSchema.parse(record)));
  }

  async accept(input: AcceptedEvent): ReturnType<EventStore['accept']> {
    // 呼出し元が await 中に変更しても、受付内容は変えない。
    const event = AcceptedEventSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    let writing = false;
    try {
      return await this.exclusive(async () => {
        await this.refresh();
        const path = this.ids.get(event.eventId) ?? this.requests.get(requestKey(event));
        if (path !== undefined) {
          const stored = await this.read(path);
          // 廃止した待機・実行中イベントを duplicate 経由で再びキューへ戻さない。
          const state = isRetiredWatchEvent(stored.event) && stored.state !== 'settling' ? 'settled' : stored.state;
          return { kind: 'duplicate', event: stored.event, state };
        }
        const record: EventRecord = { state: 'queued', event };
        const sequence = this.sequences.get(event.acceptedSequence);
        if (sequence !== undefined) throw new Error('Accepted sequence is already stored');
        writing = true;
        await this.write(record);
        this.index(record, this.path(event.eventId));
        return { kind: 'stored' };
      });
    } catch (error) {
      if (writing) {
        // 保存後の応答・ロック解放の失敗でも、拒否した発言を復元させない。
        await unlink(this.path(event.eventId)).catch((cleanup: unknown) => { if (!hasCode(cleanup, 'ENOENT')) throw cleanup; });
        this.forget(this.path(event.eventId));
      }
      throw error;
    }
  }

  private assertTurn(event: AcceptedEvent, turn: TurnIdentity): void {
    StoredTurnSchema.parse({ conversationId: turn.conversationId, operationId: turn.operationId, generation: turn.generation });
    if (event.conversationId !== turn.conversationId || event.operationId !== turn.operationId) throw new Error('Turn does not match stored event');
  }

  private assertResult(event: AcceptedEvent, result: TurnResult): void {
    this.assertTurn(event, result);
    if (!isDeepStrictEqual(event, result.event)) throw new Error('Result does not match stored event');
  }

  async markStarted(eventId: string, turn: TurnIdentity): Promise<void> {
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      this.assertTurn(record.event, turn);
      if (record.state !== 'queued') {
        const stored = record.state === 'running' ? record.turn : record.result;
        if (stored.generation !== turn.generation) throw new Error('Conflicting started turn');
        return;
      }
      await this.write({ state: 'running', event: record.event, turn: { conversationId: turn.conversationId, operationId: turn.operationId, generation: turn.generation } });
    });
  }

  async saveResult(eventId: string, input: TurnResult): Promise<void> {
    const result = TurnResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      this.assertResult(record.event, result);
      if (record.state === 'settling' || record.state === 'settled') {
        if (!isDeepStrictEqual(record.result, result)) throw new Error('Conflicting stored result');
        return;
      }
      if (record.state !== 'running' || record.turn.generation !== result.generation) throw new Error('Result has no matching running turn');
      await this.write({ state: 'settling', event: record.event, result });
    });
  }

  async markSettled(eventId: string, input: TurnResult): Promise<void> {
    const result = TurnResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      if (result.outcome.kind === 'deferred' && record.state === 'queued' && isDeepStrictEqual(record.event, result.event)) return;
      if (record.state !== 'settling' && record.state !== 'settled' || !isDeepStrictEqual(record.result, result)) throw new Error('Result was not saved before settlement');
      if (record.state === 'settling') await this.write(result.outcome.kind === 'deferred'
        ? { state: 'queued', event: record.event } : { ...record, state: 'settled' });
    });
  }

  async restore(): ReturnType<EventStore['restore']> {
    return this.exclusive(async () => {
      await this.refresh();
      return { lastAcceptedSequence: this.lastSequence, pending: this.pending() };
    });
  }

  async hasImageReference(conversationId: string, imageId: string, activeOnly = false): Promise<boolean> {
    return this.conversations.withConversationLock(conversationId, async () => this.exclusive(async () => {
      const state = activeOnly ? (await this.conversations.read(conversationId))?.state : undefined;
      if (state?.interruptedImageAttachmentIds?.includes(imageId)) return true;
      if (state?.session.sessionId !== null && state?.session.imageAttachmentIds?.includes(imageId)) return true;
      // Task 1 sessions did not record ownership. Preserve their accepted images until an explicit session switch.
      const legacySession = state !== undefined && state.session.sessionId !== null && state.session.imageAttachmentIds === undefined;
      await ensurePrivateDirectory(this.directory);
      for await (const entry of await opendir(this.directory)) {
        if (!entry.name.endsWith('.json')) continue;
        const record = await this.readStored(join(this.directory, entry.name));
        if (record === undefined) continue;
        const event = record.event.event;
        if ((!activeOnly || legacySession || record.state !== 'settled')
          && record.event.conversationId === conversationId && event.kind === 'human_command'
          && event.command.kind === 'message' && event.command.imageAttachmentIds?.includes(imageId)) return true;
      }
      return false;
    }));
  }

  async hasGoalRegistration(repositoryDirectory: string, goalId: string): Promise<boolean> {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const record = await this.read(join(this.directory, entry.name));
      const { event } = record.event;
      if (event.kind === 'goal_registered' && event.repositoryDirectory === repositoryDirectory && event.goalId === goalId) return true;
    }
    return false;
  }

  private async *pending(): AsyncGenerator<StoredEvent> {
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const record = await this.read(join(this.directory, entry.name));
      if (isRetiredWatchEvent(record.event) && record.state !== 'settling') continue;
      if (record.state === 'settling') yield { ...record, state: 'settling' };
      else if (record.state === 'queued') yield { state: 'queued', event: record.event };
      else if (record.state === 'running') yield { state: 'running', event: record.event, turn: record.turn };
    }
  }
}
