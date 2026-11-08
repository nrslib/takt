import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationDaemon } from './helpers/conversation-daemon.js';
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

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: vi.fn(), cleanupFormalSpecVerificationArtifacts: vi.fn(),
}));

vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: async (assignment: { repositoryDirectory: string }) => ({ ...assignment, repositoryDirectories: [assignment.repositoryDirectory] }),
}));
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

it('persists the session and applies the human response to the current proposal', async () => {
  const port = await open();
  expect(await port.submit('continue the existing goal')).toMatchObject({ kind: 'accepted', acceptedSequence: 1 });
  expect((await port.completed.promise).result).toMatchObject({ kind: 'reply' });
  await fixture.dispatcher.drain();
  expect((await fixture.store.read(id))!.state).toMatchObject({ revision: 5, pending: null, session: { sessionId: 'persisted-session' } });
  expect(execute.mock.calls[0]![0].sessionId).toBe('provider-session');
});

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
  expect(call.mock.calls[2]![0]).toBe('continue the conversation');
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
