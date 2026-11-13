import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationDaemon } from './helpers/conversation-daemon.js';
import { humanTurnText } from './helpers/daemon-turn.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { conversationId } from '../infra/conversations/identity.js';
import { deferred, input, accepted } from './helpers/controlledDaemon.js';
import { createManagerTurnExecutor, type ManagerTurnInput } from '../features/manager/turnExecutor.js';
import { runFormalSpecVerification } from '../features/interactive/formalSpecVerification.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import * as conversationPlan from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { createConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { EventRecordSchema } from '../infra/daemon/eventRecord.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { receiveInboxChange } from '../features/daemon/inbox.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import type { ToolActivityEntry } from '../shared/tool-activity/types.js';

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: vi.fn(), cleanupFormalSpecVerificationArtifacts: vi.fn(),
}));

vi.mock('../features/manager/assignment.js', async (original) => {
  const actual = await original<typeof import('../features/manager/assignment.js')>();
  return { ...actual, resolveCurrentManagerAssignment: async (...[assignment, directory]: Parameters<typeof actual.resolveCurrentManagerAssignment>) =>
    assignment.kind === 'repository' ? { ...assignment, repositoryDirectories: [assignment.repositoryDirectory] }
      : actual.resolveCurrentManagerAssignment(assignment, directory) };
});
const execute = vi.fn(async (value: ManagerTurnInput) => ({ message: value.prompt, summary: null, sessionId: 'persisted-session', assignment: value.assignment }));
const resolveRuntime = vi.fn();
let fixture: Awaited<ReturnType<typeof conversationDaemon>>;
let repository: string;
let id: string;
beforeEach(async () => {
  execute.mockClear();
  resolveRuntime.mockReset();
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor: { execute } });
  const directory = getGlobalConfigDir(); repository = join(directory, 'repository');
  await mkdir(join(repository, '.takt'), { recursive: true });
  await writeFile(join(repository, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
  await mkdir(join(directory, 'conversations'), { recursive: true });
  const record = conversationRecord(repository); id = record.id;
  await writeFile(join(directory, 'conversations', `${id}.json`), JSON.stringify(record));
  fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
});
afterEach(async () => { await fixture.close(); vi.restoreAllMocks(); });

async function open() {
  const outputs: PortOutput[] = [];
  const completed = deferred<Extract<PortOutput, { kind: 'result' }>>();
  const attachment = await fixture.input.open({ conversationId: id, assignment: { kind: 'repository', repositoryDirectory: repository },
    speaker: { namespace: 'local', id: 'operator' }, binding: { port: 'tui', key: randomUUID(), counterpart: { namespace: 'local', id: 'operator' } } }, {
    async deliver(_id, output) { outputs.push(output); if (output.kind === 'result') completed.resolve(output); return { kind: 'delivered' }; },
  });
  attachment.read.cancel();
  return { ...attachment, outputs, completed, submit: (text: string) => fixture.input.submit({ attachmentId: attachment.attachmentId, requestId: randomUUID(), speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'message', text } }) };
}

type WrittenToolHistoryRecord = { kind: 'turn' } | { kind: 'change'; entries: ToolActivityEntry[] } | { kind: 'finished' };
function writtenToolHistory(path: string, content: string | Uint8Array): WrittenToolHistoryRecord[] {
  if (!path.endsWith(join('conversation-tool-history', `${id}.jsonl`))) return [];
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as WrittenToolHistoryRecord);
}

it('persists the session and applies the human response to the current proposal', async () => {
  const port = await open();
  expect(await port.submit('continue the existing goal')).toMatchObject({ kind: 'accepted', acceptedSequence: 1 });
  expect((await port.completed.promise).result).toMatchObject({ kind: 'reply' });
  await fixture.dispatcher.drain();
  expect((await fixture.store.read(id))!.state).toMatchObject({ revision: 5, pending: null, session: { sessionId: 'persisted-session' } });
  expect(execute.mock.calls[0]![0].sessionId).toBe('provider-session');
  expect((await fixture.store.read(id))!.state.session.contextKey).toBe('test');
});

