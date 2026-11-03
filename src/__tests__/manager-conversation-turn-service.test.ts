import { beforeEach, expect, it, vi } from 'vitest';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import type { ConversationRuntime, PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { DaemonStateRequest } from '../core/daemon/processProtocol.js';
import type { TurnIo } from '../features/daemonTurn/processRuntime.js';
import { turnStart, deferred } from './helpers/daemon-turn.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { randomUUID } from 'node:crypto';
import type { AssistantCliOverrides } from '../core/config/provider-resolution.js';
import type { TurnEvent } from '../core/daemon/events.js';

const doubles = vi.hoisted(() => ({ assignment: vi.fn(), register: vi.fn(), autoRun: vi.fn(), notify: vi.fn(), reconcile: vi.fn(), getGoal: vi.fn(), updateGoal: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.getGoal; update = doubles.updateGoal; } }));
vi.mock('../features/daemonTurn/reconcileLostRun.js', () => ({ reconcileLostRun: doubles.reconcile }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(),
  resolveCurrentManagerAssignment: doubles.assignment, resolveAssignedProjectRoot: async (path: string) => path }));
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
beforeEach(() => {
  vi.resetAllMocks();
  doubles.assignment.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/repository', repositoryDirectories: ['/repository'] });
  doubles.getGoal.mockResolvedValue(goalRecord()); doubles.updateGoal.mockResolvedValue(goalRecord());
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
  const f = fixture();
  f.execute.mockImplementation(async (turn) => {
    await turn.recovery!.invalidateSession();
    f.controller.abort();
    throw new Error('aborted');
  });
  const outcome = await f.service.execute(f.input, f.io);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(outcome).toMatchObject({ kind: 'interrupted', change: { expectedVersion: 12, session: { sessionId: null } } });
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
  expect(await f.service.execute(f.input, f.io)).toMatchObject({ kind: 'completed' });
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
