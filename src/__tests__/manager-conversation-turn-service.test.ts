import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import { buildManagerEventPrompt } from '../features/daemon/inboxEvent.js';

const turnData = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
import type { ConversationRuntime, PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { DaemonStateRequest } from '../core/daemon/processProtocol.js';
import type { TurnIo } from '../features/daemonTurn/processRuntime.js';
import { turnStart, deferred } from './helpers/daemon-turn.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { randomUUID } from 'node:crypto';
import type { AssistantCliOverrides } from '../core/config/provider-resolution.js';
import { mergeTaktGoalPr } from '../features/mcp/goalIntegrationOperations.js';
import type { TurnEvent } from '../core/daemon/events.js';
import type { ConversationChange } from '../core/daemon/messages.js';
import { getLabel } from '../shared/i18n/index.js';
import { createManagerTurnExecutor } from '../features/manager/turnExecutor.js';
import { runFormalSpecVerification, cleanupFormalSpecVerificationArtifacts } from '../features/interactive/formalSpecVerification.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { makeProvider } from './test-helpers.js';

vi.mock('../features/interactive/formalSpecVerification.js', () => ({
  runFormalSpecVerification: vi.fn(), cleanupFormalSpecVerificationArtifacts: vi.fn(),
}));

vi.mock('../features/interactive/taskInstructionFormat.js', () => ({ resolveFormalSpecConfigurationWithoutPrompt: doubles.formalSpec }));

const doubles = vi.hoisted(() => ({ readTasks: vi.fn(), assignment: vi.fn(), formalSpec: vi.fn(), register: vi.fn(), autoRun: vi.fn(), notify: vi.fn(), reconcile: vi.fn(), getGoal: vi.fn(), mergePr: vi.fn(), updateGoal: vi.fn(), setStatus: vi.fn(), invalidate: vi.fn() }));
vi.mock('../features/daemon/watchers/state.js', () => ({ readWatchTasks: doubles.readTasks }));
vi.mock('../infra/goals/execution.js', async (original) => ({ ...await original<typeof import('../infra/goals/execution.js')>(), setGoalExecutionStatus: doubles.setStatus }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { invalidatePendingGoalTasks = doubles.invalidate; } }));
vi.mock('../features/manager/mergeGoalPr.js', () => ({ mergeGoalPr: doubles.mergePr }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.getGoal; update = doubles.updateGoal; } }));
vi.mock('../features/daemonTurn/reconcileLostRun.js', () => ({ reconcileLostRun: doubles.reconcile }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path,
  findAssignedGoalRepository: async () => '/repository' }));
vi.mock('../infra/goals/service.js', async (original) => ({ ...await original<typeof import('../infra/goals/service.js')>(), registerReservedGoal: doubles.register }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.autoRun }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.notify }));
vi.mock('../features/daemonTurn/turnContext.js', () => ({ buildTurnBusinessContext: async () => 'saved-goal-memory' }));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: () => 'en' }));

function fixture() {
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>(async () => ({ message: 'reply', summary: null, sessionId: 'session-after', assignment: undefined }));
  const resolve = vi.fn<ConversationRuntime['resolve']>(async () => ({ provider: 'mock', model: null, contextKey: 'context', language: 'en', executor: { execute } }));
  const service = createConversationTurnService('/config', { resolve, close: vi.fn(async () => {}) });
  let version = 10;
  const request = vi.fn<TurnIo['request']>(async (request) => {
    if (request.kind !== 'save_conversation') throw new Error('Unexpected request');
    expect(request.change.expectedVersion).toBe(version);
    version++;
    return { kind: 'state_saved', version, duplicate: false };
  });
  const controller = new AbortController();
  const io = { signal: controller.signal, request, progress: vi.fn() };
  const input = turnStart(); input.state.version = version;
  input.state.session.contextKey = 'context';
  return { service, execute, resolve, request, controller, io, input };
}

function humanMessage(text: string): TurnEvent {
  return { kind: 'human_command', command: { kind: 'message', text }, speaker: { namespace: 'human', id: 'test' } };
}

function conversationFixture() {
  const f = fixture();
  let state = structuredClone(f.input.state);
  let generation = 0;
  let service = f.service;
  const save = (change: ConversationChange) => {
    expect(change.expectedVersion).toBe(state.version);
    state = { ...state, version: state.version + 1,
      ...(change.session === undefined ? {} : { session: change.session }),
      ...(change.proposal === undefined ? {} : change.proposal),
      ...(change.approval === undefined ? {} : { approval: change.approval }),
      ...('interruptedMessage' in change && change.interruptedMessage !== undefined ? { interruptedMessage: change.interruptedMessage } : {}),
    };
    return { kind: 'state_saved' as const, version: state.version, duplicate: false };
  };
  f.request.mockImplementation(async (request) => {
    if (request.kind !== 'save_conversation') throw new Error('Unexpected request');
    return save(request.change);
  });
  return { ...f, state: () => structuredClone(state),
    restore() {
      state = JSON.parse(JSON.stringify(state)) as typeof state;
      service = createConversationTurnService('/config', { resolve: f.resolve, close: vi.fn(async () => {}) });
    },
    async run(event: TurnEvent, controller = new AbortController()) {
      const input = turnStart(++generation);
      input.state = structuredClone(state);
      input.event.event = event;
      input.event.lane = event.kind === 'human_command' || event.kind === 'inquiry_answer' ? 'human' : 'other';
      const outcome = await service.execute(input, { ...f.io, signal: controller.signal });
      if (outcome.change !== undefined) save(outcome.change);
      return outcome;
    },
    interruptNext(controller: AbortController) {
      f.execute.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted'); });
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  vi.resetAllMocks();
  doubles.readTasks.mockResolvedValue([]);
  doubles.formalSpec.mockReturnValue({ mode: true, comments: false, modelCheckTimeoutSeconds: 42 });
  doubles.assignment.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repository', repositoryDirectories: ['/repository'] });
  doubles.getGoal.mockResolvedValue(goalRecord()); doubles.updateGoal.mockResolvedValue(goalRecord());
});

it('resumes the saved session on the next human turn after interruption without resending the interrupted turn', async () => {
  const f = conversationFixture();
  await f.run(humanMessage('completed before interruption'));
  const controller = new AbortController(); f.interruptNext(controller);
  expect(await f.run(humanMessage('interrupted request'), controller)).toMatchObject({ kind: 'interrupted' });
  expect(f.execute).toHaveBeenCalledTimes(2);
  expect(f.state()).toMatchObject({ session: { sessionId: 'session-after' } });
  await f.run(humanMessage('continue'));
  expect(f.execute.mock.calls[2]![0].sessionId).toBe('session-after');
  expect(f.execute).toHaveBeenCalledTimes(3);
});

it('resumes the session and interrupted message from restored state in a new conversation service', async () => {
  const f = conversationFixture();
  await f.run(humanMessage('completed before shutdown'));
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('request before shutdown'), controller);
  f.restore();
  await f.run(humanMessage('request after restart'));
  expect(f.execute.mock.calls[2]![0]).toMatchObject({ sessionId: 'session-after' });
  const prompt = f.execute.mock.calls[2]![0].prompt;
  expect(prompt.indexOf('request before shutdown')).toBeGreaterThan(0);
  expect(prompt.indexOf('request before shutdown')).toBeLessThan(prompt.indexOf('request after restart'));
});

