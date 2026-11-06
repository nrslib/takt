import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationTurnService } from '../features/manager/conversationService.js';
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
import * as labels from '../shared/i18n/index.js';
import { getLabel } from '../shared/i18n/index.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), register: vi.fn(), autoRun: vi.fn(), notify: vi.fn(), reconcile: vi.fn(), getGoal: vi.fn(), mergePr: vi.fn(), updateGoal: vi.fn(), setStatus: vi.fn(), invalidate: vi.fn() }));
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
  { language: 'ja' as const, recipient: 'human', explanation: /中断/ },
  { language: 'en' as const, recipient: 'human', explanation: /interrupt/i },
  { language: 'ja' as const, recipient: 'event', explanation: /中断/ },
  { language: 'en' as const, recipient: 'event', explanation: /interrupt/i },
])('prepends the localized interrupted human message to a $recipient turn in $language', async ({ language, recipient, explanation }) => {
  const f = conversationFixture();
  const getLabel = vi.spyOn(labels, 'getLabel');
  f.resolve.mockResolvedValue({ provider: 'mock', model: null, language, contextKey: 'context', executor: { execute: f.execute } });
  const text = '  interrupted {value}\noriginal text  ';
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage(text), controller);
  expect(f.state()).toMatchObject({ interruptedMessage: text });
  await f.run(recipient === 'human' ? humanMessage('current request')
    : { kind: 'director_message', text: 'current request', directorConversationId: 'director' });
  const prompt = f.execute.mock.calls[1]![0].prompt;
  expect(prompt.slice(0, prompt.indexOf(text))).toMatch(explanation);
  expect(prompt).toContain(text);
  expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf('current request'));
  expect(getLabel.mock.calls.some((call, index) => {
    const result = getLabel.mock.results[index];
    return call[1] === language && result?.type === 'return' && result.value.length > 0
      && prompt.indexOf(result.value) >= 0 && prompt.indexOf(result.value) < prompt.indexOf('current request');
  })).toBe(true);
  if (recipient === 'event') expect(prompt.indexOf('Speaker:')).toBeGreaterThan(prompt.indexOf('current request'));
});

it('clears interrupted context after one completed message turn', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  await f.run(humanMessage('first continuation'));
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: null });
  await f.run(humanMessage('second continuation'));
  expect(f.execute.mock.calls[2]![0].prompt).toBe('second continuation');
});

it('keeps prompts unchanged across completed turns with no interruption', async () => {
  const f = conversationFixture();
  await f.run(humanMessage('first request'));
  await f.run(humanMessage('second request'));
  expect(f.execute.mock.calls.map(([turn]) => turn.prompt)).toEqual(['first request', 'second request']);
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

it('replaces the interrupted human message with only the latest original text when interrupted again', async () => {
  const f = conversationFixture();
  for (const text of ['older interrupted request', 'latest interrupted request']) {
    const controller = new AbortController(); f.interruptNext(controller);
    await f.run(humanMessage(text), controller);
  }
  expect(f.execute.mock.calls[1]![0].prompt).toContain('older interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: 'latest interrupted request' });
  await f.run(humanMessage('continue'));
  const prompt = f.execute.mock.calls[2]![0].prompt;
  expect(prompt).toContain('latest interrupted request');
  expect(prompt).not.toContain('older interrupted request');
  expect(prompt.split('latest interrupted request')).toHaveLength(2);
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
  expect(f.execute.mock.calls[3]![0].prompt).toBe('next human request');
});

it('does not save an interrupted event as a human message', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run({ kind: 'director_message', text: 'interrupted event', directorConversationId: 'director' }, controller);
  await f.run(humanMessage('next human request'));
  expect(f.execute.mock.calls[1]![0]).toMatchObject({ prompt: 'next human request', sessionId: 'shared-session' });
});

it('clears delivered interrupted context when the next message ends with a handled executor error', async () => {
  const f = conversationFixture();
  const controller = new AbortController(); f.interruptNext(controller);
  await f.run(humanMessage('interrupted request'), controller);
  f.execute.mockRejectedValueOnce(new Error('provider failed'));
  expect(await f.run(humanMessage('failed continuation'))).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect(f.execute.mock.calls[1]![0].prompt).toContain('interrupted request');
  expect(f.state()).toMatchObject({ interruptedMessage: null });
  await f.run(humanMessage('next request'));
  expect(f.execute.mock.calls[2]![0].prompt).toBe('next request');
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
  expect(doubles.setStatus).toHaveBeenCalledExactlyOnceWith('/repository', goalId, status, f.io.signal);
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

it('inspects active patrol goals together using the saved conversation and no registration proposal', async () => {
  const f = fixture();
  const active = goalRecord(); const paused = { ...goalRecord(), id: randomUUID(), executionStatus: 'paused' };
  doubles.getGoal.mockImplementation(async (id: string) => id === active.id ? active : paused);
  f.input.event.lane = 'other';
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id, paused.id] };
  const message = 'Patrol: 1 goal, no anomalies';
  f.execute.mockResolvedValue({ message, summary: null, sessionId: 'next', assignment: undefined });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply', message },
    change: { session: { sessionId: 'next' } } });
  const turn = f.execute.mock.calls[0]![0];
  expect(JSON.parse(turn.prompt)).toMatchObject({ event: { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [active.id] },
    instruction: expect.any(String) });
  expect(turn).toMatchObject({ patrol: true, sessionId: 'shared-session' });
  expect(doubles.updateGoal).not.toHaveBeenCalled();
  expect(doubles.notify).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted', 'completed'] as const)('does not run a queued patrol when its goals have become %s', async (status) => {
  const f = fixture();
  const goal = goalRecord();
  doubles.getGoal.mockResolvedValue(status === 'completed' ? { ...goal, status } : { ...goal, executionStatus: status });
  f.input.event.event = { kind: 'patrol', repositoryDirectory: '/repository', goalIds: [goal.id] };
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'notice', message: '' } });
  expect(f.resolve).not.toHaveBeenCalled();
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
  expect(JSON.parse(f.execute.mock.calls[0]![0].prompt).event).toEqual({ kind: 'patrol', repositoryDirectory: '/repository',
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
  doubles.mergePr.mockResolvedValue({ success: true, output: 'merged' });
  if (source === 'human') {
    f.input.event.event = { kind: 'human_command', command: { kind: 'message', text: 'この PR をマージして' },
      speaker: { namespace: 'human', id: 'owner' } };
  } else {
    f.input.event.event = { kind: 'task_completed', task: { repositoryDirectory: '/repository', goalId: goal.id,
      taskName: 'task', runSlug: 'run' }, result: { success: true, interrupted: false, workflowResult: 'completed', sha: 'a'.repeat(40) } };
    f.input.event.lane = 'other';
  }
  f.execute.mockImplementation(async (turn) => {
    const result = await mergeTaktGoalPr({ cwd: '/repository', goalId: goal.id, prNumber: 1950 }, {}, turn.abortSignal);
    expect(result.isError).toBeUndefined();
    return { message: 'merged', summary: null, sessionId: 'session-after', assignment: turn.assignment };
  });
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed', result: { kind: 'reply', message: 'merged' } });
  expect(doubles.mergePr).toHaveBeenCalledExactlyOnceWith('/repository', 1950, goal.branch, goal.completion.goalSha, f.io.signal);
});