it.each(['start', 'result', 'delivery'] as const)('preserves the acquired change without repeating the provider after a history %s failure', async (failure) => {
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: 'Read', input: { file_path: 'a.ts' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'tool', content: 'ready', isError: false } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), sessionId: 'acquired-session',
      structuredOutput: { message: 'done', summary: null } };
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor });
  const append = privateFiles.appendPrivateFile; let failed = false;
  vi.spyOn(privateFiles, 'appendPrivateFile').mockImplementation(async (path, content) => {
    if (failure !== 'delivery' && !failed && writtenToolHistory(path, content).some((record) => record.kind === 'change'
      && record.entries.some((entry) => failure === 'start' ? entry.status === 'running' : entry.status === 'success'))) {
      failed = true; throw new Error('Injected publication failure');
    }
    await append(path, content);
  });
  const completed = deferred<Extract<PortOutput, { kind: 'result' }>>();
  const attachment = await fixture.input.open({ conversationId: id, assignment: { kind: 'repository', repositoryDirectory: repository },
    speaker: { namespace: 'local', id: 'operator' }, binding: { port: 'tui', key: randomUUID(), counterpart: { namespace: 'local', id: 'operator' } } }, {
    async deliver(_id, output) {
      if (failure === 'delivery' && output.kind === 'tool_history_update' && !failed) { failed = true; throw new Error('Injected delivery failure'); }
      if (output.kind === 'result') completed.resolve(output);
      return { kind: 'delivered' };
    },
  });
  attachment.read.cancel();
  const admission = await fixture.input.submit({ attachmentId: attachment.attachmentId, requestId: randomUUID(),
    speaker: { namespace: 'local', id: 'operator' }, command: { kind: 'message', text: 'Read once' } });
  expect(admission).toMatchObject({ kind: 'accepted' });
  const result = await completed.promise;
  await expect(fixture.settled()).rejects.toThrow();
  expect(failed).toBe(true);
  expect(result.result).toMatchObject(failure === 'delivery' ? { kind: 'reply', message: 'done' } : { kind: 'error', code: 'failed' });
  expect((await fixture.store.read(id))!.state.session.sessionId).toBe('acquired-session');
  const records = await fixture.events.restore();
  const pending = []; for await (const event of records.pending) pending.push(event);
  expect(pending).toHaveLength(0);
  expect(fixture.dispatcher.activeTurnCount).toBe(0);
  expect(call).toHaveBeenCalledOnce();
  if (failure === 'delivery') {
    const snapshot = await fixture.conversations.snapshot(id);
    const items = []; for await (const item of snapshot.items) items.push(item);
    snapshot.complete();
    expect(items.find((item) => item.kind === 'tool_history')).toMatchObject({ history: { finished: true,
      history: { entries: [{ status: 'success', result: 'ready' }] } } });
  }
});

it('releases the running state and delivers the result when finishing the tool history fails', async () => {
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    options.onStream!({ type: 'tool_use', data: { id: 'tool', tool: 'Read', input: { file_path: 'a.ts' } } });
    options.onStream!({ type: 'tool_result', data: { id: 'tool', content: 'ready', isError: false } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), sessionId: 'acquired-session',
      structuredOutput: { message: 'done', summary: null } };
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor });
  const write = privateFiles.writePrivateFile;
  vi.spyOn(privateFiles, 'writePrivateFile').mockImplementation(async (path, content, signal) => {
    if (writtenToolHistory(path, content).some((record) => record.kind === 'finished')) throw new Error('Injected finish failure');
    await write(path, content, signal);
  });
  const port = await open();
  expect(await port.submit('Read once')).toMatchObject({ kind: 'accepted' });
  await expect(fixture.settled()).rejects.toThrow();
  expect(fixture.failures).toContainEqual(expect.objectContaining({ message: 'Injected finish failure' }));
  expect(port.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({ kind: 'reply', message: 'done' }) }));
  expect(port.outputs).toContainEqual(expect.objectContaining({ kind: 'pending', state: expect.objectContaining({ running: null }) }));
  const snapshot = await fixture.conversations.snapshot(id);
  const items = []; for await (const item of snapshot.items) items.push(item);
  snapshot.complete();
  expect(items.find((item) => item.kind === 'state')).toMatchObject({ state: { running: null } });
  expect((await fixture.store.read(id))!.state.session.sessionId).toBe('acquired-session');
});