it.each([
  { language: 'ja' as const, recipient: 'human', interruptedHumanSource: /中断したターンで受け取った人の発言/ },
  { language: 'en' as const, recipient: 'human', interruptedHumanSource: /human message received in an interrupted turn/i },
  { language: 'ja' as const, recipient: 'event', interruptedHumanSource: /中断したターンで受け取った人の発言/ },
  { language: 'en' as const, recipient: 'event', interruptedHumanSource: /human message received in an interrupted turn/i },
])('prepends the localized interrupted human message to a $recipient turn in $language', async ({ language, recipient, interruptedHumanSource }) => {
  const f = conversationFixture();
  f.resolve.mockResolvedValue({ provider: 'mock', model: null, language, contextKey: 'context', executor: { execute: f.execute } });
  const text = '  interrupted {value}\noriginal text  ';
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage(text), controller);
  expect(f.state()).toMatchObject({ interruptedMessage: text });
  await f.run(recipient === 'human' ? humanMessage('current request')
    : { kind: 'director_message', text: 'current request', directorConversationId: 'director' });
  const prompt = f.execute.mock.calls[1]![0].prompt;
  expect(prompt.slice(0, prompt.indexOf(text))).toMatch(interruptedHumanSource);
  expect(prompt).toContain(text);
  expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf('current request'));
  if (recipient === 'event') expect(turnData(prompt)).toMatchObject({ origin: 'unknown', directorConversationId: 'director' });
});

it('clears interrupted context after one completed message turn', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  await f.run(humanMessage('first continuation'));
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: null });
  await f.run(humanMessage('second continuation'));
  expect(turnData(f.execute.mock.calls[2]![0].prompt)).toMatchObject({ text: 'second continuation', speaker: { namespace: 'human', id: 'test' } });
  expect(f.execute.mock.calls[2]![0].prompt).not.toContain('interrupted request');
});

it.each([true, false])('retains undelivered interrupted context through /verify with mode=%s and delivers it on the next message', async (mode) => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('undelivered requirements'), controller);
  doubles.formalSpec.mockReturnValue({ mode, comments: false, modelCheckTimeoutSeconds: 42 });
  vi.mocked(runFormalSpecVerification).mockResolvedValue({ verdict: 'passed', verificationStarted: true,
    quint: { status: 'passed' }, alloy: { status: 'passed' } });
  const call = vi.fn<ProviderAgent['call']>();
  const success = { persona: 'manager', status: 'done' as const, timestamp: new Date(), sessionId: 'verified' };
  if (mode) {
    call.mockResolvedValueOnce({ ...success, content: '```quint\nmodule csv {}\n```' });
    call.mockResolvedValueOnce({ ...success, content: '', structuredOutput: { message: 'verified', summary: null } });
  }
  const executor = createManagerTurnExecutor('/repository', { ctx: {
    provider: makeProvider({ setup: () => ({ call }) }), providerType: 'mock', model: undefined, lang: 'en',
  }, strategy: { systemPrompt: 'manager' } });
  f.execute.mockImplementation(executor.execute);
  expect(await f.run(humanMessage('/verify'))).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(f.state().interruptedMessage).toBe('undelivered requirements');
  expect(call).toHaveBeenCalledTimes(mode ? 2 : 0);
  expect(runFormalSpecVerification).toHaveBeenCalledTimes(mode ? 1 : 0);
  for (const [prompt] of call.mock.calls) expect(prompt).not.toContain('undelivered requirements');
  f.restore();
  call.mockResolvedValue({ ...success, content: '', structuredOutput: { message: 'continued', summary: null } });
  await f.run(humanMessage('continue'));
  expect(call.mock.calls.at(-1)![0]).toContain('undelivered requirements');
  expect(f.state().interruptedMessage).toBeNull();
  await f.run(humanMessage('next request'));
  expect(turnData(call.mock.calls.at(-1)![0]).text).toBe('next request');
});

