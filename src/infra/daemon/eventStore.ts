import { createHash } from 'node:crypto';
import { opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AcceptedEvent } from '../../core/daemon/events.js';
import type { TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import type { EventStore, StoredEvent } from '../../core/daemon/ports.js';
import type { ConversationAssignment } from '../conversations/schema.js';
import { AcceptedEventSchema, EventRecordSchema, EventRecordWriteSchema, isRetiredWatchEvent, storedStandaloneInboxAnswer, TurnResultSchema, StoredTurnSchema, type EventRecord } from './eventRecord.js';
import { ensurePrivateDirectory, hasCode, readEntirePrivateFile, writePrivateFile } from './privateFile.js';
import { FileAsyncLock } from './lock.js';
import { ConversationStateStore } from './conversationStateStore.js';
import { DaemonPersistedFiles } from './persistedFiles.js';

const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');
const requestKey = (event: AcceptedEvent): string => JSON.stringify([event.conversationId, event.requestId]);

export class FileEventStore implements EventStore {
  private readonly directory: string;
  private readonly ids = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private readonly sequences = new Map<number, string>();
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
    const content = await readEntirePrivateFile(path);
    if (content === undefined) throw new Error(`Missing stored event: ${path}`);
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
    this.lastSequence = Math.max(this.lastSequence, event.acceptedSequence);
    this.knownFiles.add(path);
  }

  private async refresh(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const path = join(this.directory, entry.name);
      if (!this.knownFiles.has(path)) {
        const record = await this.read(path);
        this.index(record, path);
      }
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
        this.ids.delete(event.eventId);
        this.requests.delete(requestKey(event));
        this.sequences.delete(event.acceptedSequence);
        this.knownFiles.delete(this.path(event.eventId));
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