it.each([1, 2])('replaces persisted history after the daemon restarts its generation counter following %s completed turns', async (previousTurns) => {
  let invocation = 0;
  const call = vi.fn<ProviderAgent['call']>(async (_prompt, options) => {
    const index = ++invocation;
    options.onStream!({ type: 'tool_use', data: { id: 'reused-tool', tool: 'Read', input: { file_path: `turn-${index}.ts` } } });
    options.onStream!({ type: 'tool_result', data: { id: 'reused-tool', content: `result-${index}`, isError: false } });
    return { persona: 'manager', status: 'done', content: '', timestamp: new Date(), sessionId: 'restored-session',
      structuredOutput: { message: 'done', summary: null } };
  });
  const executor = createManagerTurnExecutor(repository, { ctx: { providerType: 'mock', lang: 'en', model: undefined,
    provider: makeProvider({ setup: () => ({ call }) }) }, strategy: { systemPrompt: 'manager' } });
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor });
  const first = await open();
  for (let index = 0; index < previousTurns; index++) {
    await first.submit(`Previous turn ${index}`); await fixture.settled();
  }
  const previous = (await fixture.store.readToolHistory(id))!;
  expect(previous.history.entries).toMatchObject([{ result: `result-${previousTurns}`, status: 'success' }]);
  await fixture.close();
  fixture = await conversationDaemon(getGlobalConfigDir(), { resolve: resolveRuntime, async close() {} });
  const second = await open(); await second.submit('New turn after restart'); await fixture.settled();
  const current = (await fixture.store.readToolHistory(id))!;
  expect(current.operationId).not.toBe(previous.operationId);
  expect(previous.generation).toBe(previousTurns);
  expect(current.generation).toBe(1);
  expect(current).toMatchObject({ finished: true, history: { entries: [{ toolId: 'reused-tool', result: `result-${previousTurns + 1}`, status: 'success' }] } });
  expect(current.history.entries).toHaveLength(1);
  const snapshot = await fixture.conversations.snapshot(id);
  const items = [];
  for await (const item of snapshot.items) items.push(item);
  snapshot.complete();
  expect(items.find((item) => item.kind === 'tool_history')).toEqual({ kind: 'tool_history', history: current });
  expect((await fixture.store.read(id))!.state.session.sessionId).toBe('restored-session');
  expect(call).toHaveBeenCalledTimes(previousTurns + 1);
});

it.each([false, true])('compares the saved system prompt fingerprint on the first turn after restart (changed: %s)', async (changed) => {
  const directory = getGlobalConfigDir();
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async () => ({
    persona: 'manager', status: 'done', content: '', timestamp: new Date(),
    structuredOutput: { message: 'done', summary: null }, sessionId: `session-${call.mock.calls.length}`,
  }));
  const plan: ManagerConversationPlan = { ctx: { provider: makeProvider({ setup: () => ({ call }) }),
    providerType: 'mock', model: undefined, lang: 'en' }, strategy: { systemPrompt: 'original system prompt' } };
  vi.spyOn(conversationPlan, 'createManagerConversationPlan').mockImplementation(() => plan);
  vi.spyOn(managerMcp, 'connectManagerMcp').mockResolvedValue({
    client: new Client({ name: 'fixture', version: 'test' }), servers: {}, async dispose() {},
  });
  let runtime = createConversationRuntime(directory);
  resolveRuntime.mockImplementation((...args: Parameters<typeof runtime.resolve>) => runtime.resolve(...args));
  try {
    const first = await open();
    await first.submit('first request');
    await fixture.settled();
    const saved = (await fixture.store.read(id))!.state.session;
    expect(saved.sessionId).toBe('session-1');
    expect(saved.contextKey).toBeDefined();
    await fixture.close();
    await runtime.close();
    if (changed) plan.strategy.systemPrompt = 'changed system prompt';
    runtime = createConversationRuntime(directory);
    fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
    const next = await open();
    await next.submit('request after restart');
    await fixture.settled();
    expect(call.mock.calls[1]![1].sessionId).toBe(changed ? undefined : 'session-1');
    const restored = (await fixture.store.read(id))!.state.session;
    expect(restored.sessionId).toBe('session-2');
    if (changed) expect(restored.contextKey).not.toBe(saved.contextKey);
    else expect(restored.contextKey).toBe(saved.contextKey);
  } finally { await runtime.close(); }
});