it.each(['failed', 'error'] as const)('returns the completed %s verification with interruption and keeps undelivered context', async (verdict) => {
  const f = conversationFixture();
  const first = new AbortController(); f.interruptNext(first);
  await f.run(humanMessage('undelivered requirements'), first);
  const result = { verdict, verificationStarted: true, quint: { status: verdict }, alloy: { status: 'passed' as const },
    artifacts: { runDirectory: '/repository/.takt/runs/verify-test', specifications: {}, logs: {} },
    artifactRetention: { status: 'passed' as const } };
  vi.mocked(runFormalSpecVerification).mockResolvedValue(result);
  const controller = new AbortController();
  const call = vi.fn<ProviderAgent['call']>();
  call.mockResolvedValueOnce({ persona: 'manager', status: 'done', timestamp: new Date(), content: '```quint\nmodule csv {}\n```' });
  call.mockImplementationOnce(async () => {
    controller.abort(); throw new Error('cancelled');
  });
  f.execute.mockImplementation(createManagerTurnExecutor('/repository', { ctx: {
    provider: makeProvider({ setup: () => ({ call }) }), providerType: 'mock', model: undefined, lang: 'en',
  }, strategy: { systemPrompt: 'manager' } }).execute);
  const outcome = await f.run(humanMessage('/verify'), controller);
  expect(outcome.kind).toBe('interrupted');
  if (outcome.kind !== 'interrupted') throw new Error('Expected interruption');
  expect(outcome.message).toContain(result.artifacts.runDirectory);
  expect(JSON.parse(outcome.message!.match(/```json\n([\s\S]*?)\n```/)![1]!)).toEqual(result);
  expect(f.io.progress).not.toHaveBeenCalled();
  expect(f.state().interruptedMessage).toBe('undelivered requirements');
  expect(cleanupFormalSpecVerificationArtifacts).toHaveBeenCalledExactlyOnceWith(result);
});

it('keeps prompts unchanged across completed turns with no interruption', async () => {
  const f = conversationFixture();
  await f.run(humanMessage('first request'));
  await f.run(humanMessage('second request'));
  expect(f.execute.mock.calls.map(([turn]) => turnData(turn.prompt).text)).toEqual(['first request', 'second request']);
});

it('passes interrupted context without a session when no session was saved before interruption', async () => {
  const f = conversationFixture();
  f.execute.mockResolvedValueOnce({ message: 'reply', summary: null, sessionId: undefined, assignment: undefined });
  await f.run(humanMessage('first request'));
  expect(f.state().session.sessionId).toBeNull();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted without session'), controller);
  await f.run(humanMessage('continue without session'));
  expect(f.execute.mock.calls[2]![0].sessionId).toBeUndefined();
  expect(f.execute.mock.calls[2]![0].prompt).toContain('interrupted without session');
});

it('preserves both human messages when a continuation is interrupted before completing', async () => {
  const f = conversationFixture();
  for (const text of ['older interrupted request', 'latest interrupted request']) {
    const controller = new AbortController(); f.interruptNext(controller);
    await f.run(humanMessage(text), controller);
  }
  expect(f.execute.mock.calls[1]![0].prompt).toContain('older interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: 'older interrupted request\n\nlatest interrupted request' });
  await f.run(humanMessage('continue'));
  const prompt = f.execute.mock.calls[2]![0].prompt;
  expect(prompt).toContain('older interrupted request');
  expect(prompt).toContain('latest interrupted request');
  expect(prompt.indexOf('older interrupted request')).toBeLessThan(prompt.indexOf('latest interrupted request'));
});

it('preserves the old and current messages when interrupted before executor invocation', async () => {
  const f = conversationFixture();
  const firstController = new AbortController(); f.interruptNext(firstController);
  await f.run(humanMessage('message A'), firstController);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  expect(await f.run(humanMessage('message B'), alreadyAborted)).toMatchObject({ kind: 'interrupted' });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ interruptedMessage: 'message A\n\nmessage B' });
  await f.run(humanMessage('message C'));
  expect(f.execute.mock.calls[1]![0].prompt).toContain('message A\n\nmessage B');
  expect(f.execute.mock.calls[1]![0].prompt).toContain('message C');
});

it('retains the interrupted human message through an interrupted event turn and clears it after an event completes', async () => {
  const f = conversationFixture();
  const humanController = new AbortController(); f.interruptNext(humanController);
  await f.run(humanMessage('interrupted human request'), humanController);
  const eventController = new AbortController(); f.interruptNext(eventController);
  await f.run({ kind: 'director_message', text: 'interrupted event', directorConversationId: 'director' }, eventController);
  expect(f.state()).toMatchObject({ interruptedMessage: 'interrupted human request' });
  await f.run({ kind: 'director_message', text: 'next event', directorConversationId: 'director' });
  expect(f.execute.mock.calls[2]![0].prompt).toContain('interrupted human request');
  expect(f.execute.mock.calls[2]![0].prompt).not.toContain('interrupted event');
  expect(f.state()).toMatchObject({ interruptedMessage: null });
  await f.run(humanMessage('next human request'));
  expect(turnData(f.execute.mock.calls[3]![0].prompt).text).toBe('next human request');
});

it('does not save an interrupted event as a human message', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run({ kind: 'director_message', text: 'interrupted event', directorConversationId: 'director' }, controller);
  await f.run(humanMessage('next human request'));
  expect(f.execute.mock.calls[1]![0]).toMatchObject({ sessionId: 'shared-session' });
  expect(turnData(f.execute.mock.calls[1]![0].prompt)).toEqual({
    speaker: { namespace: 'human', id: 'test' }, text: 'next human request',
  });
});

it('retains interrupted context when an executor error leaves delivery unconfirmed', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  f.execute.mockRejectedValueOnce(new Error('provider failed'));
  expect(await f.run(humanMessage('failed continuation'))).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: 'interrupted request' });
  await f.run(humanMessage('next request'));
  expect(f.execute.mock.calls[2]![0].prompt).toContain('interrupted request');
  expect(f.execute.mock.calls[2]![0].prompt).toContain('next request');
});

