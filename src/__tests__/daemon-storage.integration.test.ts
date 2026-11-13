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
import { ensurePrivateDirectory, readEntirePrivateFile, readPrivateFile, writePrivateFile } from '../infra/daemon/privateFile.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import * as sensitiveText from '../shared/utils/sensitiveText.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { ToolHistoryPersistenceError } from '../core/daemon/toolHistoryPersistenceError.js';
import type { OutputVersion, PortOutput } from '../features/manager/conversationPort.js';
import type { ConversationToolEvent } from '../shared/types/conversation-activity.js';
import { readDaemonOwner, registerDaemonOwner, removeDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { conversationIpcEndpoint, readDaemonIpcState, resolveDaemonConfigDirectory, writeDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationRecordSchema } from '../infra/conversations/schema.js';
import type { AcceptedEvent } from '../core/daemon/events.js';
import type { TurnIdentity, TurnResult } from '../core/daemon/messages.js';
import type { IoOptions } from '../core/daemon/io.js';
import { deferred } from './helpers/controlledDaemon.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

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
    async (_conversation, output, version) => { outputs.push({ output, version }); }, (error) => { errors.push(error); });
  const accepted = (identity: TurnIdentity): AcceptedEvent => ({ ...event(identity.operationId, identity.generation),
    conversationId: identity.conversationId, operationId: identity.operationId });
  return { store, owner, outputs, errors,
    start(identity: TurnIdentity) {
      owner.started({ turn: identity, event: accepted(identity), state: { version: 0, assignment,
        session: { provider: 'codex', model: null, sessionId: null }, revision: 0, pending: null, approval: null } });
    },
    finish(identity: TurnIdentity) {
      return owner.apply({ ...identity, event: accepted(identity), outcome: { kind: 'completed', result: { kind: 'reply', message: 'done' } } });
    },
    async snapshotHistory() {
      const snapshot = await owner.snapshot(id);
      const items = [];
      for await (const item of snapshot.items) items.push(item);
      snapshot.complete();
      const history = items.find((item) => item.kind === 'tool_history');
      return history?.kind === 'tool_history' ? history.history : undefined;
    },
    toolOutputs() { return outputs.map(({ output }) => output).filter((output) => output.kind !== 'user_message' && output.kind !== 'running'); },
    streamedText(key: string) {
      return outputs.flatMap(({ output }) => output.kind === 'tool_history_update' && output.update.output?.key === key
        ? [output.update.output.text] : []).join('');
    },
  };
}
const toolHistoryFile = (directory: string) => join(directory, 'conversation-tool-history', `${id}.jsonl`);
const toolHistoryLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const savedToolEntry = (key: string, toolId: string) => ({ key, toolId, tool: 'Read', input: {}, output: '', result: toolId,
  status: 'success', association: 'matched', context: { callId: 'call', operationId: turn.operationId, generation: turn.generation } });

it('sends, clones, and redacts only the appended part of each output chunk of a long-running tool', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'long-use', { type: 'tool_use', data: { id: 'long', tool: 'Bash', input: { command: 'npm test' } } }), signal());
  const delivered = f.toolOutputs().length;
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const sanitize = vi.spyOn(sensitiveText, 'sanitizeSensitiveTextWithKnownValues');
  const redacted: string[] = [];
  const createRedactor = sensitiveText.createSensitiveTextStreamRedactor;
  vi.spyOn(sensitiveText, 'createSensitiveTextStreamRedactor').mockImplementation(() => {
    const redactor = createRedactor();
    return { write: (text, source) => { redacted.push(text); return redactor.write(text, source); },
      flushAvailable: (source) => redactor.flushAvailable(source), flush: (source) => redactor.flush(source) };
  });
  const chunk = `${'o'.repeat(1023)}\n`;
  const count = 3000;
  for (let index = 0; index < count; index++) {
    await f.owner.progress(turn, toolEvent(turn, `long-output-${index}`, { type: 'tool_output', data: { id: 'long', tool: 'Bash', output: chunk } }), signal());
  }

  const updates = f.toolOutputs().slice(delivered);
  expect(updates).toHaveLength(count);
  for (const update of updates) expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(chunk.length + 1024);
  for (const [value] of clone.mock.calls) expect(JSON.stringify(value).length).toBeLessThan(chunk.length);
  for (const [text] of sanitize.mock.calls) expect(text.length).toBeLessThanOrEqual(chunk.length);
  expect(redacted).toHaveLength(count);
  for (const text of redacted) expect(text).toBe(chunk);
  const key = (await f.snapshotHistory())!.history.entries[0]!.key;
  expect(f.streamedText(key)).toBe(chunk.repeat(count));
  expect((await f.snapshotHistory())?.history.entries[0]).toMatchObject({ toolId: 'long', status: 'running', output: chunk.repeat(count) });
  expect(f.errors).toEqual([]);
}, 120_000);