it.each(['legacy', 'legacy-without-question', 'structured', 'unidentified', 'mismatched-request', 'director', 'quoted', 'invalid-payload', 'other-director', 'other-workspace', 'question-mismatch', 'wrong-time'] as const)(
  'redelivers a saved %s event with its original answer or director provenance', async (format) => {
    const directory = getGlobalConfigDir();
    const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Workspace', repositoryDirectories: [] });
    const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
    const targetId = conversationId(owner);
    await fixture.conversations.ensure(owner);
    await fixture.close();
    const inquiryAnswer = { questionId: randomUUID(),
      ...(format === 'legacy-without-question' ? {} : { question: 'Which goal should wait?' }),
      answer: { text: 'X は待ってください。\nY は進めてください。', source: 'slack' as const, answeredAt: '2026-11-03T00:00:00Z' } };
    const legacyText = `A person answered a standalone inquiry. ${JSON.stringify(inquiryAnswer)}`;
    const isAnswer = ['legacy', 'legacy-without-question', 'structured'].includes(format);
    const event = { kind: 'director_message' as const,
      directorConversationId: format === 'other-director' ? 'other-director' : conversationId({ kind: 'daemon' }),
      text: format === 'structured' ? 'A person answered a standalone inquiry.'
        : format === 'director' ? 'Inspect the current work.' : format === 'quoted' ? `Quoted: ${legacyText}`
          : format === 'invalid-payload' ? `${legacyText}\nPlease inspect.` : legacyText,
      ...(format === 'structured' ? { inquiryAnswer } : {}),
    };
    const eventId = format === 'unidentified' ? randomUUID()
      : `workspace-answer-${format === 'other-workspace' ? randomUUID() : workspace.id}-${format === 'question-mismatch' ? randomUUID() : inquiryAnswer.questionId}`;
    const saved = { ...input(eventId, targetId, 'other'),
      requestId: format === 'mismatched-request' ? randomUUID() : eventId,
      source: 'director', occurredAt: format === 'wrong-time' ? '2026-11-04T00:00:00Z' : inquiryAnswer.answer.answeredAt, event,
      operationId: randomUUID(), acceptedSequence: 1, lane: 'other' };
    const eventsDirectory = join(directory, 'daemon-events');
    await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
    const eventPath = join(eventsDirectory, `${createHash('sha256').update(eventId).digest('hex')}.json`);
    await writeFile(eventPath,
      JSON.stringify({ state: 'queued', event: saved }), { mode: 0o600 });
    fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
    await fixture.settled();
    expect(execute).toHaveBeenCalledOnce();
    const prompt = execute.mock.calls[0]![0].prompt;
    const body = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    expect(body).toEqual(isAnswer ? { goalId: null, ...inquiryAnswer }
      : { text: event.text, origin: 'unknown', directorConversationId: event.directorConversationId });
    const stored = EventRecordSchema.parse(JSON.parse(await readFile(eventPath, 'utf8')));
    expect(stored.state).toBe('settled');
    expect(stored.event.event).toEqual(isAnswer ? { ...event, inquiryAnswer } : event);
  },
);

