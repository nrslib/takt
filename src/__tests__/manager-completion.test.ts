import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), list: vi.fn(), record: vi.fn(), reconcile: vi.fn(), plan: vi.fn(), call: vi.fn(), ensure: vi.fn(), dispose: vi.fn(), prepare: vi.fn(), release: vi.fn(), preflight: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; list = doubles.list; } }));
vi.mock('../infra/goals/registration.js', () => ({ getRegisteredGoal: (_cwd: string, id: string) => doubles.get(id), listRegisteredGoals: doubles.list }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: doubles.reconcile, recordGoalCompletion: doubles.record }));
vi.mock('../infra/goals/completion-evidence.js', () => ({
  verifiedGoalCompletionContext: (_cwd: string, saved: Goal) => {
    const sessions = new Map<string, { provider: string; sessionId: string }>();
    const events = saved.events?.map((event) => {
      const host = processed.get(event.runSlug);
      if (host?.session !== undefined) sessions.set(host.session.provider, host.session);
      return { ...event, ...(host === undefined ? {} : { processed: host.processed, summary: host.summary }) };
    });
    return { ...saved, events, sessions: [...sessions.values()] };
  },
  markGoalCompletionProcessed: (_cwd: string, _id: string, event: { runSlug: string }, summary: string, session: { provider: string; sessionId: string } | undefined) => { processed.set(event.runSlug, { processed: true, summary, session }); },
}));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: async (_cwd: string, _ids: string[], action: (owners: Record<string, string>) => Promise<unknown>) => action({}) }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/goalConfirmation.js', () => ({ createGoalConfirmation: () => ({ publicKey: 'public' }) }));
vi.mock('../features/manager/managerMcp.js', () => ({ prepareManagerMcp: async () => ({ servers: {}, dispose: doubles.release }) }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/providers/mcp/index.js', () => ({ createMcpAdapter: () => ({ validate: () => {}, prepare: doubles.prepare }) }));
import { processGoalCompletions, recoverManagerEvents } from '../features/manager/completionTurn.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: vi.fn(), readManagerRunFailures: () => [{ id: 'failure-id', message: 'spawn failed' }] }));
let goal: Goal;
let provider: string;
const processed = new Map<string, { processed: boolean; summary: string; session: { provider: string; sessionId: string } | undefined }>();
beforeEach(() => {
  vi.resetAllMocks();
  processed.clear();
  provider = 'mock';
  goal = { ...goalRecord(), events: [{ taskName: 'task-a', runSlug: 'run-a', processed: false, result: { success: true, interrupted: false, sha: 'original-sha' } }] };
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [structuredClone(goal)], errors: [] }));
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); return goal; });
  doubles.reconcile.mockImplementation(async () => {
    goal.events = goal.events?.map((event) => {
      const host = processed.get(event.runSlug);
      return { ...event, ...(host === undefined ? {} : { processed: host.processed, summary: host.summary }) };
    });
  });
  doubles.plan.mockImplementation(() => ({ ctx: { providerType: provider, provider: { setup: () => ({ call: doubles.call }), preflight: doubles.preflight }, lang: 'en' }, strategy: { systemPrompt: 'shared facets', allowedTools: ['Read', 'mcp__manager__enqueue'] } }));
  doubles.prepare.mockResolvedValue({ dispose: doubles.dispose });
  doubles.call.mockResolvedValue({ status: 'done', content: '', structuredOutput: { message: 'saved summary', summary: null }, sessionId: 'goal-session' } satisfies Partial<Awaited<ReturnType<ProviderAgent['call']>>>);
});
describe('goal completion turns', () => {
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
    expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/project', 'turn-ended');
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
    expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/project', 'turn-ended');
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.update).not.toHaveBeenCalled();
  });
  it('does not relaunch work merely because no event needs a manager turn', async () => {
    goal.events![0]!.processed = true;
    await recoverManagerEvents('/project');
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
  });
  it('recovers a processed response after goal publication fails without calling the provider twice', async () => {
    doubles.update.mockRejectedValueOnce(new Error('injected goal write failure'));
    await processGoalCompletions('/project', goal.id);
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(1);
    expect(goal.events![0]).toMatchObject({ processed: true, summary: 'saved summary' });
  });
  it.each(['before lock', 'after waiting', 'before provider'] as const)('refuses an unverified goal %s without calling the provider or recording an event', async (boundary) => {
    if (boundary === 'before lock') doubles.get.mockRejectedValueOnce(new Error('missing registration'));
    if (boundary === 'after waiting') doubles.get.mockResolvedValueOnce(goal).mockRejectedValueOnce(new Error('changed registration'));
    if (boundary === 'before provider') doubles.prepare.mockImplementationOnce(async () => {
      doubles.get.mockRejectedValueOnce(new Error('changed registration'));
      return { dispose: doubles.dispose };
    });
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
    expect(displayed.diagnostics).toEqual(['broken: invalid goal']);
    doubles.list.mockRejectedValueOnce(new Error('list inaccessible'));
    expect(await readManagerDisplayEvents('/project')).toEqual({ events: [{ id: 'failure-id', message: 'spawn failed' }], diagnostics: ['list inaccessible'] });
  });
});