it('retains interrupted context when runtime preparation fails before executor invocation', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  f.resolve.mockRejectedValueOnce(new Error('MCP preparation failed'));
  expect(await f.run(humanMessage('failed continuation'))).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(f.state()).toMatchObject({ interruptedMessage: 'interrupted request' });
  expect(f.execute).toHaveBeenCalledOnce();
  await f.run(humanMessage('next request'));
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
});

it('retains interrupted context when a command is rejected and a patrol does not invoke the executor', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  expect(await f.run({ kind: 'human_command', speaker: { namespace: 'human', id: 'test' },
    command: { kind: 'dismiss_summary', revision: f.state().revision } })).toMatchObject({ kind: 'completed', result: { kind: 'error', code: 'stale_summary' } });
  doubles.getGoal.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused' });
  await f.run({ kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goalRecord().id] });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.state()).toMatchObject({ interruptedMessage: 'interrupted request' });
  await f.run(humanMessage('continue'));
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
});

it.each([
  { provider: 'codex' as const, model: null },
  { provider: 'mock' as const, model: 'changed-model' },
])('does not restore the old session after a selection change and interruption: %j', async ({ provider, model }) => {
  const f = conversationFixture();
  await f.run(humanMessage('completed with previous selection'));
  f.resolve.mockResolvedValue({ provider, model, contextKey: 'context', language: 'en', executor: { execute: f.execute } });
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted with changed selection'), controller);
  expect(f.execute.mock.calls[1]![0].sessionId).toBeUndefined();
  expect(f.state().session).toMatchObject({ provider, model, sessionId: null });
  await f.run(humanMessage('continue'));
  expect(f.execute.mock.calls[2]![0].sessionId).toBeUndefined();
  expect(f.execute.mock.calls[2]![0].prompt).toContain('interrupted with changed selection');
});

it('returns a system notice after dismissing a registration proposal without invoking AI', async () => {
  const f = fixture();
  f.input.state.pending = { revision: 1, repositoryDirectory: '/repository',
    summary: { objective: 'goal', acceptanceCriteria: ['criterion'], constraints: [], outOfScope: [] } };
  f.input.event.event = { kind: 'human_command', speaker: { namespace: 'human', id: 'test' },
    command: { kind: 'dismiss_summary', revision: 1 } };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: {
    kind: 'notice', message: getLabel('manager.conversation.dismissed', 'en'),
  } });
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ change: expect.objectContaining({ proposal: { revision: 2, pending: null } }) }));
  expect(f.execute).not.toHaveBeenCalled();
});