it('preserves a newly accepted director message matching the legacy answer text through saving and restart', async () => {
  const directory = getGlobalConfigDir();
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Workspace', repositoryDirectories: [] });
  const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
  const targetId = conversationId(owner);
  await fixture.conversations.ensure(owner);
  const inquiryAnswer = { questionId: randomUUID(), question: 'Which goal should wait?',
    answer: { text: 'Wait for X.', source: 'tui', answeredAt: '2026-11-03T00:00:00Z' } };
  const event = { kind: 'director_message' as const, origin: 'director' as const, directorConversationId: conversationId({ kind: 'daemon' }),
    text: `A person answered a standalone inquiry. ${JSON.stringify(inquiryAnswer)}` };
  const eventId = randomUUID();
  accepted(await fixture.dispatcher.accept({ ...input(eventId, targetId, 'other'), source: 'director', event }));
  await fixture.settled();
  expect(execute).toHaveBeenCalledOnce();
  const prompt = execute.mock.calls[0]![0].prompt;
  expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)))
    .toEqual({ text: event.text, origin: event.origin, directorConversationId: event.directorConversationId });
  const eventPath = join(directory, 'daemon-events', `${createHash('sha256').update(eventId).digest('hex')}.json`);
  const saved = JSON.parse(await readFile(eventPath, 'utf8'));
  expect(saved.state).toBe('settled');
  expect(saved.event.event).toEqual(event);
  expect(saved.result.event.event).toEqual(event);
  await fixture.close();
  fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
  const duplicate = await fixture.events.accept(saved.event);
  expect(duplicate).toEqual({ kind: 'duplicate', state: 'settled', event: saved.event });
});

