import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AcceptedEvent } from '../../core/daemon/events.js';
import type { TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import type { EventStore, StoredEvent } from '../../core/daemon/ports.js';
import { AcceptedEventSchema, EventRecordSchema, StoredResultSchema, StoredTurnSchema, type EventRecord } from './eventRecord.js';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from './privateFile.js';
import { FileAsyncLock } from './lock.js';

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');
const requestKey = (event: AcceptedEvent): string => JSON.stringify([event.conversationId, event.requestId]);

export class FileEventStore implements EventStore {
  private readonly directory: string;
  private readonly ids = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private readonly sequences = new Map<number, string>();
  private readonly knownFiles = new Set<string>();
  private readonly lock = new FileAsyncLock();
  private lastSequence = 0;

  constructor(configDirectory: string) { this.directory = join(configDirectory, 'daemon-events'); }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock.exclusive(join(this.directory, '.lock'), action, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async read(path: string): Promise<EventRecord> {
    const content = await readPrivateFile(path, MAX_RECORD_BYTES);
    if (content === undefined) throw new Error(`Missing stored event: ${path}`);
    const record = EventRecordSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (path !== this.path(record.event.eventId)) throw new Error('Stored event identity mismatch');
    if (record.state === 'running') this.assertTurn(record.event, record.turn);
    if (record.state === 'settling' || record.state === 'settled') this.assertResult(record.event, record.result);
    return record;
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
      if (!this.knownFiles.has(path)) this.index(await this.read(path), path);
    }
  }

  private async write(record: EventRecord): Promise<void> {
    const content = JSON.stringify(EventRecordSchema.parse(record));
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('Stored event exceeds capacity');
    await writePrivateFile(this.path(record.event.eventId), content);
  }

  async accept(input: AcceptedEvent): ReturnType<EventStore['accept']> {
    // 呼出し元が await 中に変更しても、受付内容は変えない。
    const event = AcceptedEventSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    return this.exclusive(async () => {
      await this.refresh();
      const path = this.ids.get(event.eventId) ?? this.requests.get(requestKey(event));
      if (path !== undefined) {
        const stored = await this.read(path);
        return { kind: 'duplicate', event: stored.event, state: stored.state };
      }
      const record: EventRecord = { state: 'queued', event };
      const sequence = this.sequences.get(event.acceptedSequence);
      if (sequence !== undefined) throw new Error('Accepted sequence is already stored');
      await this.write(record);
      this.index(record, this.path(event.eventId));
      return { kind: 'stored' };
    });
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
    const result = StoredResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
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
    const result = StoredResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      if (record.state !== 'settling' && record.state !== 'settled' || !isDeepStrictEqual(record.result, result)) throw new Error('Result was not saved before settlement');
      if (record.state === 'settling') await this.write({ ...record, state: 'settled' });
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
      const { event } = (await this.read(join(this.directory, entry.name))).event;
      if (event.kind === 'goal_registered' && event.repositoryDirectory === repositoryDirectory && event.goalId === goalId) return true;
    }
    return false;
  }

  private async *pending(): AsyncGenerator<StoredEvent> {
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const record = await this.read(join(this.directory, entry.name));
      if (record.state === 'settling') yield { ...record, state: 'settling' };
      else if (record.state === 'queued') yield { state: 'queued', event: record.event };
      else if (record.state === 'running') yield { state: 'running', event: record.event, turn: record.turn };
    }
  }
}
