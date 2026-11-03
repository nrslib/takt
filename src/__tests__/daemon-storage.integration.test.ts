import { once } from 'node:events';
import * as spawnModule from '../shared/utils/spawn.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from '../infra/daemon/privateFile.js';
import { readDaemonOwner, registerDaemonOwner, removeDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { conversationIpcEndpoint, readDaemonIpcState, resolveDaemonConfigDirectory, writeDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import type { AcceptedEvent } from '../core/daemon/events.js';
import type { TurnResult } from '../core/daemon/messages.js';
import type { IoOptions } from '../core/daemon/io.js';
import { deferred } from './helpers/controlledDaemon.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const injection = vi.hoisted(() => ({ beforeSync: undefined as (() => Promise<void>) | undefined, afterRename: undefined as (() => void) | undefined, renameFailure: false, afterRenameFailure: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
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
  injection.beforeSync = undefined; injection.afterRename = undefined; injection.renameFailure = false; injection.afterRenameFailure = false;
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('durable daemon event storage', () => {
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

  it('reconciles a committed acceptance whose acknowledgement failed', async () => {
    const directory = await root();
    const store = new FileEventStore(directory);
    const input = event('uncertain', 1);
    injection.afterRenameFailure = true;
    await expect(store.accept(input)).rejects.toThrow();
    expect(await store.accept(input)).toEqual({ kind: 'duplicate', event: input, state: 'queued' });
    expect((await new FileEventStore(directory).restore()).lastAcceptedSequence).toBe(1);
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