it.each(['legacy', 'without-question', 'workspace', 'reassigned-to-workspace', 'route-removed', 'wrong-hash', 'other-repository', 'other-workspace', 'question-mismatch', 'other-inbox-root', 'other-source', 'unidentified', 'mismatched-request', 'director-origin', 'other-director', 'invalid-payload'] as const)(
  'restores an old standalone inbox answer through storage and restart (%s)', async (format) => {
    const directory = getGlobalConfigDir();
    const registration = await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
    const files = new DaemonPersistedFiles(directory);
    const questionId = randomUUID();
    const answer = { text: 'X は待ってください。\nY は進めてください。', source: 'slack' as const, answeredAt: '2026-11-03T00:00:00Z' };
    await files.saveStandaloneInquiryAnswer(repository, questionId, 'Which goal should wait?', answer);
    const inboxDirectory = await files.inboxDirectory(repository);
    const [name] = await readdir(inboxDirectory);
    const inbox = (await files.readInboxEvent(repository, name!))!;
    expect(inbox).toMatchObject({ kind: 'answer', goalId: null, questionId, answer });
    let targetId = id;
    const targetRepository = format === 'other-repository' || format === 'other-workspace' ? join(directory, 'other-repository') : repository;
    if (targetRepository !== repository) {
      await mkdir(join(targetRepository, '.takt'), { recursive: true });
      await writeFile(join(targetRepository, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
      await registerProject({ globalConfigDirectory: directory, projectDirectory: targetRepository, command: 'manager', managerUsed: true });
    }
    if (format === 'other-repository') {
      const record = conversationRecord(targetRepository);
      await fixture.store.create(record);
      targetId = record.id;
    } else if (format === 'workspace' || format === 'other-workspace') {
      const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Inbox destination', repositoryDirectories: [] });
      await writeFile(join(directory, 'workspaces', workspace.id, 'workspace.json'), JSON.stringify({
        ...workspace, repositoryDirectories: [targetRepository],
      }));
      const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
      await fixture.conversations.ensure(owner);
      targetId = conversationId(owner);
    }
    const otherInboxDirectory = format === 'other-inbox-root'
      ? await new DaemonPersistedFiles(join(directory, 'other-config')).inboxDirectory(repository) : undefined;
    const inquiryAnswer = { questionId: format === 'question-mismatch' ? randomUUID() : questionId,
      ...(format === 'without-question' ? {} : { question: 'Which goal should wait?' }), answer };
    const legacyEvent = { kind: 'director_message' as const,
      directorConversationId: format === 'other-director' ? 'other-director' : conversationId({ kind: 'daemon' }),
      text: `A person answered a standalone inquiry. ${JSON.stringify(inquiryAnswer)}${format === 'invalid-payload' ? '\nInspect this.' : ''}`,
      ...(format === 'director-origin' ? { origin: 'director' as const } : {}),
    };
    await receiveInboxChange({ path: join(inboxDirectory, name!), removed: false, generation: 'answer', value: inbox,
      target: { kind: 'inbox', targetId: repository, directory: inboxDirectory, generation: 'repository', conversationId: id } }, files, fixture.conversations, {
      async accept(input) {
        expect(input).toMatchObject({ source: 'run', requestId: input.eventId, conversationId: id, occurredAt: inbox.createdAt });
        expect(input.eventId).toBe(`standalone-answer-${createHash('sha256').update(JSON.stringify([inboxDirectory, questionId])).digest('hex')}`);
        // 旧 producer が保存した本文だけのイベントを、未処理のまま残す。
        const eventId = format === 'unidentified' ? randomUUID() : format === 'wrong-hash' ? `standalone-answer-${'0'.repeat(64)}`
          : otherInboxDirectory === undefined ? input.eventId
            : `standalone-answer-${createHash('sha256').update(JSON.stringify([otherInboxDirectory, questionId])).digest('hex')}`;
        const saved = { ...input, eventId, conversationId: targetId,
          requestId: format === 'mismatched-request' ? randomUUID() : eventId,
          source: format === 'other-source' ? 'director' as const : input.source,
          event: legacyEvent, operationId: randomUUID(), acceptedSequence: 1, lane: 'other' as const };
        expect(await fixture.events.accept(saved)).toEqual({ kind: 'stored' });
        return { kind: 'accepted', eventId: saved.eventId, operationId: saved.operationId, acceptedSequence: saved.acceptedSequence };
      },
    });
    const [eventName] = (await readdir(join(directory, 'daemon-events'))).filter((entry) => entry.endsWith('.json'));
    const eventPath = join(directory, 'daemon-events', eventName!);
    expect(JSON.parse(await readFile(eventPath, 'utf8'))).toMatchObject({ state: 'queued', event: { event: legacyEvent } });
    await fixture.close();
    if (format === 'reassigned-to-workspace') {
      const owner = { kind: 'repository' as const, repositoryDirectory: repository };
      expect(await new DaemonRouting(directory).resolve(owner)).toEqual(owner);
      const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Reassigned destination', repositoryDirectories: [] });
      await writeFile(join(directory, 'workspaces', workspace.id, 'workspace.json'), JSON.stringify({
        ...workspace, repositoryDirectories: [repository],
      }));
      expect(await new DaemonRouting(directory).resolve(owner)).toEqual({ kind: 'workspace', workspaceId: workspace.id });
      expect((await fixture.store.read(id))!.state.assignment).toEqual(owner);
    } else if (format === 'route-removed') {
      await unlink(join(directory, 'projects', `${registration.locationId}.json`));
      expect(await new DaemonRouting(directory).permits({ kind: 'repository', repositoryDirectory: repository }, id)).toBe(false);
    }
    fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
    await fixture.settled();
    expect(execute).toHaveBeenCalledOnce();
    const prompt = execute.mock.calls[0]![0].prompt;
    const isAnswer = format === 'legacy' || format === 'without-question' || format === 'workspace';
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2))).toEqual(isAnswer ? { goalId: null, ...inquiryAnswer }
      : { text: legacyEvent.text, origin: legacyEvent.origin ?? 'unknown', directorConversationId: legacyEvent.directorConversationId });
    const settled = JSON.parse(await readFile(eventPath, 'utf8'));
    expect(settled.state).toBe('settled');
    expect(settled.event.event).toEqual(isAnswer ? { ...legacyEvent, inquiryAnswer } : legacyEvent);
    expect(settled.result.event.event).toEqual(settled.event.event);
    await fixture.close();
    // 旧版で結果まで保存された本文も、同じ同一性検証を通して再読込する。
    await writeFile(eventPath, JSON.stringify({ ...settled, event: { ...settled.event, event: legacyEvent },
      result: { ...settled.result, event: { ...settled.result.event, event: legacyEvent } } }), { mode: 0o600 });
    fixture = await conversationDaemon(directory, { resolve: resolveRuntime, async close() {} });
    await fixture.settled();
    expect(execute).toHaveBeenCalledOnce();
    expect(await fixture.events.accept(settled.event)).toEqual({ kind: 'duplicate', state: 'settled', event: settled.event });
  },
);