it('does not deliver a secret tool input value split across output chunks and sends the held part on completion', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const secret = 'live-secret-0123456789abcdef';
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'deploy', tool: 'Bash', input: { api_key: secret } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output-1', { type: 'tool_output', data: { id: 'deploy', tool: 'Bash', output: `using ${secret.slice(0, 12)}` } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'output-2', { type: 'tool_output', data: { id: 'deploy', tool: 'Bash', output: `${secret.slice(12)} now\ndeploying` } }), signal());
  const key = (await f.snapshotHistory())!.history.entries[0]!.key;

  expect(f.streamedText(key)).toBe('using [REDACTED] now\n');
  for (const output of f.toolOutputs()) {
    if (output.kind !== 'tool_history_update') continue;
    for (const entry of output.update.entries) expect(entry.output).toBe('');
  }
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'deploy', content: '', isError: false } }), signal());
  const completed = f.toolOutputs().at(-1);
  expect(completed).toMatchObject({ kind: 'tool_history_update', update: { entries: [{ key, status: 'success', output: 'using [REDACTED] now\ndeploying' }] } });
});

it('does not save or deliver the first part of a secret when the output chunks after it were dropped', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const secret = 'live-secret-0123456789abcdef';
  const leaked = secret.slice(0, 9);
  await f.owner.progress(turn, toolEvent(turn, 'use', { type: 'tool_use', data: { id: 'deploy', tool: 'Bash', input: { api_key: secret } } }), signal());
  // 後半のチャンクは dispatcher の待ち行列があふれて落ちたので、daemon には届かない。
  await f.owner.progress(turn, toolEvent(turn, 'output-1', { type: 'tool_output', data: { id: 'deploy', tool: 'Bash', output: `using ${leaked}` } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'result', { type: 'tool_result', data: { id: 'deploy', content: `using ${secret} now`, isError: false } }), signal());
  await f.finish(turn);

  const finished = await f.snapshotHistory();
  expect(finished?.history.entries).toHaveLength(1);
  expect(finished?.history.entries[0]).toMatchObject({ toolId: 'deploy', status: 'success', result: 'using [REDACTED] now' });
  expect(finished?.history.entries[0]?.output).not.toContain(leaked);
  // ツール入力は秘密値全体を持ち、表示時に伏せる。ここでは出力と結果だけを確かめる。
  const saved = (await readFile(toolHistoryFile(directory), 'utf8')).split('\n').filter((line) => line !== '')
    .flatMap((line) => (JSON.parse(line) as { entries?: Array<{ output: string; result?: string }> }).entries ?? []);
  expect(saved.length).toBeGreaterThan(0);
  for (const entry of saved) {
    expect(entry.output).not.toContain(leaked);
    expect(entry.result ?? '').not.toContain(leaked);
  }
  const delivered = f.toolOutputs().flatMap((output) => output.kind === 'tool_history_update'
    ? [...output.update.entries.flatMap((entry) => [entry.output, entry.result ?? '']), output.update.output?.text ?? '']
    : output.kind === 'tool_history' ? output.history.history.entries.flatMap((entry) => [entry.output, entry.result ?? '']) : []);
  expect(delivered.length).toBeGreaterThan(0);
  for (const text of delivered) expect(text).not.toContain(leaked);
});

