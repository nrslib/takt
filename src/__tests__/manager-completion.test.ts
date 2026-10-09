import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), list: vi.fn(), tasks: vi.fn(), record: vi.fn(), reconcile: vi.fn(), plan: vi.fn(), call: vi.fn(), ensure: vi.fn(), dispose: vi.fn(), prepare: vi.fn(), release: vi.fn(), preflight: vi.fn(), tryTurn: vi.fn(), failInterrupted: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; list = doubles.list; } }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: doubles.reconcile, recordGoalCompletion: doubles.record }));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: async (_cwd: string, _ids: string[], action: (owners: Record<string, string>) => Promise<unknown>) => action({}), tryWithGoalTurn: doubles.tryTurn }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; failInterruptedRunningTasks = doubles.failInterrupted; } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/goalConfirmation.js', () => ({ createGoalConfirmation: () => ({ publicKey: 'public' }) }));
vi.mock('../features/manager/managerMcp.js', () => ({ prepareManagerMcp: async () => ({ servers: {}, dispose: doubles.release }) }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/providers/mcp/index.js', () => ({ createMcpAdapter: () => ({ validate: () => {}, prepare: doubles.prepare }) }));
import { processGoalCompletions, processGoalAnswers, recoverManagerEvents } from '../features/manager/completionTurn.js';
import { recordManagerRunFailure } from '../infra/task/manager-run-state.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: vi.fn(), readManagerRunFailures: () => [{ id: 'failure-id', message: 'spawn failed' }] }));
let goal: Goal;
let provider: string;
beforeEach(() => {
  vi.resetAllMocks();
  provider = 'mock';
  goal = { ...goalRecord(), events: [{ taskName: 'task-a', runSlug: 'run-a', processed: false, result: { success: true, interrupted: false, sha: 'original-sha' } }] };
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [structuredClone(goal)], errors: [] }));
  doubles.tasks.mockReturnValue([]);
  doubles.tryTurn.mockImplementation(async (_cwd: string, _id: string, action: (owners: Record<string, string>) => Promise<void>) => action({}));
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); return goal; });
  doubles.plan.mockImplementation(() => ({ ctx: { providerType: provider, provider: { setup: () => ({ call: doubles.call }), preflight: doubles.preflight }, lang: 'en' }, strategy: { systemPrompt: 'shared facets', allowedTools: ['Read', 'mcp__manager__enqueue'] } }));
  doubles.prepare.mockResolvedValue({ dispose: doubles.dispose });
  doubles.call.mockResolvedValue({ status: 'done', content: '', structuredOutput: { message: 'saved summary', summary: null }, sessionId: 'goal-session' } satisfies Partial<Awaited<ReturnType<ProviderAgent['call']>>>);
});
describe('goal completion turns', () => {
  it('uses the target goal provider session for a saved answer and recovers the same event after failure', async () => {
    goal.events = [];
    const answer = { text: 'JSON', source: 'tui' as const, answeredAt: '2026-10-08T00:00:00Z' };
    goal.answerEvents = [{ questionId: '650e8400-e29b-41d4-a716-446655440001', answer, processed: false }];
    goal.sessions = [{ provider: 'claude', sessionId: 'other-provider' }, { provider: 'mock', sessionId: 'answer-goal-session' }];
    doubles.call.mockRejectedValueOnce(new Error('answer provider failure'));
    await processGoalAnswers('/project', goal.id, {});
    expect(goal.answerEvents[0]).toMatchObject({ processed: false, answer });
    expect(recordManagerRunFailure).toHaveBeenCalledOnce();
    expect(doubles.record).not.toHaveBeenCalled();
    await recoverManagerEvents('/project');
    expect(goal.answerEvents).toEqual([{ questionId: '650e8400-e29b-41d4-a716-446655440001', answer, processed: true, summary: 'saved summary' }]);
    expect(JSON.parse(doubles.call.mock.calls[1]![0])).toMatchObject({ goal: { id: goal.id }, event: { answer } });
    expect(doubles.call.mock.calls[1]![1]).toMatchObject({ sessionId: 'answer-goal-session', permissionMode: 'readonly' });
    expect((await readManagerDisplayEvents('/project')).events).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'saved summary' })]));
  });
  it.each(['goal list', 'task state'] as const)('records a recovery failure at %s without propagating the error', async (boundary) => {
    const failure = new Error('recovery unavailable');
    if (boundary === 'goal list') doubles.list.mockRejectedValueOnce(failure);
    else doubles.tasks.mockImplementationOnce(() => { throw failure; });
    await expect(recoverManagerEvents('/project')).resolves.toBeUndefined();
    expect(recordManagerRunFailure).toHaveBeenCalledExactlyOnceWith('/project', failure);
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
    await recoverManagerEvents('/project');
    expect(goal.events![0]!.processed).toBe(true);
  });
  it('persists the supplied completion before invoking the manager', async () => {
    const { taskName, runSlug, result } = goal.events![0]!;
    const completion = { taskName, runSlug, result };
    await processGoalCompletions('/project', goal.id, {}, completion);
    expect(doubles.record).toHaveBeenCalledExactlyOnceWith('/project', goal.id, completion);
    expect(doubles.record.mock.invocationCallOrder[0]).toBeLessThan(doubles.call.mock.invocationCallOrder[0]!);
    expect(goal.events![0]!.processed).toBe(true);
  });
  it('leaves the saved result recoverable without invoking a manager when event publication fails', async () => {
    const { taskName, runSlug, result } = goal.events![0]!;
    doubles.record.mockRejectedValue(new Error('event write failed'));
    await expect(processGoalCompletions('/project', goal.id, {}, { taskName, runSlug, result })).resolves.toBeUndefined();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
  });
  it('preserves a processed result when startup diagnostics themselves cannot be saved', async () => {
    doubles.ensure.mockRejectedValue(new Error('startup state write failed'));
    await expect(processGoalCompletions('/project', goal.id)).resolves.toBeUndefined();
    expect(goal.events![0]!.processed).toBe(true);
    expect(goal.events![0]!.result.success).toBe(true);
  });
  it('checks the same read-only MCP capabilities before starting a completion turn', async () => {
    doubles.preflight.mockRejectedValue(new Error('unsupported capability'));
    await processGoalCompletions('/project', goal.id);
    expect(doubles.preflight).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'readonly', allowedTools: ['Read', 'mcp__manager__enqueue'], mcpOnlySideEffects: ['Read', 'mcp__manager__enqueue'], mcpServers: {}, outputSchema: expect.any(Object) }));
    expect(doubles.call).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/project');
  });
  it('rebuilds saved context and preserves independent provider sessions across a provider switch', async () => {
    await processGoalCompletions('/project', goal.id);
    expect(goal.events?.[0]).toMatchObject({ processed: true, summary: 'saved summary', result: { sha: 'original-sha' } });
    expect(doubles.call.mock.calls[0]![1]).toMatchObject({ sessionId: undefined, permissionMode: 'readonly', allowedTools: ['Read', 'mcp__manager__enqueue'], mcpOnlySideEffects: ['Read', 'mcp__manager__enqueue'] });
    goal.events!.push({ ...goal.events![0]!, taskName: 'task-b', runSlug: 'run-b', processed: false });
    goal.workUnits = [{ taskName: 'task-b', purpose: 'saved purpose' }];
    provider = 'claude';
    doubles.call.mockResolvedValueOnce({ status: 'done', structuredOutput: { message: 'other provider', summary: null }, sessionId: 'claude-session' });
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBeUndefined();
    goal.events!.push({ ...goal.events![0]!, taskName: 'task-c', runSlug: 'run-c', processed: false });
    provider = 'mock';
    doubles.call.mockResolvedValueOnce({ status: 'done', structuredOutput: { message: 'resumed', summary: null } });
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call.mock.calls[2]![1].sessionId).toBe('goal-session');
    expect(JSON.parse(doubles.call.mock.calls[2]![0] as string).goal.workUnits).toEqual(goal.workUnits);
    expect(goal.sessions).toEqual([{ provider: 'mock', sessionId: 'goal-session' }, { provider: 'claude', sessionId: 'claude-session' }]);
  });
  it.each(['provider', 'prepared cleanup'] as const)('keeps a failed event pending after %s failure and still judges saved work for launch', async (failure) => {
    if (failure === 'provider') doubles.call.mockRejectedValue(new Error('provider failed after enqueue'));
    else doubles.dispose.mockRejectedValue(new Error('cleanup failed'));
    await processGoalCompletions('/project', goal.id);
    expect(goal.events![0]!.processed).toBe(false);
    expect(goal.events![0]!.result.sha).toBe('original-sha');
    expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/project');
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.update).not.toHaveBeenCalled();
  });
  it('does not relaunch work merely because no event needs a manager turn', async () => {
    goal.events![0]!.processed = true;
    await recoverManagerEvents('/project');
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    expect(doubles.tryTurn).not.toHaveBeenCalled();
  });
  it('retries an event on the next recovery opportunity when its goal turn was busy', async () => {
    doubles.tryTurn.mockResolvedValueOnce(undefined);
    await recoverManagerEvents('/project');
    expect(doubles.call).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
    expect(doubles.ensure).not.toHaveBeenCalled();
    await recoverManagerEvents('/project');
    expect(doubles.call).toHaveBeenCalledTimes(1);
    expect(goal.events![0]!.processed).toBe(true);
  });
  it('recovers a stale running task inside its goal turn before reconciling results', async () => {
    goal.events = [];
    doubles.tasks.mockReturnValue([{ goalId: goal.id, name: 'orphan', status: 'running' }]);
    doubles.reconcile.mockImplementation(async () => {
      goal.events = [{ taskName: 'orphan', runSlug: 'orphan-run', processed: false, result: { success: false, interrupted: true } }];
    });
    await recoverManagerEvents('/project');
    expect(doubles.failInterrupted).toHaveBeenCalledExactlyOnceWith(goal.id);
    expect(doubles.failInterrupted.mock.invocationCallOrder[0]).toBeLessThan(doubles.reconcile.mock.invocationCallOrder[0]!);
    expect(goal.events[0]?.processed).toBe(true);
    expect(JSON.parse(doubles.call.mock.calls[0]![0]).event.result.interrupted).toBe(true);
  });
  it('leaves a busy goal orphan untouched until the next recovery opportunity', async () => {
    goal.events = [];
    doubles.tasks.mockReturnValue([{ goalId: goal.id, name: 'orphan', status: 'running' }]);
    doubles.tryTurn.mockResolvedValueOnce(undefined);
    await recoverManagerEvents('/project');
    expect(doubles.failInterrupted).not.toHaveBeenCalled();
    expect(doubles.reconcile).not.toHaveBeenCalled();
    expect(doubles.call).not.toHaveBeenCalled();
  });
  it('retries a pending response after goal publication fails', async () => {
    doubles.update.mockRejectedValueOnce(new Error('injected goal write failure'));
    await processGoalCompletions('/project', goal.id);
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(2);
    expect(goal.events![0]).toMatchObject({ processed: true, summary: 'saved summary' });
  });
  it.each(['before lock', 'after waiting'] as const)('refuses an unreadable goal %s without calling the provider or recording an event', async (boundary) => {
    if (boundary === 'before lock') doubles.get.mockRejectedValueOnce(new Error('missing goal'));
    if (boundary === 'after waiting') doubles.get.mockResolvedValueOnce(goal).mockRejectedValueOnce(new Error('unreadable goal'));
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
  });
  it('reads persisted summaries and spawn diagnostics, and reports unreadable goals', async () => {
    goal.events![0]!.summary = 'persisted summary';
    expect((await readManagerDisplayEvents('/project')).events).toEqual([
      { id: JSON.stringify([goal.id, 'task-a', 'run-a']), message: 'persisted summary' },
      { id: 'failure-id', message: 'spawn failed' },
    ]);
    doubles.list.mockResolvedValueOnce({ goals: [goal], errors: [{ goalId: 'broken', error: new Error('invalid goal') }] });
    const displayed = await readManagerDisplayEvents('/project');
    expect(displayed.events).toHaveLength(2);
    expect(displayed.diagnostics).toEqual([{
      id: JSON.stringify(['diagnostic', 'goal', 'broken', 'invalid goal']), message: 'broken: invalid goal',
    }]);
    doubles.list.mockResolvedValueOnce({ goals: [goal], errors: [{ goalId: 'broken', error: new Error('invalid goal') }] });
    expect((await readManagerDisplayEvents('/project')).diagnostics).toEqual(displayed.diagnostics);
    doubles.list.mockRejectedValueOnce(new Error('list inaccessible'));
    expect(await readManagerDisplayEvents('/project')).toEqual({
      events: [{ id: 'failure-id', message: 'spawn failed' }],
      diagnostics: [{ id: JSON.stringify(['diagnostic', 'goals', 'list inaccessible']), message: 'list inaccessible' }],
      questions: [],
    });
  });
});