it('returns acceptance for a second screen while the same conversation turn is paused', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  execute.mockImplementationOnce(async (value) => { entered.resolve(); await release.promise; return { message: 'first reply', summary: null, sessionId: 'persisted-session', assignment: value.assignment }; });
  const first = await open(); const second = await open();
  await first.submit('first'); await entered.promise;
  expect(await second.submit('second')).toMatchObject({ kind: 'accepted', acceptedSequence: 2 });
  expect(execute).toHaveBeenCalledOnce();
  const snapshot = await second.read;
  expect(snapshot.conversationId).toBe(id);
  release.resolve();
  await second.completed.promise;
  await fixture.dispatcher.drain();
});

it('uses the same session for a director message and preserves the human proposal', async () => {
  const port = await open();
  const event = { kind: 'director_message' as const, directorConversationId: conversationId({ kind: 'daemon' }), text: 'inspect current work' };
  accepted(await fixture.dispatcher.accept({ ...input('event', id, 'other'), event }));
  await port.completed.promise;
  await fixture.dispatcher.drain();
  expect(execute.mock.calls[0]![0].sessionId).toBe('provider-session');
  expect((await fixture.store.read(id))!.state).toMatchObject({ revision: 4, pending: { revision: 4 } });
});

it('starts each patrol with business context in a disposable session and then resumes the human conversation', async () => {
  const goal = await new GoalStore(repository).create(goalRecord());
  const before = (await fixture.store.read(id))!.state;
  const call = vi.fn<ProviderAgent['call']>().mockImplementation(async () => ({
    persona: 'manager', status: 'done', content: '', timestamp: new Date(),
    structuredOutput: { message: 'Patrol complete', summary: null }, sessionId: `session-${call.mock.calls.length}`,
  }));
  const executor = createManagerTurnExecutor(repository, { ctx: {
    provider: makeProvider({ setup: () => ({ call }) }), providerType: 'mock', model: undefined, lang: 'en',
  }, strategy: { systemPrompt: 'manager' } });
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor });
  const port = await open();
  for (let index = 0; index < 2; index++) {
    accepted(await fixture.dispatcher.accept({ ...input(`patrol-${index}`, id, 'other'), event: {
      kind: 'patrol', repositoryDirectory: repository, goalIds: [goal.id],
    } }));
    await fixture.settled();
    expect(call).toHaveBeenCalledTimes(index + 1);
    const [prompt, options] = call.mock.calls[index]!;
    expect(options.sessionId).toBeUndefined();
    expect(options.callerManagedSession).toBe(true);
    expect(prompt).toContain(before.pending!.summary.objective);
    expect(prompt).toContain(goal.objective);
    expect(prompt).toContain(repository);
    expect((await fixture.store.read(id))!.state).toMatchObject({ session: before.session, pending: before.pending });
  }
  expect(port.outputs.filter((output) => output.kind === 'result').map((output) => output.result))
    .toEqual([{ kind: 'reply', message: 'Patrol complete' }, { kind: 'reply', message: 'Patrol complete' }]);
  await port.submit('continue the conversation');
  await fixture.settled();
  expect(call).toHaveBeenCalledTimes(3);
  expect(humanTurnText(call.mock.calls[2]![0])).toBe('continue the conversation');
  expect(call.mock.calls[2]![1].sessionId).toBe(before.session.sessionId);
});