it('opens a conversation whose tool history has a broken line in the middle and replaces that file on the next write', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  await writePrivateFile(toolHistoryFile(directory), toolHistoryLine({ kind: 'turn', operationId: turn.operationId, generation: turn.generation })
    + '{"kind":"change","sequ\n'
    + toolHistoryLine({ kind: 'change', sequence: 2, entries: [savedToolEntry('1', 'a')] }));
  await expect(f.store.readToolHistory(id)).rejects.toThrow();

  await expect(f.snapshotHistory()).resolves.toBeUndefined();
  expect(f.errors).toHaveLength(1);

  const next = { ...turn, operationId: 'turn-2', generation: 2 };
  f.start(next);
  await f.finish(next);
  expect(await f.store.readToolHistory(id)).toBeUndefined();
  await expect(f.snapshotHistory()).resolves.toBeUndefined();
  expect(f.toolOutputs().filter((output) => output.kind === 'result')).toHaveLength(1);
});

it('rewrites the whole tool history at the next event after an append fails partway', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  await f.owner.progress(turn, toolEvent(turn, 'a-use', { type: 'tool_use', data: { id: 'a', tool: 'Read', input: { file_path: 'a.ts' } } }), signal());
  const append = privateFiles.appendPrivateFile;
  const failure = vi.spyOn(privateFiles, 'appendPrivateFile').mockImplementationOnce(async (path, content) => {
    await append(path, content.slice(0, 20));
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  });
  await expect(f.owner.progress(turn, toolEvent(turn, 'a-result', { type: 'tool_result', data: { id: 'a', content: 'a-done', isError: false } }), signal()))
    .rejects.toBeInstanceOf(ToolHistoryPersistenceError);
  failure.mockRestore();
  const write = vi.spyOn(privateFiles, 'writePrivateFile');
  await f.owner.progress(turn, toolEvent(turn, 'b-use', { type: 'tool_use', data: { id: 'b', tool: 'Read', input: { file_path: 'b.ts' } } }), signal());

  expect(write).toHaveBeenCalledOnce();
  expect(await f.store.readToolHistory(id)).toMatchObject({ operationId: turn.operationId,
    history: { sequence: 3, entries: [{ toolId: 'a', status: 'success', result: 'a-done' }, { toolId: 'b', status: 'running' }] } });
  const appendAgain = vi.spyOn(privateFiles, 'appendPrivateFile');
  await f.owner.progress(turn, toolEvent(turn, 'b-result', { type: 'tool_result', data: { id: 'b', content: 'b-done', isError: false } }), signal());
  expect(appendAgain).toHaveBeenCalledOnce();
  expect((await f.store.readToolHistory(id))?.history.entries).toMatchObject([{ toolId: 'a' }, { toolId: 'b', status: 'success', result: 'b-done' }]);
});

it('restores only the records before an unterminated last line of the tool history file', async () => {
  const directory = await root();
  const store = new ConversationStateStore(directory);
  await writePrivateFile(toolHistoryFile(directory), toolHistoryLine({ kind: 'turn', operationId: turn.operationId, generation: turn.generation })
    + toolHistoryLine({ kind: 'change', sequence: 2, entries: [savedToolEntry('1', 'a')] })
    + JSON.stringify({ kind: 'change', sequence: 4, entries: [savedToolEntry('2', 'b')] }).slice(0, -3));

  expect(await store.readToolHistory(id)).toEqual({ operationId: turn.operationId, generation: turn.generation, finished: false,
    history: { sequence: 2, entries: [savedToolEntry('1', 'a')] } });
});

it('reads a tool history file whose records still carry event IDs from the former format', async () => {
  const directory = await root();
  const store = new ConversationStateStore(directory);
  await writePrivateFile(toolHistoryFile(directory), toolHistoryLine({ kind: 'turn', operationId: turn.operationId, generation: turn.generation })
    + toolHistoryLine({ kind: 'change', eventIds: ['a-use', 'a-result'], sequence: 2, entries: [savedToolEntry('1', 'a')] })
    + toolHistoryLine({ kind: 'finished' }));

  expect(await store.readToolHistory(id)).toEqual({ operationId: turn.operationId, generation: turn.generation, finished: true,
    history: { sequence: 2, entries: [savedToolEntry('1', 'a')] } });
});

