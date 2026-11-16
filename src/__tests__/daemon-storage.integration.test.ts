import { once } from 'node:events';
import * as spawnModule from '../shared/utils/spawn.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import { ensurePrivateDirectory, readEntirePrivateFile, readPrivateFile, writePrivateFile } from '../infra/daemon/privateFile.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import * as sensitiveText from '../shared/utils/sensitiveText.js';
import { RETAINED_TOOL_OUTPUT_BYTES } from '../shared/tool-activity/outputLimit.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import type { OutputVersion, PortOutput } from '../features/manager/conversationPort.js';
import type { ConversationToolEvent } from '../shared/types/conversation-activity.js';
import { readDaemonOwner, registerDaemonOwner, removeDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { conversationIpcEndpoint, readDaemonIpcState, resolveDaemonConfigDirectory, writeDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { answerInquiry, createInquiry } from '../infra/goals/inquiry.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import type { AcceptedEvent } from '../core/daemon/events.js';
import type { TurnIdentity, TurnResult } from '../core/daemon/messages.js';
import type { IoOptions } from '../core/daemon/io.js';
import { deferred } from './helpers/controlledDaemon.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { scenarioText, secretFragmentsIn, splitSecretScenarios } from './helpers/split-secret-scenarios.js';

const injection = vi.hoisted(() => ({ beforeSync: undefined as (() => Promise<void>) | undefined, afterRename: undefined as (() => void) | undefined, renameFailure: false, afterRenameFailure: false, lockReleaseFailure: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (injection.lockReleaseFailure && String(args[0]).endsWith('/.lock')) {
        injection.lockReleaseFailure = false;
        throw Object.assign(new Error('lock release failed'), { code: 'EIO' });
      }
      await fs.unlink(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (!String(args[0]).endsWith('.tmp')) return file;
      return new Proxy(file, { get(target, property) {
        if (property === 'sync') return async () => { await target.sync(); await injection.beforeSync?.(); };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (injection.renameFailure) { injection.renameFailure = false; throw Object.assign(new Error('rename failed'), { code: 'EIO' }); }
      await fs.rename(...args);
      injection.afterRename?.();
      if (injection.afterRenameFailure) { injection.afterRenameFailure = false; throw Object.assign(new Error('commit acknowledgement failed'), { code: 'EIO' }); }
    },
  };
});
vi.mock('../infra/daemon/process.js', () => ({
  readProcessOwner: async (pid: number) => ({ pid, startTime: 'darwin-start-v2:1234' }),
  observeProcess: async (owner: { pid: number }) => owner.pid === process.pid ? { kind: 'alive', owner } : { kind: 'dead' },
}));

const roots: string[] = [];
const signal = (): AbortSignal => new AbortController().signal;
const io = (): IoOptions => ({ signal: signal(), timeoutMs: 5000 });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'takt-daemon-storage-')); roots.push(path); return path; }
function event(id: string, sequence: number): AcceptedEvent {
  return { eventId: id, requestId: id, conversationId: 'conversation', source: 'tui', occurredAt: '2026-11-03T00:00:00Z',
    event: { kind: 'human_command', command: { kind: 'message', text: id }, speaker: { namespace: 'test', id: 'human' }, agentOverrides: { provider: 'codex', model: 'test' } },
    operationId: `operation-${id}`, acceptedSequence: sequence, lane: 'human' };
}
function result(input: AcceptedEvent): TurnResult {
  return { conversationId: input.conversationId, operationId: input.operationId, generation: 1, event: input, outcome: { kind: 'interrupted' } };
}
const assignment = { kind: 'repository' as const, repositoryDirectory: '/repo' };
const id = conversationId(assignment);
const turn = { conversationId: id, operationId: 'turn-1', generation: 1 };
function record() {
  return ConversationRecordSchema.parse({ schemaVersion: 1, id, agent: 'manager', assignment,
    counterpart: { namespace: 'test', id: 'human' }, lastSpeaker: null, provider: 'codex', model: null, sessionId: null,
    bindings: [], revision: 0, pending: null, approval: null, running: null });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  injection.beforeSync = undefined; injection.afterRename = undefined; injection.renameFailure = false; injection.afterRenameFailure = false; injection.lockReleaseFailure = false;
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

async function patrolRecords(directory: string) {
  const { FilePatrolRecords } = await import('../infra/daemon/patrolRecords.js');
  return new FilePatrolRecords(directory);
}

it('saves a conversation larger than 12 MiB, reloads it in a new store, and keeps saving it', async () => {
  const directory = await root();
  await new ConversationStateStore(directory).create(record());
  const interruptedMessage = 'm'.repeat(13 * 1024 * 1024);
  await expect(new ConversationStateStore(directory).save(turn, { operationId: 'large-save', expectedVersion: 0, interruptedMessage }, signal()))
    .resolves.toMatchObject({ kind: 'state_saved', version: 1 });
  const reloaded = new ConversationStateStore(directory);
  expect((await reloaded.read(id))?.state.interruptedMessage).toBe(interruptedMessage);
  await expect(reloaded.save(turn, { operationId: 'session-save', expectedVersion: 1,
    session: { provider: 'codex', model: null, sessionId: 'saved-session' } }, signal())).resolves.toMatchObject({ kind: 'state_saved', version: 2 });
  const records = [];
  for await (const value of new ConversationStateStore(directory).iterate()) records.push(value);
  expect(records).toMatchObject([{ id, interruptedMessage, sessionId: 'saved-session' }]);
});

it('saves a turn result larger than 16 MiB and restores it as a pending settlement', async () => {
  const directory = await root();
  const store = new FileEventStore(directory);
  const accepted = event('large-result', 1);
  await store.accept(accepted);
  const message = 'r'.repeat(17 * 1024 * 1024);
  const saved: TurnResult = { ...result(accepted), outcome: { kind: 'completed', result: { kind: 'reply', message } } };
  await store.markStarted(accepted.eventId, saved);
  await store.saveResult(accepted.eventId, saved);
  const restored = await new FileEventStore(directory).restore();
  const pending = [];
  for await (const value of restored.pending) pending.push(value);
  expect(pending).toEqual([{ state: 'settling', event: accepted, result: saved }]);
});

it('reads back a saved director notification larger than 1 MiB and recognizes its duplicate', async () => {
  const directory = await root();
  const notifications = new DaemonNotifications(directory);
  const notification = { id: 'large-notification', message: 'n'.repeat(2 * 1024 * 1024) };
  expect(await notifications.save(notification, signal())).toBe(true);
  const saved = [];
  for await (const value of new DaemonNotifications(directory).iterate()) saved.push(value);
  expect(saved).toEqual([notification]);
  expect(await new DaemonNotifications(directory).save(notification, signal())).toBe(false);
});

it('keeps state-only snapshots available when display message history is unreadable', async () => {
  const directory = await root(); const f = toolOwner(directory); await f.store.create(record());
  await writePrivateFile(join(directory, 'daemon-events', 'invalid.json'), '{');
  const snapshot = await f.owner.snapshot(id, { toolHistory: false });
  expect(snapshot.turnState.version).toBe(0);
  snapshot.cancel();
  await expect(f.owner.snapshot(id, { toolHistory: true })).rejects.toThrow();
});

describe('durable manager patrol timestamps', () => {
  it('returns no timestamp for a repository that has never been patrolled', async () => {
    const records = await patrolRecords(await root());
    await expect(records.read('/workspace/a/service')).resolves.toBeUndefined();
  });

  it('restores a repository timestamp after recreating the file store', async () => {
    const directory = await root();
    const records = await patrolRecords(directory);
    await records.write('/workspace/a/service', 1793923200000);
    const restored = await patrolRecords(directory);
    await expect(restored.read('/workspace/a/service')).resolves.toBe(1793923200000);
    const names = await readdir(join(directory, 'daemon-patrols'));
    expect(names).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'daemon-patrols', names[0]!))).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps timestamps separate for repositories with the same final directory name', async () => {
    const directory = await root();
    const records = await patrolRecords(directory);
    await records.write('/workspace/a/service', 1793923200000);
    await records.write('/workspace/b/service', 1793925000000);
    const restored = await patrolRecords(directory);
    await expect(restored.read('/workspace/a/service')).resolves.toBe(1793923200000);
    await expect(restored.read('/workspace/b/service')).resolves.toBe(1793925000000);
  });

  it.each(['{', '{"lastQueued":"not-a-timestamp"}'])('reports an invalid saved patrol timestamp (%s)', async (content) => {
    const directory = await root();
    const key = createHash('sha256').update('/workspace/a/service').digest('hex');
    await writePrivateFile(join(directory, 'daemon-patrols', `${key}.json`), content);
    const records = await patrolRecords(directory);
    await expect(records.read('/workspace/a/service')).rejects.toThrow();
  });
});