it.each([
  { kind: 'pause_goal', status: 'paused', label: 'manager.goalPaused' },
  { kind: 'resume_goal', status: 'active', label: 'manager.goalResumed' },
  { kind: 'abort_goal', status: 'aborted', label: 'manager.goalAborted' },
] as const)('returns a system notice after $kind without invoking AI', async ({ kind, status, label }) => {
  const f = fixture();
  const goalId = goalRecord().id;
  f.input.event.event = { kind: 'human_command', speaker: { namespace: 'human', id: 'test' }, command: { kind, goalId } };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: {
    kind: 'notice', message: getLabel(label, 'en', { goalId }),
  } });
  expect(doubles.setStatus).toHaveBeenCalledExactlyOnceWith('/repository', goalId, status, f.io.signal, 'human');
  expect(doubles.invalidate).toHaveBeenCalledTimes(status === 'aborted' ? 1 : 0);
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted'] as const)('returns a system notice for an event on a %s goal without invoking AI', async (executionStatus) => {
  const f = fixture();
  const goal = { ...goalRecord(), executionStatus };
  doubles.getGoal.mockResolvedValue(goal);
  f.input.event.lane = 'other';
  f.input.event.event = { kind: 'goal_registered', repositoryDirectory: '/repository', goalId: goal.id };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'notice' } });
  expect(f.execute).not.toHaveBeenCalled();
});
it.each<AssistantCliOverrides>([{ provider: 'codex' }, { model: 'custom' }, { provider: 'codex', model: 'custom' }])('keeps selection %j and session across human, director and completion turns', async (overrides) => {
  const f = fixture();
  f.resolve.mockImplementation(async (_assignment, _signal, selected) => {
    const provider = selected?.provider ?? 'mock';
    const model = selected?.model ?? null;
    return { provider, model, contextKey: JSON.stringify([provider, model]), language: 'en', executor: { execute: f.execute } };
  });
  f.execute.mockImplementation(async () => ({ message: 'reply', summary: null, sessionId: `session-${f.execute.mock.calls.length}`, assignment: undefined }));
  const human: TurnEvent = { kind: 'human_command', command: { kind: 'message', text: 'hello' },
    speaker: { namespace: 'human', id: 'test' }, agentOverrides: overrides };
  const events: TurnEvent[] = [human, { kind: 'director_message', directorConversationId: 'director', text: 'event message' },
    { kind: 'task_completed', task: { repositoryDirectory: '/repository', goalId: goalRecord().id, taskName: 'task', runSlug: 'run' },
      result: { success: true, interrupted: false, workflowResult: 'completed', shaUnavailableReason: 'test' } }, human];
  let state = f.input.state;
  for (const [index, event] of events.entries()) {
    const input = turnStart(index + 1); input.state = state; input.event.event = event;
    input.event.lane = event.kind === 'human_command' ? 'human' : 'other';
    // 子プロセスを作り直しても、保存した選択だけで同じ会話を続けられる。
    const service = createConversationTurnService('/config', { resolve: f.resolve, close: vi.fn(async () => {}) });
    const outcome = await service.execute(input, f.io);
    expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'reply' }, change: { session: { agentOverrides: overrides } } });
    expect(f.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'repository' }), f.io.signal, overrides);
    expect(f.execute.mock.calls[index]![0]).toMatchObject({ sessionId: index === 0 ? undefined : `session-${index}`,
      recovery: { context: 'saved-goal-memory' } });
    if (outcome.change?.session === undefined) throw new Error('Expected saved session');
    await f.io.request({ kind: 'save_conversation', change: outcome.change });
    state = { ...state, version: outcome.change.expectedVersion + 1, session: outcome.change.session,
      ...(outcome.change.proposal === undefined ? {} : outcome.change.proposal) };
  }
});
it('saves approval reservation before registering a goal and uses the returned state version for completion', async () => {
  const f = fixture(); const confirmation = deferred<void>(); const requested = deferred<DaemonStateRequest>();
  const summary = { objective: 'goal', acceptanceCriteria: ['criterion'], constraints: [], outOfScope: [] };
  f.input.state.pending = { revision: 1, repositoryDirectory: '/repository', summary };
  f.input.event.event = { kind: 'human_command', speaker: { namespace: 'human', id: 'test' }, command: { kind: 'approve_summary', revision: 1 } };
  f.request.mockImplementation(async (request) => {
    requested.resolve(request); await confirmation.promise;
    return { kind: 'state_saved', version: 42, duplicate: false };
  });
  const goal = goalRecord(); doubles.register.mockResolvedValue(goal);
  const execution = f.service.execute(f.input, f.io);
  const reservation = await requested.promise;
  expect(reservation).toMatchObject({ kind: 'save_conversation', change: { expectedVersion: 10, approval: { state: 'reserved' } } });
  expect(doubles.register).not.toHaveBeenCalled();
  confirmation.resolve();
  const outcome = await execution;
  expect(doubles.register).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repository', objective: 'goal' }), f.io.signal);
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'goal_registered', goal }, change: { expectedVersion: 42,
    approval: { state: 'registered' }, proposal: { revision: 2, pending: null } } });
  expect(f.execute).not.toHaveBeenCalled();
});
it('never creates a goal if the reservation is rejected', async () => {
  const f = fixture();
  f.input.state.pending = { revision: 1, repositoryDirectory: '/repository', summary: { objective: 'goal', acceptanceCriteria: ['criterion'], constraints: [], outOfScope: [] } };
  f.input.event.event = { kind: 'human_command', speaker: { namespace: 'human', id: 'test' }, command: { kind: 'approve_summary', revision: 1 } };
  f.request.mockResolvedValue({ kind: 'error', code: 'version_conflict', message: 'conflict' });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(doubles.register).not.toHaveBeenCalled();
});
it('invalidates the saved session before retrying and returns interrupted cleanup at the latest version', async () => {
  const f = conversationFixture();
  f.execute.mockImplementationOnce(async (turn) => {
    expect(turn.sessionId).toBe('shared-session');
    await turn.recovery!.invalidateSession();
    f.controller.abort();
    throw new Error('aborted');
  });
  const outcome = await f.run(humanMessage('interrupted after invalidation'), f.controller);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(outcome).toMatchObject({ kind: 'interrupted', change: { expectedVersion: 12, interruptedMessage: 'interrupted after invalidation' } });
  expect(f.state().session.sessionId).toBeNull();
  await f.run(humanMessage('continue'));
  expect(f.execute.mock.calls[1]![0].sessionId).toBeUndefined();
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted after invalidation');
});
it('rejects an event outside the assignment before invoking AI', async () => {
  const f = fixture(); f.input.event.lane = 'other';
  f.input.event.event = { kind: 'goal_registered', repositoryDirectory: '/other', goalId: randomUUID() };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'error', code: 'invalid_assignment' } });
  expect(f.execute).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
});
it.each(['task_completed', 'pr_changed'] as const)('notifies the event repository and goal when a workspace %s turn fails', async (kind) => {
  const f = fixture();
  f.input.state.assignment = { kind: 'workspace', workspaceId: randomUUID() };
  const { conversationId } = await import('../infra/conversations/identity.js');
  const id = conversationId(f.input.state.assignment);
  f.input.turn.conversationId = id; f.input.event.conversationId = id;
  doubles.assignment.mockResolvedValue({ ...f.input.state.assignment, name: 'Workspace', repositoryDirectories: ['/repository', '/second'] });
  const goalId = goalRecord().id;
  f.input.event.event = kind === 'task_completed'
    ? { kind, task: { repositoryDirectory: '/second', goalId, taskName: 'task' }, result: { success: true, interrupted: false } }
    : { kind: 'watch_observation', observation: { kind, repositoryDirectory: '/second', goalId, state: 'MERGED',
      url: 'https://github.com/test/repo/pull/1', targetId: 'pr', generation: 'generation', observedAt: '2026-11-03T00:00:00Z' } };
  const failure = new Error('provider failed');
  f.execute.mockRejectedValue(failure);
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/second', goalId, failure, f.input.turn.operationId);
});
it('does not turn an event response into a human registration proposal', async () => {
  const f = fixture(); f.input.event.lane = 'other';
  f.input.event.event = { kind: 'director_message', directorConversationId: 'director', text: 'check goals' };
  f.execute.mockResolvedValue({ message: 'reply', sessionId: 'next', assignment: undefined,
    summary: { objective: 'unexpected', acceptanceCriteria: ['criterion'], constraints: [], outOfScope: [] } });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(f.request).not.toHaveBeenCalled();
});

it.each([true, false])('settles a run loss observation without AI and invokes AI only for the resulting completion (recovered: %s)', async (recovered) => {
  const f = fixture();
  const task = { repositoryDirectory: '/repository', goalId: goalRecord().id, taskName: 'task', runSlug: 'run', executionId: 'execution' };
  const observation = { kind: 'run_process_lost' as const, task, targetId: 'target', generation: 'generation',
    observedAt: '2026-11-03T00:00:00Z', pid: 12345, startTime: null };
  f.input.event.event = { kind: 'watch_observation', observation }; f.input.event.lane = 'other';
  doubles.reconcile.mockReturnValue(recovered);
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'notice', message: '' } });
  expect(doubles.reconcile).toHaveBeenCalledExactlyOnceWith(observation, f.io.signal);
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  if (recovered) {
    f.input.event.event = { kind: 'task_failed', task, result: { success: false, interrupted: true, workflowResult: 'error',
      failureReason: 'Execution process stopped before saving its result', shaUnavailableReason: 'Process stopped' } };
    expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply', message: 'reply' } });
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
  }
});