it('processes each tool event without rereading or rewriting the whole history', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const read = vi.spyOn(f.store, 'read');
  const readHistory = vi.spyOn(f.store, 'readToolHistory');
  const readFile = vi.spyOn(privateFiles, 'readEntirePrivateFile');
  const write = vi.spyOn(privateFiles, 'writePrivateFile');
  const append = vi.spyOn(privateFiles, 'appendPrivateFile');
  const chunk = 'o'.repeat(16 * 1024);
  const count = 1000;
  for (let index = 0; index < count; index++) {
    const toolId = `tool-${index}`;
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-use`, { type: 'tool_use', data: { id: toolId, tool: 'Bash', input: { command: `run ${index}` } } }), signal());
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-output`, { type: 'tool_output', data: { id: toolId, tool: 'Bash', output: chunk } }), signal());
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-result`, { type: 'tool_result', data: { id: toolId, content: chunk, isError: false } }), signal());
    expect(read).not.toHaveBeenCalled();
    expect(readHistory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  }

  expect(f.errors).toEqual([]);
  expect(write).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledTimes(count * 2);
  for (const [, content] of append.mock.calls) expect(Buffer.byteLength(content)).toBeLessThan(3 * chunk.length);
  const outputs = f.toolOutputs();
  expect(outputs).toHaveLength(count * 3);
  for (const output of outputs) {
    expect(output.kind).toBe('tool_history_update');
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(3 * chunk.length);
  }
  const history = await f.snapshotHistory();
  expect(history?.history.entries).toHaveLength(count);
  expect(history?.history.entries.at(-1)).toMatchObject({ toolId: `tool-${count - 1}`, output: '', result: chunk, status: 'success' });
}, 120_000);

it('returns a large running and finished tool history on repeated snapshots without rereading or redacting it again', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const chunk = 'o'.repeat(16 * 1024);
  const count = 1000;
  for (let index = 0; index < count; index++) {
    const toolId = `tool-${index}`;
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-use`, { type: 'tool_use', data: { id: toolId, tool: 'Bash', input: { command: `run ${index}` } } }), signal());
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-output`, { type: 'tool_output', data: { id: toolId, tool: 'Bash', output: chunk } }), signal());
    await f.owner.progress(turn, toolEvent(turn, `${toolId}-result`, { type: 'tool_result', data: { id: toolId, content: chunk, isError: false } }), signal());
  }
  await f.owner.progress(turn, toolEvent(turn, 'last-use', { type: 'tool_use', data: { id: 'last', tool: 'Bash', input: { command: 'tail' } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'last-output', { type: 'tool_output', data: { id: 'last', tool: 'Bash', output: 'streaming\n' } }), signal());
  const readHistory = vi.spyOn(f.store, 'readToolHistory');
  const readFile = vi.spyOn(privateFiles, 'readEntirePrivateFile');
  const sanitize = vi.spyOn(sensitiveText, 'sanitizeSensitiveTextWithKnownValues');
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const expectNoRework = () => {
    expect(readHistory).not.toHaveBeenCalled();
    expect(readFile.mock.calls.filter(([path]) => path.includes('conversation-tool-history'))).toEqual([]);
    expect(sanitize).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  };

  for (let refresh = 0; refresh < 5; refresh++) {
    const history = await f.snapshotHistory();
    expect(history?.history.entries).toHaveLength(count + 1);
    expect(history?.history.entries.at(-1)).toMatchObject({ toolId: 'last', status: 'running', output: 'streaming\n' });
  }
  expectNoRework();
  await f.owner.progress(turn, toolEvent(turn, 'last-result', { type: 'tool_result', data: { id: 'last', content: 'done', isError: false } }), signal());
  await f.finish(turn);
  readHistory.mockClear(); readFile.mockClear(); sanitize.mockClear(); clone.mockClear();
  for (let refresh = 0; refresh < 5; refresh++) {
    const history = await f.snapshotHistory();
    expect(history).toMatchObject({ finished: true, history: { sequence: count * 3 + 3 } });
    expect(history?.history.entries).toHaveLength(count + 1);
  }
  expectNoRework();
  expect(f.errors).toEqual([]);
}, 120_000);

it('keeps saving tool history that takes longer than the former five-second lock deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const release = deferred<void>();
  const write = privateFiles.writePrivateFile;
  const append = privateFiles.appendPrivateFile;
  vi.spyOn(privateFiles, 'writePrivateFile').mockImplementation(async (path, content, abort) => {
    if (path.includes('conversation-tool-history')) await release.promise;
    await write(path, content, abort);
  });
  vi.spyOn(privateFiles, 'appendPrivateFile').mockImplementation(async (path, content) => {
    await release.promise;
    await append(path, content);
  });
  const progress = f.owner.progress(turn, toolEvent(turn, 'slow-use', { type: 'tool_use', data: { id: 'slow', tool: 'Bash', input: { command: 'run' } } }), signal());
  await vi.advanceTimersByTimeAsync(10_000);
  release.resolve();

  await expect(progress).resolves.toBeUndefined();
  expect(f.toolOutputs()).toMatchObject([{ kind: 'tool_history_update', update: { entries: [{ toolId: 'slow', status: 'running' }] } }]);
  expect(f.errors).toEqual([]);
});

it('restores the whole current history on reconnect, ignores repeated and stale events, and restores the finished history after a restart', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const use = toolEvent(turn, 'a-use', { type: 'tool_use', data: { id: 'a', tool: 'Read', input: { file_path: 'a.ts' } } });
  await f.owner.progress(turn, use, signal());
  await f.owner.progress(turn, toolEvent(turn, 'a-output', { type: 'tool_output', data: { id: 'a', tool: 'Read', output: 'partial' } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'a-result', { type: 'tool_result', data: { id: 'a', content: 'done', isError: false } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'b-use', { type: 'tool_use', data: { id: 'b', tool: 'Bash', input: { command: 'sleep' } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'b-output', { type: 'tool_output', data: { id: 'b', tool: 'Bash', output: 'waiting' } }), signal());
  const delivered = f.toolOutputs().length;
  await f.owner.progress(turn, use, signal());
  const stale = { ...turn, generation: 2 };
  await f.owner.progress(stale, toolEvent(stale, 'stale-use', { type: 'tool_use', data: { id: 'c', tool: 'Read', input: {} } }), signal());
  expect(f.toolOutputs()).toHaveLength(delivered);

  expect(await f.snapshotHistory()).toMatchObject({ operationId: turn.operationId, generation: turn.generation, finished: false,
    history: { sequence: 5, entries: [
      { toolId: 'a', output: '', result: 'done', status: 'success' },
      { toolId: 'b', output: 'waiting', status: 'running' },
    ] } });
  await f.finish(turn);
  const finished = f.toolOutputs().filter((output) => output.kind === 'tool_history').at(-1);
  expect(finished).toMatchObject({ kind: 'tool_history', history: { finished: true, history: { entries: [{ toolId: 'a', status: 'success' }] } } });
  if (finished?.kind !== 'tool_history') throw new Error('Missing finished tool history');
  expect(finished.history.history.entries).toHaveLength(1);

  const readFile = vi.spyOn(privateFiles, 'readEntirePrivateFile');
  const restarted = toolOwner(directory);
  expect(await restarted.snapshotHistory()).toEqual(finished.history);
  expect(readFile).toHaveBeenCalledWith(expect.stringContaining(join('conversation-tool-history', id)));
  expect(f.errors).toEqual([]);
});

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

it('reads a conversation saved with tool history in its state and drops that history on the next save', async () => {
  const directory = await root();
  await writePrivateFile(join(directory, 'conversations', `${id}.json`), JSON.stringify({ ...record(),
    daemonState: { version: 0, receipts: [], toolHistory: { operationId: 'old', generation: 1, finished: true, eventIds: [],
      history: { entries: [], sequence: 0 } } } }));
  const store = new ConversationStateStore(directory);
  expect((await store.read(id))!.state.version).toBe(0);
  await store.save(turn, { operationId: 'session-save', expectedVersion: 0,
    session: { provider: 'codex', model: null, sessionId: 'saved-session' } }, signal());
  expect(await readFile(join(directory, 'conversations', `${id}.json`), 'utf8')).not.toContain('toolHistory');
});

it('redacts secret tool input values from delivered and stored results without truncating them', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  f.start(turn);
  const secret = `private-${'x'.repeat(9 * 1024)}`;
  await f.owner.progress(turn, toolEvent(turn, 'secret-use', { type: 'tool_use', data: { id: 'secret-tool', tool: 'Bash', input: { api_key: secret } } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'secret-result', { type: 'tool_result', data: { id: 'secret-tool', content: `echo ${secret}`, isError: false } }), signal());
  const output = 'x'.repeat(16 * 1024 + 1);
  await f.owner.progress(turn, toolEvent(turn, 'stream-use', { type: 'tool_use', data: { id: 'stream-tool', tool: 'Bash', input: {} } }), signal());
  await f.owner.progress(turn, toolEvent(turn, 'stream-output', { type: 'tool_output', data: { id: 'stream-tool', tool: 'Bash', output } }), signal());

  const streamKey = (await f.snapshotHistory())!.history.entries[1]!.key;
  expect(f.streamedText(streamKey)).not.toBe('');
  expect(output.startsWith(f.streamedText(streamKey))).toBe(true);
  await f.owner.progress(turn, toolEvent(turn, 'stream-result', { type: 'tool_result', data: { id: 'stream-tool', content: '', isError: false } }), signal());

  const entries = f.toolOutputs().flatMap((value) => value.kind === 'tool_history_update' ? value.update.entries : []);
  expect(entries.filter((entry) => entry.toolId === 'secret-tool').map((entry) => entry.result)).toEqual([undefined, 'echo [REDACTED]']);
  expect(entries.filter((entry) => entry.toolId === 'stream-tool').at(-1)).toMatchObject({ status: 'success', output });
  await f.finish(turn);
  expect((await f.store.readToolHistory(id))?.history.entries[0]?.result).toBe('echo [REDACTED]');
});

it('rejects events from another turn and removes the previous history when a later turn uses no tools', async () => {
  const directory = await root();
  const f = toolOwner(directory);
  await f.store.create(record());
  const next = { ...turn, operationId: 'turn-2', generation: 2 };
  f.start(turn);
  await expect(f.owner.progress(turn, toolEvent(next, 'foreign', { type: 'tool_use', data: { id: 'reused', tool: 'Read', input: {} } }), signal()))
    .rejects.toBeInstanceOf(ToolHistoryPersistenceError);
  await f.finish(turn);
  f.start(next);
  await f.owner.progress(next, toolEvent(next, 'start', { type: 'tool_use', data: { id: 'reused', tool: 'Read', input: {} } }), signal());
  await f.finish(next);
  expect(await f.store.readToolHistory(id)).toMatchObject({ operationId: 'turn-2', finished: true, history: { entries: [] } });
  const third = { ...turn, operationId: 'turn-3', generation: 3 };
  f.start(third);
  await f.finish(third);
  expect(await f.store.readToolHistory(id)).toBeUndefined();
  expect(await f.snapshotHistory()).toBeUndefined();
  expect((await f.store.read(id))!.state.version).toBe(0);
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

  it('reports a size problem only for reads that have a byte bound', async () => {
    const directory = await root();
    const unbounded = await readEntirePrivateFile(directory).then(() => undefined, (error: unknown) => error);
    expect(unbounded).toBeInstanceOf(Error);
    expect((unbounded as Error).message).toMatch(/^Invalid private file: /u);
    expect((unbounded as Error).message).not.toMatch(/oversized|capacity/iu);
    const path = join(directory, 'data');
    await writePrivateFile(path, 'four');
    await expect(readPrivateFile(path, 3)).rejects.toThrow(/capacity/u);
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