describe('durable daemon event storage', () => {
  it('recovers visible messages in acceptance order even after settlement, excluding hidden messages and failed admissions', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const first = event('first message', 1); const second = event('second message', 2);
    await store.accept(second); await store.accept(first);
    const finished = result(first);
    await store.markStarted(first.eventId, finished);
    const expected = [first, second].map((entry) => ({ operationId: entry.operationId, message: entry.event.kind === 'human_command' && entry.event.command.kind === 'message' ? entry.event.command.text : '', acceptedSequence: entry.acceptedSequence, pending: entry.eventId !== first.eventId }));
    expect((await store.readTurns(first.conversationId)).filter((turn) => turn.message !== undefined)).toEqual(expected);
    await store.saveResult(first.eventId, finished); await store.markSettled(first.eventId, finished);
    await store.accept({ ...event('hidden', 3), event: { kind: 'human_command', command: { kind: 'message', text: 'hidden', display: false }, speaker: { namespace: 'test', id: 'human' } } });
    await store.accept({ ...event('another conversation', 4), conversationId: 'another' });
    injection.afterRenameFailure = true;
    await expect(store.accept(event('rejected', 5))).rejects.toThrow();
    expect((await store.readTurns(first.conversationId)).filter((turn) => turn.message !== undefined)).toEqual(expected);
    const restarted = new FileEventStore(directory);
    await restarted.restore();
    expect((await restarted.readTurns(first.conversationId)).filter((turn) => turn.message !== undefined)).toEqual(expected);
  });

  it('indexes retired PR retry observations and restores only unfinished settlement', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const states = ['queued', 'running', 'settling', 'settled'] as const;
    for (const [index, state] of states.entries()) {
      const input = { ...event(state, index + 1), lane: 'other' as const, source: 'watcher' as const,
        event: { kind: 'watch_observation' as const, observation: { kind: 'goal_pr_retry',
          targetId: goalId, generation: 'old', observedAt: '2026-11-03T00:00:00Z',
          repositoryDirectory: '/repo', goalId, failureId: 'failure', expectedSha: 'a'.repeat(40),
          reason: 'push failed', attempt: 1, maxAttempts: 3 } } };
      const path = join(directory, 'daemon-events', `${createHash('sha256').update(input.eventId).digest('hex')}.json`);
      const turn = { conversationId: input.conversationId, operationId: input.operationId, generation: 1 };
      const record = { state, event: input,
        ...(state === 'running' ? { turn } : {}),
        ...(state === 'settling' || state === 'settled' ? { result: { ...turn, event: input, outcome: { kind: 'interrupted' } } } : {}) };
      await writePrivateFile(path, JSON.stringify(record));
      await expect(store.accept(input as AcceptedEvent)).rejects.toThrow();
    }
    const restarted = new FileEventStore(directory);
    expect((await restarted.restore()).lastAcceptedSequence).toBe(4);
    await restarted.accept(event('active', 5));
    const restored = await restarted.restore();
    const pending = [];
    for await (const record of restored.pending) pending.push(record.event.eventId);
    expect(restored.lastAcceptedSequence).toBe(5);
    expect(pending).toHaveLength(2);
    expect(pending).toEqual(expect.arrayContaining(['active', 'settling']));
    for (const state of states) {
      const expected = { kind: 'duplicate', state: state === 'settling' ? 'settling' : 'settled' };
      await expect(restarted.accept(event(state, 6))).resolves.toMatchObject(expected);
      await expect(restarted.accept({ ...event(`duplicate-${state}`, 6), requestId: state })).resolves.toMatchObject(expected);
    }
    await expect(restarted.accept(event('sequence-conflict', 4))).rejects.toThrow('sequence');
    expect((await readdir(join(directory, 'daemon-events'))).filter((name) => name.endsWith('.json'))).toHaveLength(5);
  });

  it.each([
    { kind: 'project', projectDirectory: '/repo' },
    { kind: 'workspace', workspaceId: '650e8400-e29b-41d4-a716-446655440001' },
    { kind: 'global' },
  ] as const)('restores legacy permission answers in every lifecycle state (%j)', async (scope) => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const states = ['queued', 'running', 'settling', 'settled'] as const;
    const answers = states.map((state, index): AcceptedEvent => ({ ...event(state, index + 1),
      event: { kind: 'inquiry_answer', command: { kind: 'answer_question',
        questionId: '650e8400-e29b-41d4-a716-446655440001', target: { goalId, repositoryDirectory: '/repo' },
        answer: { decision: 'allow', scope: scope.kind }, source: 'tui' } },
    }));
    for (const [index, answer] of answers.entries()) {
      await store.accept(answer);
      if (index > 0) await store.markStarted(answer.eventId, result(answer));
      if (index > 1) await store.saveResult(answer.eventId, result(answer));
      if (index > 2) await store.markSettled(answer.eventId, result(answer));
    }
    for (const name of await readdir(join(directory, 'daemon-events'))) {
      if (!name.endsWith('.json')) continue;
      const path = join(directory, 'daemon-events', name);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      saved.event.event.command.permission = { scope, sentence: 'Allow this operation' };
      if (saved.result) saved.result.event.event.command.permission = { scope, sentence: 'Allow this operation' };
      await writePrivateFile(path, JSON.stringify(saved));
    }

    const restarted = new FileEventStore(directory);
    const restored = await restarted.restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(restored.lastAcceptedSequence).toBe(4);
    expect(pending.map(({ state }) => state).sort()).toEqual(['queued', 'running', 'settling']);
    for (const answer of answers) {
      expect(await restarted.accept(answer)).toEqual({ kind: 'duplicate', event: answer, state: answer.eventId });
      const record = pending.find(({ event }) => event.eventId === answer.eventId);
      if (record) {
        expect(record.event).toEqual(answer);
        if (record.state === 'settling') expect(record.result).toEqual(result(answer));
      }
    }
  });

  it('rejects legacy permission fields on newly accepted answers', async () => {
    const store = new FileEventStore(await root());
    const answer = { ...event('new-answer', 1), event: { kind: 'inquiry_answer', command: {
      kind: 'answer_question', questionId: '650e8400-e29b-41d4-a716-446655440001',
      target: { goalId, repositoryDirectory: '/repo' }, answer: { decision: 'allow' },
      permission: { scope: { kind: 'global' }, sentence: 'Allow this operation' },
    } } };
    await expect(store.accept(answer as AcceptedEvent)).rejects.toThrow();
    const restored = await store.restore();
    expect(restored.lastAcceptedSequence).toBe(0);
  });

  it('restores queued, running, and settling records while excluding settled records', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    for (const [index, name] of ['queued', 'running', 'settling', 'settled'].entries()) await store.accept(event(name, index + 1));
    for (const name of ['running', 'settling', 'settled']) await store.markStarted(name, result(event(name, ['queued', 'running', 'settling', 'settled'].indexOf(name) + 1)));
    await store.saveResult('settling', result(event('settling', 3)));
    await store.saveResult('settled', result(event('settled', 4)));
    await store.markSettled('settled', result(event('settled', 4)));
    const restored = await new FileEventStore(directory).restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(restored.lastAcceptedSequence).toBe(4);
    expect(pending.map((value) => [value.event.eventId, value.state]).sort()).toEqual([['queued', 'queued'], ['running', 'running'], ['settling', 'settling']]);
    expect(pending.every((value) => value.event.event.kind === 'human_command' && value.event.event.agentOverrides?.model === 'test')).toBe(true);
  });

  it('deduplicates by event ID and conversation/request ID across restart, including settled events', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const accepted = event('original', 1);
    await store.accept(accepted);
    await store.markStarted(accepted.eventId, result(accepted));
    await store.saveResult(accepted.eventId, result(accepted));
    await store.markSettled(accepted.eventId, result(accepted));
    const restarted = new FileEventStore(directory);
    expect(await restarted.accept({ ...event('other', 2), requestId: 'original' })).toEqual({ kind: 'duplicate', event: accepted, state: 'settled' });
    expect(await restarted.accept({ ...accepted, requestId: 'other', acceptedSequence: 3 })).toEqual({ kind: 'duplicate', event: accepted, state: 'settled' });
  });

  it('serializes competing stores and keeps per-request overrides fixed', async () => {
    const directory = await root();
    const first = event('a', 1);
    const second = { ...event('b', 2), requestId: first.requestId };
    const results = await Promise.all([new FileEventStore(directory).accept(first), new FileEventStore(directory).accept(second)]);
    expect(results.map((value) => value.kind).sort()).toEqual(['duplicate', 'stored']);
    const restored = await new FileEventStore(directory).restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(pending).toHaveLength(1);
  });

  it('makes lifecycle retries idempotent and rejects a different result or generation', async () => {
    const store = new FileEventStore(await root());
    const input = event('a', 1);
    const outcome = result(input);
    await store.accept(input);
    await expect(store.markSettled('a', outcome)).rejects.toThrow();
    await store.markStarted('a', outcome);
    await store.markStarted('a', outcome);
    await expect(store.markStarted('a', { ...outcome, generation: 2 })).rejects.toThrow();
    await store.saveResult('a', outcome);
    await store.saveResult('a', outcome);
    await expect(store.saveResult('a', { ...outcome, outcome: { kind: 'failed', message: 'different' } })).rejects.toThrow();
    await store.markSettled('a', outcome);
    await store.markSettled('a', outcome);
  });

  it('persists a legacy interrupted message above one MiB through event and conversation stores', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const text = 'legacy'.repeat(256 * 1024);
    const legacyEvent: AcceptedEvent = { ...event('legacy-long', 1), conversationId: id, operationId: turn.operationId,
      event: { kind: 'human_command', command: { kind: 'message', text }, speaker: { namespace: 'test', id: 'human' } } };
    const interrupted: TurnResult = { ...result(legacyEvent), outcome: { kind: 'interrupted', change: {
      operationId: 'legacy-cleanup', expectedVersion: 0, interruptedMessage: text,
    } } };
    await store.accept(legacyEvent);
    await store.markStarted(legacyEvent.eventId, turn);
    await store.saveResult(legacyEvent.eventId, interrupted);
    await new FileEventStore(directory).saveResult(legacyEvent.eventId, interrupted);
    await store.markSettled(legacyEvent.eventId, interrupted);

    const conversations = new ConversationStateStore(directory);
    await conversations.create(record());
    await conversations.apply(interrupted);
    expect((await conversations.read(id))?.state.interruptedMessage).toBe(text);
    const restored = await new FileEventStore(directory).restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(pending).toEqual([]);
  });

  it('persists and retries a large interrupted message without duplicating it in the receipt', async () => {
    const directory = await root();
    const store = new ConversationStateStore(directory);
    await store.create(record());
    const text = 'x'.repeat(7 * 1024 * 1024);
    const input = { ...event('large-interruption', 1), conversationId: id, operationId: turn.operationId };
    const change = { operationId: 'large-interruption-save', expectedVersion: 0, interruptedMessage: text };
    const interrupted: TurnResult = { ...turn, event: input, outcome: { kind: 'interrupted', change } };

    await store.apply(interrupted);

    const path = join(directory, 'conversations', `${id}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { daemonState: { receipts: unknown[] } };
    expect(Buffer.byteLength(JSON.stringify(saved.daemonState.receipts))).toBeLessThan(1024 * 1024);
    expect((await new ConversationStateStore(directory).read(id))?.state.interruptedMessage).toBe(text);
    await expect(new ConversationStateStore(directory).apply(interrupted)).resolves.toBeUndefined();

    const changed: TurnResult = { ...interrupted, outcome: { kind: 'interrupted', change: { ...change, interruptedMessage: `${text}different` } } };
    await expect(new ConversationStateStore(directory).apply(changed)).rejects.toThrow('Conversation result could not be applied');
  });

  it('normalizes an existing goal question consistently across result retries and settlement', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const accepted = event('goal-result', 1);
    await store.accept(accepted);
    const outcome: TurnResult = { ...result(accepted), outcome: { kind: 'completed', result: { kind: 'goal_registered',
      goal: { ...goalRecord(), questions: [{ id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', body: 'Question', status: 'pending' }] } } } };
    await store.markStarted(accepted.eventId, { conversationId: outcome.conversationId, operationId: outcome.operationId, generation: outcome.generation });
    await store.saveResult(accepted.eventId, outcome);
    await new FileEventStore(directory).saveResult(accepted.eventId, outcome);
    await store.markSettled(accepted.eventId, outcome);
    const restored = await new FileEventStore(directory).restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(pending).toEqual([]);
  });

  it.each(['rename', 'after-rename', 'lock-release'] as const)('discards a failed acceptance across restart (%s)', async (phase) => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const input = event('rejected', 1);
    if (phase === 'rename') injection.renameFailure = true;
    else if (phase === 'after-rename') injection.afterRenameFailure = true;
    else injection.lockReleaseFailure = true;
    await expect(store.accept(input)).rejects.toThrow();
    if (phase === 'lock-release') await rm(join(directory, 'daemon-events', '.lock'));
    const restored = await new FileEventStore(directory).restore();
    const pending = [];
    for await (const value of restored.pending) pending.push(value);
    expect(pending).toEqual([]);
    expect(await store.accept(event('resent', 2))).toEqual({ kind: 'stored' });
    expect(await store.accept(input)).toEqual({ kind: 'stored' });
  });

  it('restores a deferred result as pending and processes the same event after resumption', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const input = event('deferred', 1);
    const deferredResult: TurnResult = { ...result(input), outcome: { kind: 'deferred' } };
    await store.accept(input);
    await store.markStarted(input.eventId, deferredResult);
    await store.saveResult(input.eventId, deferredResult);
    const restarted = new FileEventStore(directory);
    const pending = [];
    for await (const value of (await restarted.restore()).pending) pending.push(value);
    expect(pending).toEqual([{ state: 'settling', event: input, result: deferredResult }]);
    await restarted.markSettled(input.eventId, deferredResult);
    await restarted.markSettled(input.eventId, deferredResult);
    const queued = [];
    for await (const value of (await restarted.restore()).pending) queued.push(value);
    expect(queued).toEqual([{ state: 'queued', event: input }]);
    const resumed: TurnResult = { ...deferredResult, generation: 2, outcome: { kind: 'completed', result: { kind: 'reply', message: 'handled' } } };
    await restarted.markStarted(input.eventId, resumed);
    await restarted.saveResult(input.eventId, resumed);
    await restarted.markSettled(input.eventId, resumed);
    const settled = [];
    for await (const value of (await restarted.restore()).pending) settled.push(value);
    expect(settled).toEqual([]);
  });

  it('retains queued data after a failed start write and allows a retry', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const input = event('a', 1);
    await store.accept(input);
    injection.renameFailure = true;
    await expect(store.markStarted('a', result(input))).rejects.toThrow();
    const restored = await new FileEventStore(directory).restore();
    for await (const value of restored.pending) expect(value.state).toBe('queued');
    await store.markStarted('a', result(input));
    expect((await readdir(join(directory, 'daemon-events'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('conditional conversation state persistence', () => {
  it('reads the existing conversation format and saves a versioned session atomically', async () => {
    const directory = await root();
    await ensurePrivateDirectory(join(directory, 'conversations'));
    await writeFile(join(directory, 'conversations', `${id}.json`), JSON.stringify(record()));
    const store = new ConversationStateStore(directory);
    expect((await store.read(id))?.state.version).toBe(0);
    const change = { operationId: 'save-session', expectedVersion: 0, session: { provider: 'codex', model: 'new', sessionId: 'session' } };
    expect(await store.save(turn, change, signal())).toEqual({ kind: 'state_saved', version: 1, duplicate: false });
    const restarted = new ConversationStateStore(directory);
    expect((await restarted.read(id))?.state.session).toEqual(change.session);
    expect(await restarted.save(turn, change, signal())).toEqual({ kind: 'state_saved', version: 1, duplicate: true });
    expect(await restarted.save(turn, { ...change, session: { ...change.session, model: 'other' } }, signal())).toMatchObject({ kind: 'error', code: 'forbidden' });
    expect(await restarted.save(turn, { ...change, operationId: 'other' }, signal())).toMatchObject({ kind: 'error', code: 'version_conflict' });
  });

  it('reconciles a committed conversation save and rejects operation reuse by another turn', async () => {
    const directory = await root();
    const store = new ConversationStateStore(directory);
    await store.create(record());
    const change = { operationId: 'uncertain-save', expectedVersion: 0, session: { provider: 'codex', model: null, sessionId: 'saved' } };
    injection.afterRenameFailure = true;
    await expect(store.save(turn, change, signal())).rejects.toThrow();
    expect(await new ConversationStateStore(directory).save(turn, change, signal())).toEqual({ kind: 'state_saved', version: 1, duplicate: true });
    expect(await store.save({ ...turn, generation: 2 }, change, signal())).toMatchObject({ kind: 'error', code: 'forbidden' });
    expect((await store.read(id))?.state.version).toBe(1);
  });

  it('bounds receipt history while preserving recent retries and rejecting old versions', async () => {
    const directory = await root(); const store = new ConversationStateStore(directory);
    await store.create(record());
    for (let index = 0; index < 40; index++) {
      expect(await store.save(turn, { operationId: `save-${index}`, expectedVersion: index,
        session: { provider: 'codex', model: null, sessionId: 'x'.repeat(100_000) } }, signal())).toMatchObject({ kind: 'state_saved', version: index + 1 });
    }
    const saved = JSON.parse(await readFile(join(directory, 'conversations', `${id}.json`), 'utf8')) as { daemonState: { receipts: unknown[] } };
    expect(saved.daemonState.receipts.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(saved.daemonState.receipts))).toBeLessThanOrEqual(1024 * 1024);
    const restarted = new ConversationStateStore(directory);
    expect((await restarted.read(id))?.state.version).toBe(40);
    expect(await restarted.save(turn, { operationId: 'save-39', expectedVersion: 39,
      session: { provider: 'codex', model: null, sessionId: 'x'.repeat(100_000) } }, signal())).toMatchObject({ kind: 'state_saved', duplicate: true });
    expect(await restarted.save(turn, { operationId: 'save-0', expectedVersion: 0,
      session: { provider: 'codex', model: null, sessionId: 'old' } }, signal())).toMatchObject({ kind: 'error', code: 'version_conflict' });
  });

  it('allows only one of two competing expected-version writes', async () => {
    const directory = await root();
    await new ConversationStateStore(directory).create(record());
    const replies = await Promise.all(['a', 'b'].map((operationId) => new ConversationStateStore(directory).save(turn,
      { operationId, expectedVersion: 0, session: { provider: 'codex', model: null, sessionId: operationId } }, signal())));
    expect(replies.filter((reply) => reply.kind === 'state_saved')).toHaveLength(1);
    expect(replies.filter((reply) => reply.kind === 'error' && reply.code === 'version_conflict')).toHaveLength(1);
    expect((await new ConversationStateStore(directory).read(id))?.state.version).toBe(1);
  });

  it('rejects a reservation for another repository and leaves the conversation unchanged', async () => {
    const store = new ConversationStateStore(await root());
    await store.create(record());
    const reply = await store.save(turn, { operationId: 'invalid', expectedVersion: 0,
      approval: { revision: 1, goalId, repositoryDirectory: '/other', state: 'reserved' } }, signal());
    expect(reply).toMatchObject({ kind: 'error', code: 'forbidden' });
    expect((await store.read(id))?.state.version).toBe(0);
  });

  it('acknowledges a committed version when cancellation arrives after atomic publication', async () => {
    const directory = await root();
    const store = new ConversationStateStore(directory);
    await store.create(record());
    const abort = new AbortController();
    injection.afterRename = () => abort.abort();
    expect(await store.save(turn, { operationId: 'committed-before-abort', expectedVersion: 0,
      session: { provider: 'codex', model: null, sessionId: 'kept' } }, abort.signal)).toEqual({ kind: 'state_saved', version: 1, duplicate: false });
    expect((await store.read(id))?.state.session.sessionId).toBe('kept');
    expect((await readdir(join(directory, 'conversations'))).sort()).toEqual([`${id}.json`]);
  });

  it('waits for cancellation cleanup before replying, without publishing a version', async () => {
    const directory = await root();
    const store = new ConversationStateStore(directory);
    await store.create(record());
    const entered = deferred<void>();
    const release = deferred<void>();
    injection.beforeSync = async () => { entered.resolve(); await release.promise; };
    const abort = new AbortController();
    const save = store.save(turn, { operationId: 'cancelled', expectedVersion: 0, session: { provider: 'codex', model: null, sessionId: 'lost' } }, abort.signal);
    const rejected = expect(save).rejects.toThrow();
    await entered.promise;
    abort.abort();
    expect((await store.read(id))?.state.version).toBe(0);
    release.resolve();
    await rejected;
    expect((await readdir(join(directory, 'conversations'))).sort()).toEqual([`${id}.json`]);
  });

  it('applies a saved turn result once, including an interrupted change', async () => {
    const directory = await root();
    const store = new ConversationStateStore(directory);
    await store.create(record());
    const input = { ...event('a', 1), conversationId: id, operationId: turn.operationId };
    const completed: TurnResult = { ...turn, event: input, outcome: { kind: 'interrupted',
      change: { operationId: 'finish', expectedVersion: 0, session: { provider: 'codex', model: null, sessionId: 'saved' } } } };
    await store.apply(completed);
    await new ConversationStateStore(directory).apply(completed);
    expect((await store.read(id))?.state.version).toBe(1);
    expect((await store.read(id))?.state.session.sessionId).toBe('saved');
  });
});

describe('private asynchronous I/O and existing files', () => {
  it('holds a lock across a deferred Promise and rejects a cancelled waiter', async () => {
    const directory = await root();
    const path = join(directory, 'lock');
    const entered = deferred<void>();
    const release = deferred<void>();
    const lock = new FileAsyncLock();
    const first = lock.exclusive(path, async () => { entered.resolve(); await release.promise; return 42; }, io());
    await entered.promise;
    expect(await readFile(path, 'utf8')).toContain('token');
    const abort = new AbortController();
    const action = vi.fn(async () => 2);
    const second = lock.exclusive(path, action, { signal: abort.signal, timeoutMs: 5000 });
    const rejected = expect(second).rejects.toThrow();
    abort.abort();
    await rejected;
    expect(action).not.toHaveBeenCalled();
    expect(await lock.exclusive(join(directory, 'other'), async () => 3, io())).toBe(3);
    release.resolve();
    expect(await first).toBe(42);
    expect(await readPrivateFile(path, 4096)).toBeUndefined();
  });

  it('keeps a timed-out lock until the action and release have completed', async () => {
    vi.useFakeTimers();
    const directory = await root();
    const path = join(directory, 'lock');
    const entered = deferred<void>();
    const release = deferred<void>();
    const operation = new FileAsyncLock().exclusive(path, async () => { entered.resolve(); await release.promise; }, { signal: signal(), timeoutMs: 10 });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(await readPrivateFile(path, 4096)).toBeDefined();
    release.resolve();
    await rejected;
    expect(await readPrivateFile(path, 4096)).toBeUndefined();
  });

  it('releases failed actions, reports release failure, and recovers a dead legacy holder', async () => {
    const directory = await root();
    const path = join(directory, 'lock');
    const lock = new FileAsyncLock();
    await expect(lock.exclusive(path, async () => { throw new Error('failed'); }, io())).rejects.toThrow();
    await writeFile(path, JSON.stringify({ pid: 2147483647, processIdentity: { startTime: 'darwin-start-v2:1' } }));
    expect(await lock.exclusive(path, async () => 42, io())).toBe(42);
    await expect(lock.exclusive(path, async () => { await writeFile(path, 'other'); throw new Error('action failed'); }, io())).rejects.toThrow(AggregateError);
  });

  it('writes private files with a byte bound and no temporary artifacts', async () => {
    const directory = await root();
    const path = join(directory, 'a', 'b', 'data');
    await writePrivateFile(path, 'old');
    await writePrivateFile(path, 'new');
    expect((await readPrivateFile(path, 3))?.toString()).toBe('new');
    await expect(readPrivateFile(path, 2)).rejects.toThrow();
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'a', 'b'))).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(join(directory, 'a', 'b'))).toEqual(['data']);
  });

  it('registers and removes only a matching owner and roundtrips IPC metadata', async () => {
    const directory = await resolveDaemonConfigDirectory(await root());
    const owner = { pid: process.pid, identity: { startTime: 'darwin-start-v2:1234' }, version: 'test', cliPath: '/cli' };
    expect(await registerDaemonOwner(directory, owner, io())).toBe(true);
    expect(await registerDaemonOwner(directory, owner, io())).toBe(false);
    expect(await readDaemonOwner(directory)).toEqual(owner);
    await removeDaemonOwner(directory, { ...owner, pid: 123 }, io());
    expect(await readDaemonOwner(directory)).toEqual(owner);
    const state = { protocolVersion: 1 as const, endpoint: conversationIpcEndpoint(directory, process.platform, 501), capability: 'a'.repeat(64), owner };
    await writeDaemonIpcState(directory, state);
    expect(await readDaemonIpcState(directory)).toEqual(state);
    await writeDaemonOwner(directory, owner);
    await removeDaemonOwner(directory, owner, io());
    expect(await readDaemonOwner(directory)).toBeUndefined();
  });

  it('persists log writes before close and rejects writes after close', async () => {
    const directory = await root();
    const logger = new DaemonLogger(directory);
    await logger.write('info', 'started');
    await logger.close();
    const names = await readdir(join(directory, 'daemon-logs'));
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, 'daemon-logs', names[0]!), 'utf8'))).toMatchObject({ level: 'info', message: 'started' });
    await expect(logger.write('info', 'closed')).rejects.toThrow();
  });

  it('reads existing goal, task YAML, and manager inbox files with bounded asynchronous reads', async () => {
    const directory = await root();
    const repository = join(directory, 'repo');
    const files = new DaemonPersistedFiles(directory);
    await ensurePrivateDirectory(join(repository, '.takt', 'goals', goalId));
    await writePrivateFile(join(repository, '.takt', 'goals', goalId, 'goal.json'), JSON.stringify(goalRecord()));
    await writePrivateFile(join(repository, '.takt', 'tasks.yaml'), 'tasks:\n  - name: existing\n    status: running\n    owner_pid: 123\n    run_slug: run-1\n');
    const inbox = await files.inboxDirectory(repository);
    await writePrivateFile(join(inbox, 'registered.json'), JSON.stringify({ kind: 'registered', goalId, createdAt: '2026-11-03T00:00:00Z' }));
    expect((await files.readGoal(repository, goalId))?.id).toBe(goalId);
    expect(await files.readTasks(repository)).toEqual({ tasks: [{ name: 'existing', status: 'running', owner_pid: 123, run_slug: 'run-1' }] });
    expect(await files.readInboxEvent(repository, 'registered.json')).toMatchObject({ kind: 'registered', goalId });
    await expect(files.readInboxEvent(repository, '../outside.json')).rejects.toThrow();
  });

  it('reads existing Slack bindings and serializes writes to different bindings', async () => {
    const directory = await root();
    const binding = { channelId: 'C', parentTs: '1', questionId: '650e8400-e29b-41d4-a716-446655440001', target: { goalId, repositoryDirectory: '/repo' } };
    const hash = createHash('sha256').update('/repo').digest('hex');
    await writePrivateFile(join(directory, 'slack-inquiries', `${hash}.json`), JSON.stringify([binding]));
    const store = new SlackInquiryBindings(directory, '/repo');
    expect(await store.find('C', '1')).toEqual(binding);
    await Promise.all(['2', '3'].map((parentTs) => new SlackInquiryBindings(directory, '/repo').save({ ...binding, parentTs, questionId: `650e8400-e29b-41d4-a716-44665544000${parentTs}` })));
    expect(await store.find('C', '2')).toBeDefined();
    expect(await store.find('C', '3')).toBeDefined();
  });
});


describe('real asynchronous command process boundary', () => {
  it('returns a real Node command exit and bounded output without a provider', async () => {
    const result = await new AsyncCommand().run({ executable: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7'],
      cwd: await root(), env: { ...process.env }, maxOutputBytes: 64 }, io());
    expect(result).toMatchObject({ code: 7, signal: null, truncated: false });
    expect(Buffer.from(result.stdout).toString()).toBe('out');
    expect(Buffer.from(result.stderr).toString()).toBe('err');
  });

  it('waits for actual process termination after cancellation at an explicit ready notification', async () => {
    const ready = deferred<ReturnType<typeof spawnModule.spawnManagedProcess>>();
    const actual = spawnModule.spawnManagedProcess;
    vi.spyOn(spawnModule, 'spawnManagedProcess').mockImplementation((...args) => {
      const managed = actual(...args); ready.resolve(managed); return managed;
    });
    const abort = new AbortController();
    const directory = await root();
    const run = new AsyncCommand().run({ executable: process.execPath,
      args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      cwd: directory, env: { ...process.env }, maxOutputBytes: 64 }, { signal: abort.signal, timeoutMs: 5000 });
    const rejected = expect(run).rejects.toThrow();
    const managed = await ready.promise;
    await once(managed.child.stdout!, 'data');
    abort.abort();
    await rejected;
    const exit = await managed.waitForExit();
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    expect(() => process.kill(managed.child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('cleans up a spawn error before rejecting', async () => {
    await expect(new AsyncCommand().run({ executable: join(await root(), 'missing-executable'), args: [],
      cwd: await root(), env: { ...process.env }, maxOutputBytes: 64 }, io())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

type ToolEventBody = Omit<ConversationToolEvent['event'], 'toolActivity'>;
function toolEvent(identity: TurnIdentity, eventId: string, body: ToolEventBody): ConversationToolEvent {
  return { kind: 'tool_event', eventId, event: { ...body,
    toolActivity: { callId: 'call', operationId: identity.operationId, generation: identity.generation } } as ConversationToolEvent['event'] };
}
function toolOwner(directory: string) {
  const store = new ConversationStateStore(directory);
  const outputs: Array<{ output: PortOutput; version: OutputVersion }> = [];
  const errors: unknown[] = [];
  const owner = new DaemonConversations(store, new DaemonRouting(directory), new DaemonNotifications(directory),
    async (_conversation, output, version) => { outputs.push({ output, version }); }, (error) => { errors.push(error); }, new FileEventStore(directory));
  const accepted = (identity: TurnIdentity): AcceptedEvent => ({ ...event(identity.operationId, identity.generation),
    conversationId: identity.conversationId, operationId: identity.operationId });
  return { store, owner, outputs, errors,
    startedKey() { return outputs.flatMap(({output}) => output.kind === 'tool_started' ? [output.entry.key] : [])[0]!; },
    start(identity: TurnIdentity) {
      owner.started({ turn: identity, event: accepted(identity), state: { version: 0, assignment,
        session: { provider: 'codex', model: null, sessionId: null }, revision: 0, pending: null, approval: null } });
    },
    finish(identity: TurnIdentity) {
      return owner.apply({ ...identity, event: accepted(identity), outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
    },
    async snapshotHistory() {
      const snapshot = await owner.snapshot(id, { toolHistory: true });
      const items = [];
      for await (const item of snapshot.items) items.push(item);
      snapshot.complete();
      const history = items.find((item) => item.kind === 'tool_history');
      return history?.kind === 'tool_history' ? history.history : undefined;
    },
    toolOutputs() { return outputs.map(({ output }) => output).filter((output) => output.kind !== 'user_message' && output.kind !== 'running' ); },
    streamedText(key: string) {
      return outputs.flatMap(({ output }) => output.kind === 'tool_output' && output.key === key
        ? [output.text] : []).join('');
    },
  };
}
const toolHistoryFile = (directory: string) => join(directory, 'conversation-tool-history', `${id}.jsonl`);
const toolHistoryLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const savedToolEntry = (key: string, toolId: string) => ({ key, toolId, tool: 'Read', input: {}, output: '', result: toolId,
  status: 'success' as const, association: 'matched' as const, context: { callId: 'call', operationId: turn.operationId, generation: turn.generation } });


it('masks both earlier and newly discovered input values in subsequent output chunks', async () => {
  const f = toolOwner(await root());
  await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { token: 'normalization-secret' } } }), signal());
  for (let index = 0; index < 20; index++) await f.owner.progress(turn, toolEvent(turn, `output-${index}`,
    { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'progress normalization-secret\n' } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'next-use', { type: 'tool_use', data: { id: 'next', tool: 'Bash', input: { token: 'another-private-value' } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'after-input-change', { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'normalization-secret another-private-value\n' } }), signal());
  for (const secret of ['normalization-secret', 'another-private-value']) expect(JSON.stringify(f.toolOutputs())).not.toContain(secret);
});

it.each([
  { name: 'OSC/BEL', start: '\x1b]52;c;', body: 'private-osc-data'.repeat(20), end: '\x07' },
  { name: 'OSC/ST', start: '\x1b]52;c;', body: 'private-osc-data'.repeat(20), end: '\x1b\\' },
  { name: 'CSI', start: '\x1b[', body: '123;'.repeat(100), end: 'm' },
])('keeps unfinished OSC or CSI data out of visible output: $name', async ({ start, body, end }) => {
  const f = toolOwner(await root());
  await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'osc', tool: 'Bash', input: {} } }), signal());
  const chunks = [start, ...Array.from({ length: 40 }, () => body)];
  for (const [index, output] of chunks.entries()) await f.owner.progress(turn, toolEvent(turn, `osc-${index}`,
    { type: 'tool_output', data: { id: 'osc', tool: 'Bash', output } }), signal());
  expect(JSON.stringify(f.toolOutputs())).not.toContain(body);
  await f.owner.progress(turn, toolEvent(turn, 'osc-end', { type: 'tool_output', data: { id: 'osc', tool: 'Bash', output: end + 'safe\n' } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'completed', { type: 'tool_result', data: { id: 'osc', content: '', isError: false } }), signal());
  expect((await f.snapshotHistory())?.history.entries[0]?.output).toBe('safe\n');
});

it('keeps a long nonmatching output suffix unchanged at tool completion', async () => {
  const f = toolOwner(await root());
  await f.store.create(record()); f.start(turn);
  const token = 'ab'.repeat(4000) + 'd';
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: { token } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output', { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'ab'.repeat(4000) + 'c' } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'tool', content: '', isError: false } }), signal());
  expect((await f.snapshotHistory())?.history.entries[0]?.output).toBe('ab'.repeat(4000) + 'c');
});

it('masks credentials found in the committed output span before delivery and persistence', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output', { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'using abc123secretvalue password=abc123secretvalue\n' } }), signal());
  const key = f.startedKey();
  expect(f.streamedText(key)).toBe('using [REDACTED] password=[REDACTED]\n');
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'tool', content: '', isError: false } }), signal());
  await f.finish(turn);
  expect(JSON.stringify(f.toolOutputs())).not.toContain('abc123secretvalue');
  expect(await readFile(toolHistoryFile(directory), 'utf8')).not.toContain('abc123secretvalue');
});

it.each(['input-only-secret', 'input-\x1b[31monly-secret'])('masks tool input before publishing or saving it while retaining input secrets for output redaction: %j', async (token) => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record()); f.start(turn);
  const input = { command: 'echo input-only-secret', api_key: token, nested: { note: 'input-only-secret' } };
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input } }), signal());
  expect(JSON.stringify(f.toolOutputs())).not.toContain('input-only-secret');
  expect(await readEntirePrivateFile(toolHistoryFile(directory))).toBeUndefined();
  await f.owner.progress(turn, toolEvent(turn, 'output', { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'using input-only-secret\n' } }), signal());
  const running = (await f.snapshotHistory())!.history.entries[0]!;
  expect(running).toMatchObject({ toolId: 'tool', status: 'running', output: '', input: { command: 'echo [REDACTED]', api_key: '[REDACTED]' } });
  expect(JSON.stringify(running)).not.toContain('input-only-secret');
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'tool', content: 'using input-only-secret', isError: false } }), signal());
  await f.finish(turn);
  for (const value of [JSON.stringify(f.toolOutputs()), JSON.stringify(await f.snapshotHistory()), await readFile(toolHistoryFile(directory), 'utf8')]) {
    expect(value).not.toContain('input-only-secret');
    expect(value).toContain('[REDACTED]');
  }
  expect(input.api_key).toBe(token);
});

it.each(['token=opaque echo opaque\n', 'echo opaque token=opaque\n'])(
  'applies same-body discoveries throughout delivered and persisted completed results: %j', async (content) => {
    const directory = await root();
    const f = toolOwner(directory);
    await f.store.create(record());
    f.start(turn);
    await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'probe', tool: 'Bash', input: {} } }), signal());
    await f.owner.progress(turn, toolEvent(turn, 'output', { type: 'tool_output', data: { id: 'probe', tool: 'Bash', output: 'token=opaque echo opaque\n' } }), signal());
    const key = f.startedKey();
    expect(f.streamedText(key)).toBe('token=[REDACTED] echo [REDACTED]\n');
    await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'probe', content, isError: false } }), signal());
    const expected = content.replaceAll('opaque', '[REDACTED]');
    expect(f.toolOutputs().at(-1)).toMatchObject({ kind: 'tool_completed', entry: { key, status: 'success', result: expected } });
    await f.finish(turn);
    expect((await f.snapshotHistory())!.history.entries[0]!.result).toBe(expected);
    expect((await f.store.readToolHistories(id)).at(-1)!.history.entries[0]!.result).toBe(expected);
    expect(await readFile(toolHistoryFile(directory), 'utf8')).not.toContain('opaque');
  },
);

it('masks a split tool-input secret and holds an unterminated suffix until completion', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const secret = 'live-secret-0123456789abcdef';
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'deploy', tool: 'Bash', input: { api_key: secret } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output-1', { type: 'tool_output', data: { id: 'deploy', tool: 'Bash', output: `using ${secret.slice(0, 12)}` } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output-2', { type: 'tool_output', data: { id: 'deploy', tool: 'Bash', output: `${secret.slice(12)} now\ndeploying` } }), signal());
  const key = f.startedKey();

  expect(f.streamedText(key)).toBe('using [REDACTED] now\n');
  for (const output of f.toolOutputs()) {
    if (output.kind === 'tool_started') expect(output.entry.output).toBe('');
  }
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'deploy', content: '', isError: false } }), signal());
  const completed = f.toolOutputs().at(-1);
  expect(completed).toMatchObject({ kind: 'tool_completed', entry: { key, status: 'success', output: 'using [REDACTED] now\ndeploying' } });
});

it.each(splitSecretScenarios.flatMap((scenario) => [
  { known: false, input: { command: 'cat deploy.env' } },
  { known: true, input: { command: 'cat deploy.env', api_key: 'seed-secret' } },
].map(({ known, input }) => ({ scenario, known, input }))))(
  'does not deliver any part of a secret that output chunks split in the middle of the value: $scenario.name (known=$known)',
  async ({ scenario, input }) => {
    const directory = await root();
    const f = toolOwner(directory);
    await f.store.create(record());
    f.start(turn);
    await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'env', tool: 'Bash', input } }), signal());
    for (const [index, output] of scenario.chunks.entries()) {
      await f.owner.progress(turn, toolEvent(turn, `output-${index}`, { type: 'tool_output', data: { id: 'env', tool: 'Bash', output } }), signal());
    }
    const key = f.startedKey();

    const text = scenarioText(scenario);
    expect(f.streamedText(key)).toBe(sensitiveText.sanitizeSensitiveTextWithKnownValues(text, text));
    await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'env', content: '', isError: false } }), signal());
    await f.finish(turn);
    const delivered = f.toolOutputs().flatMap((output) => output.kind === 'tool_output' ? [output.text]
      : output.kind === 'tool_completed' || output.kind === 'tool_started' ? [output.entry.output] : []);
    const saved = await readFile(toolHistoryFile(directory), 'utf8');
    for (const text of [f.streamedText(key), ...delivered, saved]) expect(secretFragmentsIn(text, scenario)).toEqual([]);
  },
);

it('skips malformed and invalid history rows without deleting valid entries or changing the file', async () => {
  const directory = await root(); const f = toolOwner(directory); await f.store.create(record());
  const first = savedToolEntry('first', 'first-tool');
  const last = savedToolEntry('last', 'last-tool');
  await f.store.appendCompletedTool(turn, first);
  await appendFile(toolHistoryFile(directory), '{\n' + toolHistoryLine({ kind: 'completed', entry: {} })
    + toolHistoryLine({ kind: 'completed', entry: { ...first, context: { callId: first.context.callId } } }));
  await f.store.appendCompletedTool(turn, last);
  const before = await readFile(toolHistoryFile(directory), 'utf8');
  for (const owner of [f, toolOwner(directory)]) {
    expect((await owner.snapshotHistory())!.history.entries).toEqual([first, last]);
    expect(await readFile(toolHistoryFile(directory), 'utf8')).toBe(before);
  }
});

it('persists completed entries only, bounds saved output and never restores running entries after restart', async () => {
  const directory = await root(); const f = toolOwner(directory); await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'start', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'partial', { type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: 'HEAD\n' + 'x'.repeat(2 * 1024 * 1024) + '\nTAIL' } }), signal());
  expect(await readEntirePrivateFile(toolHistoryFile(directory))).toBeUndefined();
  expect(await new ConversationStateStore(directory).readToolHistories(id)).toEqual([]);
  await f.owner.progress(turn, toolEvent(turn, 'complete', { type: 'tool_result', data: { id: 'tool', content: '', isError: false } }), signal());
  const delivered = f.toolOutputs().find((output) => output.kind === 'tool_completed');
  if (delivered?.kind !== 'tool_completed') throw new Error('Expected completed entry');
  expect(Buffer.byteLength(delivered.entry.output)).toBeLessThanOrEqual(1024 * 1024);
  const rows = (await readFile(toolHistoryFile(directory), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {kind: string});
  expect(rows).toHaveLength(1); expect(rows[0]!.kind).toBe('completed');
  const saved = (await new ConversationStateStore(directory).readToolHistories(id)).at(-1);
  const entry = saved!.history.entries[0]!;
  expect(Buffer.byteLength(entry.output)).toBeLessThanOrEqual(64 * 1024);
  expect(entry.output.startsWith('HEAD\n')).toBe(true); expect(entry.output.endsWith('\nTAIL')).toBe(true);
  await f.owner.progress(turn, toolEvent(turn, 'unfinished', { type: 'tool_use', data: { id: 'unfinished', tool: 'Bash', input: {} } }), signal());
  const restarted = toolOwner(directory);
  const history = await restarted.snapshotHistory();
  expect(history!.history.entries.map((entry) => entry.toolId)).toEqual(['tool']);
});

it('bounds the saved result to 64 KiB while keeping its head and tail', async () => {
  const directory = await root(); const f = toolOwner(directory); await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'start', { type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'complete', { type: 'tool_result',
    data: { id: 'tool', content: 'HEAD\n' + 'x'.repeat(256 * 1024) + '\nTAIL', isError: false } }), signal());
  const entry = (await new ConversationStateStore(directory).readToolHistories(id)).at(-1)!.history.entries[0]!;
  expect(Buffer.byteLength(entry.result!)).toBeLessThanOrEqual(64 * 1024);
  expect(entry.result!.startsWith('HEAD\n')).toBe(true); expect(entry.result!.endsWith('\nTAIL')).toBe(true);
});

it.each(['before write', 'partial write'] as const)('retains a completed entry after failed result persistence (%s) and retries it with the next append', async (failureMode) => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'saved-use', { type: 'tool_use', data: { id: 'saved', tool: 'Read', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'saved-result', { type: 'tool_result', data: { id: 'saved', content: 'Already persisted', isError: false } }), signal());
  const retained = 'retained output' + 'x'.repeat(20_000);
  await f.owner.progress(turn, toolEvent(turn, 'start', { type: 'tool_use', data: { id: 'first', tool: 'Bash', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output', { type: 'tool_output', data: { id: 'first', tool: 'Bash', output: retained } }), signal());
  const failure = new Error('History append unavailable');
  if (failureMode === 'before write') vi.spyOn(f.store, 'appendCompletedTool').mockRejectedValueOnce(failure);
  else vi.spyOn(privateFiles, 'appendPrivateFile').mockImplementationOnce(async (path, content) => {
    const bytes = Buffer.from(content);
    await appendFile(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    throw failure;
  });
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'first', content: '', isError: false } }), signal());
  await expect(f.finish(turn)).resolves.toBeUndefined();
  expect(f.errors).toEqual([failure]);
  expect(f.toolOutputs()).toContainEqual(expect.objectContaining({ kind: 'tool_completed', entry: expect.objectContaining({ toolId: 'first', output: retained }) }));
  expect((await f.snapshotHistory())!.history.entries).toMatchObject([{ toolId: 'saved' }, { toolId: 'first', output: retained }]);
  expect((await f.store.readToolHistories(id)).at(-1)!.history.entries.map((entry) => entry.toolId)).toEqual(['saved']);
  const next = { ...turn, operationId: randomUUID(), generation: turn.generation + 1 };
  f.start(next);
  await f.owner.progress(next, toolEvent(next, 'start-next', { type: 'tool_use', data: { id: 'next', tool: 'Read', input: {} } }), signal());
  expect((await f.snapshotHistory())!.history.entries.find((entry) => entry.toolId === 'first')).toMatchObject({ toolId: 'first', output: retained });
  await f.owner.progress(next, toolEvent(next, 'result-next', { type: 'tool_result', data: { id: 'next', content: 'next result', isError: false } }), signal());
  await f.finish(next);
  const histories = await new ConversationStateStore(directory).readToolHistories(id);
  expect(histories.flatMap((history) => history.history.entries.map((entry) => entry.toolId))).toEqual(['saved', 'first', 'next']);
  expect((await toolOwner(directory).snapshotHistory())!.history.entries.find((entry) => entry.toolId === 'first')).toMatchObject({ toolId: 'first', output: retained });
});

it('sends committed appended chunks and retains bounded head/tail output on completion', async () => {
  const f = toolOwner(await root());
  await f.store.create(record()); f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'long-use', { type: 'tool_use', data: { id: 'long', tool: 'Bash', input: { command: 'npm test' } } }), signal());
  const delivered = f.toolOutputs().length;
  const chunk = `${'o'.repeat(1023)}\n`;
  const count = 3000;
  for (let index = 0; index < count; index++) {
    await f.owner.progress(turn, toolEvent(turn, `long-output-${index}`, { type: 'tool_output', data: { id: 'long', tool: 'Bash', output: chunk } }), signal());
  }
  const updates = f.toolOutputs().slice(delivered);
  expect(updates).toHaveLength(count);
  for (const update of updates) expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(chunk.length + 1024);
  expect(f.streamedText(f.startedKey())).toBe(chunk.repeat(count));
  await f.owner.progress(turn, toolEvent(turn, 'long-result', { type: 'tool_result', data: { id: 'long', content: '', isError: false } }), signal());
  const entry = (await f.snapshotHistory())!.history.entries[0]!;
  expect(entry).toMatchObject({ toolId: 'long', status: 'success' });
  expect(Buffer.byteLength(entry.output)).toBeLessThanOrEqual(RETAINED_TOOL_OUTPUT_BYTES);
  expect(entry.output.startsWith(chunk)).toBe(true);
  expect(entry.output.endsWith(chunk)).toBe(true);
  expect(f.errors).toEqual([]);
});