it('inspects active patrol goals together without resuming or updating the conversation session', async () => {
  const f = fixture();
  const active = goalRecord(); const paused = { ...goalRecord(), id: randomUUID(), executionStatus: 'paused' };
  doubles.getGoal.mockImplementation(async (id: string) => id === active.id ? active : paused);
  f.input.event.lane = 'other';
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id, paused.id] };
  const message = 'Patrol: 1 goal, no anomalies';
  f.execute.mockResolvedValue({ message, summary: null, sessionId: 'next', assignment: undefined });
  const outcome = await f.service.execute(f.input, f.io);
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'reply', message } });
  expect(outcome.change?.session).toBeUndefined();
  expect(outcome.change?.proposal).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled();
  const turn = f.execute.mock.calls[0]![0];
  expect(turnData(turn.prompt)).toMatchObject({ event: { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id] },
    instruction: expect.any(String) });
  expect(turnData(turn.prompt)).toEqual(JSON.parse(buildManagerEventPrompt({
    kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id],
  })));
  expect(turn).toMatchObject({ patrol: true, sessionId: undefined, recovery: { context: 'saved-goal-memory' } });
  expect(doubles.updateGoal).not.toHaveBeenCalled();
  expect(doubles.notify).not.toHaveBeenCalled();
});

it.each(['completed', 'failed', 'interrupted'] as const)('preserves the conversation session and interrupted human input through a %s patrol', async (status) => {
  const f = conversationFixture();
  const humanController = new AbortController(); f.interruptNext(humanController);
  await f.run(humanMessage('undelivered human request'), humanController);
  const before = f.state();
  const patrolController = new AbortController();
  if (status === 'failed') f.execute.mockRejectedValueOnce(new Error('patrol failed'));
  if (status === 'interrupted') f.interruptNext(patrolController);
  const outcome = await f.run({ kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goalRecord().id] }, patrolController);
  expect(outcome).toMatchObject(status === 'interrupted' ? { kind: 'interrupted' }
    : { kind: 'completed', result: { kind: status === 'failed' ? 'error' : 'reply' } });
  const turn = f.execute.mock.calls[1]![0];
  expect(turn.sessionId).toBeUndefined();
  expect(turnData(turn.prompt).event.kind).toBe('patrol');
  expect(turn.prompt).not.toContain('undelivered human request');
  expect(f.state().session).toEqual(before.session);
  expect(f.state().interruptedMessage).toBe('undelivered human request');
  await f.run(humanMessage('continue'));
  expect(f.execute.mock.calls[2]![0]).toMatchObject({ sessionId: before.session.sessionId });
  expect(f.execute.mock.calls[2]![0].prompt).toContain('undelivered human request');
  expect(f.state().interruptedMessage).toBeNull();
});

it('keeps the human session and runtime context when a patrol resolves a different model or context', async () => {
  const f = conversationFixture();
  await f.run(humanMessage('before patrol'));
  const before = f.state().session;
  f.resolve.mockResolvedValueOnce({ provider: 'mock', model: 'patrol-model', contextKey: 'patrol-context', language: 'en', executor: { execute: f.execute } });
  await f.run({ kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goalRecord().id] });
  expect(f.state().session).toEqual(before);
  await f.run(humanMessage('after patrol'));
  expect(f.execute.mock.calls[2]![0].sessionId).toBe(before.sessionId);
});

it.each(['paused', 'aborted', 'completed', 'awaiting_merge'] as const)('does not run a queued patrol when its goals have become %s', async (status) => {
  const f = fixture();
  const goal = goalRecord();
  doubles.getGoal.mockResolvedValue(status === 'completed' || status === 'awaiting_merge' ? { ...goal, status } : { ...goal, executionStatus: status });
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goal.id] };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'notice', message: '' } });
  expect(f.resolve).not.toHaveBeenCalled();
});

it.each(['pending', 'running'] as const)('includes awaiting-merge goals with %s merge work and rechecks before executing', async (status) => {
  const f = fixture();
  const merging = { ...goalRecord(), status: 'awaiting_merge' };
  const waiting = { ...merging, id: randomUUID() };
  doubles.getGoal.mockImplementation(async (id: string) => id === merging.id ? merging : waiting);
  doubles.readTasks.mockResolvedValue([
    { goal_id: merging.id, merge_task: true, status },
    { goal_id: waiting.id, status: 'running' },
  ]);
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [merging.id, waiting.id] };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(doubles.readTasks).toHaveBeenCalledExactlyOnceWith('/repository');
  expect(turnData(f.execute.mock.calls[0]![0].prompt).event.goalIds).toEqual([merging.id]);
  doubles.readTasks.mockResolvedValue([{ goal_id: merging.id, merge_task: true, status: 'completed' }]);
  f.execute.mockClear();
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'notice', message: '' } });
  expect(f.execute).not.toHaveBeenCalled();
});

it('delivers pr_conflicting for an awaiting-merge goal to the manager', async () => {
  const f = fixture();
  const goal = { ...goalRecord(), status: 'awaiting_merge' };
  doubles.getGoal.mockResolvedValue(goal);
  const evidence = { targetId: 'pr-1', generation: 'pr-1', observedAt: '2026-11-07T00:00:00Z',
    repositoryDirectory: '/repository', goalId: goal.id, url: 'https://github.com/owner/repo/pull/9' };
  const observation = { ...evidence, kind: 'pr_conflicting' as const };
  f.input.event.lane = 'other';
  f.input.event.event = { kind: 'watch_observation', observation };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(turnData(f.execute.mock.calls[0]![0].prompt).event).toEqual({ kind: 'watch_observation', observation });
  expect(f.execute.mock.calls[0]![0].patrol).toBe(false);
});