it('keeps an accepted message alive after its last attachment detaches', async () => {
  const entered = deferred<void>(); const release = deferred<void>();
  execute.mockImplementationOnce(async (value) => { entered.resolve(); await release.promise; return { message: 'done', summary: null, sessionId: 'persisted-session', assignment: value.assignment }; });
  const port = await open(); await port.submit('continue after detach'); await entered.promise;
  fixture.input.detach(port.attachmentId); release.resolve();
  // dispatcher の保存完了を明示的に待ち、表示配送には依存しない。
  const saving = deferred<void>();
  const apply = fixture.conversations.apply.bind(fixture.conversations);
  vi.spyOn(fixture.conversations, 'apply').mockImplementation(async (result) => { await apply(result); saving.resolve(); });
  await saving.promise; await fixture.dispatcher.drain();
  expect((await fixture.store.read(id))!.state.session.sessionId).toBe('persisted-session');
});

it('does not execute again when result persistence fails and only retries the saved outcome', async () => {
  const port = await open(); const failure = new Error('disk unavailable');
  const save = vi.spyOn(fixture.events, 'saveResult').mockRejectedValueOnce(failure);
  const failed = deferred<void>();
  const before = fixture.failures.push.bind(fixture.failures);
  vi.spyOn(fixture.failures, 'push').mockImplementation((...errors) => { failed.resolve(); return before(...errors); });
  expect(await port.submit('one call')).toMatchObject({ kind: 'accepted' });
  await failed.promise;
  expect(save).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  await fixture.dispatcher.retryStorage(); await port.completed.promise;
  expect(execute).toHaveBeenCalledOnce();
});

it('returns unavailable for disabled formal specs before resolving a failing runtime', async () => {
  resolveRuntime.mockRejectedValue(new Error('runtime initialization failed'));
  const port = await open();
  const before = (await fixture.store.read(id))!.state;
  await port.submit('/verify');
  expect((await port.completed.promise).result).toMatchObject({ kind: 'reply', message: expect.stringContaining('/verify') });
  await fixture.dispatcher.drain();
  expect(resolveRuntime).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect((await fixture.store.read(id))!.state).toEqual(before);
});

it('saves the invalidated generation session before retrying with business context and resumes the recovered session on the next turn', async () => {
  await writeFile(join(repository, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nassistant:\n  formal_spec: true\nmanager:\n  auto_run: false\n');
  const before = (await fixture.store.read(id))!.state;
  vi.mocked(runFormalSpecVerification).mockResolvedValue({ verdict: 'passed', verificationStarted: true,
    quint: { status: 'passed' }, alloy: { status: 'passed' } });
  const call = vi.fn<ProviderAgent['call']>();
  const success = { persona: 'manager', status: 'done' as const, timestamp: new Date() };
  call.mockResolvedValueOnce({ ...success, status: 'error', content: '', failureCategory: 'session_continuation_unsupported' });
  call.mockImplementationOnce(async (prompt, options) => {
    expect((await fixture.store.read(id))!.state.session.sessionId).toBeNull();
    expect(options).toMatchObject({ cwd: repository, sessionId: undefined, callerManagedSession: true });
    expect(prompt).toContain(before.pending!.summary.objective);
    return { ...success, content: '```quint\nmodule csv {}\n```', sessionId: 'recovered' };
  });
  call.mockResolvedValue({ ...success, content: '', structuredOutput: { message: 'verified', summary: null }, sessionId: 'recovered' });
  const executor = createManagerTurnExecutor(repository, { ctx: {
    provider: makeProvider({ setup: () => ({ call }) }), providerType: 'mock', model: undefined, lang: 'en',
  }, strategy: { systemPrompt: 'manager' } });
  resolveRuntime.mockResolvedValue({ provider: 'mock', model: null, language: 'en', contextKey: 'test', executor });
  const port = await open();
  await port.submit('/verify');
  expect((await port.completed.promise).result).toMatchObject({ kind: 'reply' });
  await fixture.settled();
  expect(call.mock.calls[0]![1].sessionId).toBe(before.session.sessionId);
  expect(call.mock.calls[2]![1].sessionId).toBe('recovered');
  expect((await fixture.store.read(id))!.state.session.sessionId).toBe('recovered');
  const next = await open();
  await next.submit('continue');
  expect((await next.completed.promise).result).toMatchObject({ kind: 'reply' });
  await fixture.settled();
  expect(call.mock.calls[3]![1].sessionId).toBe('recovered');
});