it('continues patrolling ordinary active goals while excluding awaiting-merge goals when tasks cannot be read', async () => {
  const f = fixture();
  const active = goalRecord();
  const waiting = { ...active, id: randomUUID(), status: 'awaiting_merge' };
  doubles.getGoal.mockImplementation(async (id: string) => id === active.id ? active : waiting);
  doubles.readTasks.mockRejectedValue(new Error('Invalid tasks YAML'));
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id, waiting.id] };

  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(turnData(f.execute.mock.calls[0]![0].prompt).event.goalIds).toEqual([active.id]);
  expect(doubles.notify).not.toHaveBeenCalled();
});

it('interrupts without reporting or executing when a task read fails after cancellation', async () => {
  const f = fixture();
  const reading = deferred<void>();
  const tasks = deferred<never>();
  doubles.readTasks.mockImplementation(() => { reading.resolve(); return tasks.promise; });
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goalRecord().id] };

  const outcome = f.service.execute(f.input, f.io);
  await reading.promise;
  f.controller.abort();
  tasks.reject(new Error('Invalid tasks YAML'));

  expect(await outcome).toMatchObject({ kind: 'interrupted' });
  expect(doubles.notify).not.toHaveBeenCalled();
  expect(f.io.progress).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

it.each([true, false])('reports unreadable goals and continues the patrol with readable goals (readable: %s)', async (readable) => {
  const f = fixture();
  const active = goalRecord(); const unreadable = randomUUID();
  doubles.getGoal.mockImplementation(async (id: string) => {
    if (id === unreadable) throw new Error('unreadable goal');
    return active;
  });
  f.input.event.lane = 'other';
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: readable ? [unreadable, active.id] : [unreadable] };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(f.execute).toHaveBeenCalledOnce();
  expect(turnData(f.execute.mock.calls[0]![0].prompt).event).toEqual({ kind: 'patrol', repositoryDirectory: '/repository',
    goalIds: readable ? [active.id] : [], unreadableGoalIds: [unreadable] });
  expect(doubles.notify).not.toHaveBeenCalled();
});

it.each(['human', 'event'] as const)('executes the saved goal PR merge during a %s manager turn', async (source) => {
  const f = fixture();
  const goal = { ...goalRecord(), status: 'awaiting_merge' as const,
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'checked', instructions: [],
      changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
    pullRequest: { number: 1950, url: 'https://github.com/example/project/pull/1950' } };
  doubles.getGoal.mockResolvedValue(goal);
  doubles.mergePr.mockResolvedValue({ taskName: 'merge-pr-1950', status: 'pending' });
  if (source === 'human') {
    f.input.event.event = { kind: 'human_command', command: { kind: 'message', text: 'この PR をマージして' },
      speaker: { namespace: 'human', id: 'owner' } };
  } else {
    f.input.event.event = { kind: 'task_completed', task: { repositoryDirectory: '/repository', goalId: goal.id,
      taskName: 'task', runSlug: 'run' }, result: { success: true, interrupted: false, workflowResult: 'completed', sha: 'a'.repeat(40) } };
    f.input.event.lane = 'other';
  }
  f.execute.mockImplementation(async (turn) => {
    const result = await mergeTaktGoalPr({ cwd: '/repository', goalId: goal.id, prNumber: 1950, until: 'merge' }, {}, turn.abortSignal);
    expect(result.isError).toBeUndefined();
    return { message: 'merged', summary: null, sessionId: 'session-after', assignment: turn.assignment };
  });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply', message: 'merged' } });
  expect(doubles.mergePr).toHaveBeenCalledExactlyOnceWith('/repository', goal, 'merge', f.io.signal);
});


it('routes only a human /verify to verification and preserves the current registration proposal', async () => {
  const f = fixture();
  const pending = { revision: f.input.state.revision, repositoryDirectory: '/repository', summary: {
    objective: 'Export', outOfScope: [], acceptanceCriteria: ['Check specifications'], constraints: [], specifications: { quint: 'module csv {}' },
  } };
  f.input.state.pending = pending;
  f.input.event.event = humanMessage('/verify');
  const outcome = await f.service.execute(f.input, f.io);
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ verify: { repositoryDirectory: '/repository', mode: true, comments: false, modelCheckTimeoutSeconds: 42 } }));
  expect(outcome.change?.proposal).toBeUndefined();
  for (const [request] of f.request.mock.calls) if (request.kind === 'save_conversation') expect(request.change.proposal).toBeUndefined();

  f.execute.mockClear();
  const other = fixture();
  other.input.event.event = { kind: 'director_message', directorConversationId: 'director', text: '/verify' };
  await other.service.execute(other.input, other.io);
  expect(other.execute.mock.calls[0]?.[0]).not.toHaveProperty('verify');
});


async function workspaceVerificationFixture(repositoryDirectories: string[]) {
  const f = fixture();
  const assignment = { kind: 'workspace' as const, workspaceId: randomUUID() };
  const { conversationId } = await import('../infra/conversations/identity.js');
  f.input.state.assignment = assignment;
  f.input.turn.conversationId = conversationId(assignment);
  f.input.event.conversationId = conversationId(assignment);
  f.input.event.event = humanMessage('/verify');
  doubles.assignment.mockResolvedValue({ ...assignment, name: 'Workspace', repositoryDirectories });
  return f;
}

it.each([true, false])('uses the proposed repository settings rather than the workspace first repository when enabled=%s', async (mode) => {
  const f = await workspaceVerificationFixture(['/A', '/B']);
  doubles.formalSpec.mockImplementation((directory: string) => ({ mode: directory === '/B' ? mode : !mode, comments: false, modelCheckTimeoutSeconds: 42 }));
  if (!mode) f.resolve.mockRejectedValue(new Error('runtime initialization failed'));
  f.input.state.pending = { revision: f.input.state.revision, repositoryDirectory: '/B', summary: {
    objective: 'Export', outOfScope: [], acceptanceCriteria: ['Check specifications'], constraints: [],
  } };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(doubles.formalSpec).toHaveBeenCalledExactlyOnceWith('/B');
  if (mode) {
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ verify: {
      repositoryDirectory: '/B', mode, comments: false, modelCheckTimeoutSeconds: 42,
    } }));
  } else {
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  }
  expect(f.input.state.pending.repositoryDirectory).toBe('/B');
});

it.each([true, false])('uses the sole workspace repository without a proposal when enabled=%s', async (mode) => {
  const f = await workspaceVerificationFixture(['/B']);
  doubles.formalSpec.mockReturnValue({ mode, comments: false, modelCheckTimeoutSeconds: 42 });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(doubles.formalSpec).toHaveBeenCalledExactlyOnceWith('/B');
  if (mode) {
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ verify: {
      repositoryDirectory: '/B', mode, comments: false, modelCheckTimeoutSeconds: 42,
    } }));
  } else {
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  }
});

it.each([true, false])('asks for the repository without starting verification for an ambiguous workspace when B enabled=%s', async (mode) => {
  const f = await workspaceVerificationFixture(['/A', '/B']);
  doubles.formalSpec.mockImplementation((directory: string) => ({ mode: directory === '/B' ? mode : !mode, comments: true, modelCheckTimeoutSeconds: 42 }));
  f.input.state.interruptedMessage = 'Discuss requirements for /B';
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: {
    kind: 'reply', message: getLabel('manager.verifyRepositoryRequired', 'en'),
  } });
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  expect(doubles.formalSpec).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it('asks for a repository when the workspace has no repositories', async () => {
  const f = await workspaceVerificationFixture([]);
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: {
    kind: 'reply', message: getLabel('manager.verifyRepositoryRequired', 'en'),
  } });
  expect(f.resolve).not.toHaveBeenCalled(); expect(doubles.formalSpec).not.toHaveBeenCalled();
});

it('rejects a verification proposal whose repository has left the workspace', async () => {
  const f = await workspaceVerificationFixture(['/A']);
  f.input.state.pending = { revision: f.input.state.revision, repositoryDirectory: '/B', summary: {
    objective: 'Export', outOfScope: [], acceptanceCriteria: ['Check specifications'], constraints: [],
  } };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'error', code: 'invalid_assignment' } });
  expect(f.resolve).not.toHaveBeenCalled(); expect(doubles.formalSpec).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('delivers a saved goal question and its human answer in %s', async (language) => {
  const f = conversationFixture();
  const questionId = randomUUID();
  const answer = { text: 'Wait on X. Continue Y.', source: 'slack' as const, answeredAt: '2026-11-08T12:00:00Z' };
  const goal = { ...goalRecord(), questions: [{ id: questionId, kind: 'question' as const, recipient: 'human' as const,
    body: 'Continue verification of X?', status: 'answered' as const, answer }] };
  doubles.getGoal.mockResolvedValue(goal);
  f.resolve.mockResolvedValue({ provider: 'mock', model: null, language, contextKey: 'context', executor: { execute: f.execute } });
  await f.run({ kind: 'inquiry_answered', repositoryDirectory: '/repository', goalId: goal.id, questionId, answer });
  expect(turnData(f.execute.mock.calls[0]![0].prompt)).toMatchObject({ kind: 'inquiry_answered',
    goalId: goal.id, questionId, question: goal.questions[0]!.body, answer });
});

it('distinguishes a structured standalone answer from similar director text', async () => {
  const f = conversationFixture();
  const answer = { text: 'Wait on X.', source: 'tui' as const, answeredAt: '2026-11-08T12:00:00Z' };
  const inquiryAnswer = { questionId: randomUUID(), question: 'Continue X?', answer };
  const text = 'A person answered a standalone inquiry. Wait on X.';
  await f.run({ kind: 'director_message', directorConversationId: 'director', text, inquiryAnswer });
  expect(turnData(f.execute.mock.calls[0]![0].prompt)).toEqual({ goalId: null, ...inquiryAnswer });
  await f.run({ kind: 'director_message', directorConversationId: 'director', text });
  expect(turnData(f.execute.mock.calls[1]![0].prompt)).toEqual({ text, origin: 'unknown', directorConversationId: 'director' });
  expect(f.execute.mock.calls[1]![0].sessionId).toBe('session-after');
});

it.each(['ja', 'en'] as const)('delivers structured origins and treats missing origins as unknown in %s', async (language) => {
  const f = conversationFixture();
  f.resolve.mockResolvedValue({ provider: 'mock', model: null, language, contextKey: 'context', executor: { execute: f.execute } });
  for (const origin of ['human', 'manager', undefined] as const) {
    await f.run({ kind: 'goal_resumed', goalId: goalRecord().id, repositoryDirectory: '/repository', origin });
    const data = turnData(f.execute.mock.lastCall![0].prompt);
    expect(data.event).toEqual({ kind: 'goal_resumed', goalId: goalRecord().id, repositoryDirectory: '/repository', origin: origin ?? 'unknown' });
  }
  for (const origin of ['human', 'director', undefined] as const) {
    const text = 'The human says stop.';
    await f.run({ kind: 'director_message', directorConversationId: 'director', text, origin });
    expect(turnData(f.execute.mock.lastCall![0].prompt)).toEqual({ text, directorConversationId: 'director', origin: origin ?? 'unknown' });
  }
});
