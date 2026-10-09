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
vi.mock('../features/manager/managerMcp.js', () => ({ prepareManagerMcp: vi.fn(async () => ({ servers: {}, dispose: doubles.release })) }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: { custom: true }, mainMerge: 'approve' }),
  sendSavedGoalNotifications: vi.fn(),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/providers/mcp/index.js', () => ({ createMcpAdapter: () => ({ validate: () => {}, prepare: doubles.prepare }) }));
import { processGoalCompletions, processGoalAnswers, recoverManagerEvents } from '../features/manager/completionTurn.js';
import { prepareManagerMcp } from '../features/manager/managerMcp.js';
import { notifyTaktGoal } from '../features/mcp/goalNotificationOperations.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { recordManagerRunFailure } from '../infra/task/manager-run-state.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: vi.fn(), readManagerRunFailures: () => [{ id: 'failure-id', message: 'spawn failed' }] }));
let goal: Goal;
let provider: string;
function completionEvent() {
  const event = goal.events![0]!;
  if (event.kind !== 'completion') throw new Error('Expected a completion event');
  return event;
}
beforeEach(() => {
  vi.resetAllMocks();
  provider = 'mock';
  goal = Object.assign(goalRecord(), { executionStatus: 'active', acceptanceCriteriaVersion: 1,
    events: [{ id: 'event-a', kind: 'completion' as const, taskName: 'task-a', runSlug: 'run-a', processed: false,
      result: { success: true, interrupted: false, sha: 'original-sha' } }],
  });
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [structuredClone(goal)], errors: [] }));
  doubles.tasks.mockReturnValue([]);
  doubles.tryTurn.mockImplementation(async (_cwd: string, _id: string, action: (owners: Record<string, string>) => Promise<void>) => action({}));
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); return goal; });
  doubles.plan.mockImplementation(() => ({ ctx: { providerType: provider, provider: { setup: () => ({ call: doubles.call }), preflight: doubles.preflight }, lang: 'en' }, strategy: { systemPrompt: 'shared facets', allowedTools: ['Read', 'mcp__manager__enqueue'] } }));
  doubles.prepare.mockResolvedValue({ dispose: doubles.dispose });
  vi.mocked(prepareManagerMcp).mockResolvedValue({ command: process.execPath, args: [], env: {}, servers: {}, dispose: doubles.release });
  doubles.call.mockResolvedValue({ status: 'done', content: '', structuredOutput: { message: 'saved summary', summary: null }, sessionId: 'goal-session' } satisfies Partial<Awaited<ReturnType<ProviderAgent['call']>>>);
});
describe('goal completion turns', () => {
  it('replays the saved operation name from the actual retry input without repeating its notification', async () => {
    let firstResult: unknown;
    doubles.call.mockImplementation(async (prompt: string, options) => {
      const saved = JSON.parse(prompt);
      const previous = saved.goal.operations[0];
      const context = vi.mocked(prepareManagerMcp).mock.calls.at(-1)![2]!;
      const input = previous === undefined
        ? { kind: 'custom' as const, body: 'verified output', operationName: 'notify:verified-output' }
        : { ...previous.arguments, operationName: previous.operationName };
      const reply = await notifyTaktGoal({ cwd: '/project', goalId: goal.id, ...input }, { goalEventContext: context }, new AbortController().signal);
      expect(reply.isError).toBeUndefined();
      const result = JSON.parse(firstTextContent(reply.content));
      expect(options.sessionId).toBeUndefined();
      if (previous === undefined) { firstResult = result; throw new Error('provider failed after saving notification'); }
      expect(result).toEqual(firstResult);
      expect(previous.result).toEqual(firstResult);
      return { status: 'done', structuredOutput: { message: 'recovered', summary: null } };
    });
    await processGoalCompletions('/project', goal.id);
    expect(goal.events![0]!.processed).toBe(false);
    expect(goal.notifications).toHaveLength(1);
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(2);
    expect(goal.notifications).toHaveLength(1);
    expect(goal.operations).toHaveLength(1);
    expect(goal.events![0]).toMatchObject({ processed: true, summary: 'recovered' });
  });
  it('aborts pending preflight and leaves the event available for the next startup', async () => {
    const controller = new AbortController();
    doubles.preflight.mockImplementationOnce(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      expect(abortSignal).toBe(controller.signal);
      await new Promise<void>((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    });
    const recovery = recoverManagerEvents('/project', {}, controller.signal);
    await vi.waitFor(() => expect(doubles.preflight).toHaveBeenCalledTimes(1));

    controller.abort();
    await recovery;

    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    expect(recordManagerRunFailure).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);

    await recoverManagerEvents('/project');

    expect(goal.events![0]!.processed).toBe(true);
    expect(doubles.call).toHaveBeenCalledTimes(1);
  });

  it('does not start recovery or record a failure when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await recoverManagerEvents('/project', {}, controller.signal);

    expect(doubles.list).not.toHaveBeenCalled();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    expect(recordManagerRunFailure).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
  });

  it.each(['completion', 'answer'] as const)('keeps an aborted %s event pending and recovers it on the next startup', async (kind) => {
    if (kind === 'answer') {
      goal.events = [{
        id: 'answer-event', kind: 'answer', questionId: '650e8400-e29b-41d4-a716-446655440001', processed: false,
        answer: { text: 'JSON', source: 'tui', answeredAt: '2026-10-08T00:00:00Z' },
      }];
    }
    const controller = new AbortController();
    doubles.call.mockImplementationOnce(async (_prompt, options) => {
      expect(options.abortSignal).toBe(controller.signal);
      await new Promise<void>((resolve) => options.abortSignal.addEventListener('abort', () => resolve(), { once: true }));
      throw options.abortSignal.reason;
    });
    let finishCleanup!: () => void;
    doubles.dispose.mockReturnValueOnce(new Promise<void>((resolve) => { finishCleanup = resolve; }));
    const recovery = recoverManagerEvents('/project', {}, controller.signal);
    await vi.waitFor(() => expect(doubles.call).toHaveBeenCalledTimes(1));
    expect(doubles.prepare).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ abortSignal: controller.signal }));

    controller.abort();
    await vi.waitFor(() => expect(doubles.dispose).toHaveBeenCalledTimes(1));
    expect(doubles.release).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    finishCleanup();
    await recovery;

    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    expect(recordManagerRunFailure).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);

    await recoverManagerEvents('/project');

    expect(goal.events![0]).toMatchObject({ processed: true, summary: 'saved summary' });
    expect(doubles.call).toHaveBeenCalledTimes(2);
    for (const [, options] of doubles.call.mock.calls) expect(options.sessionId).toBeUndefined();
  });

  it.each(['preflight', 'MCP preparation', 'provider response', 'prepared cleanup', 'manager MCP cleanup', 'publication'] as const)(
    'does not publish an event or launch work after abort during %s', async (boundary) => {
      const controller = new AbortController();
      goal.events!.push({ ...completionEvent(), id: 'event-b', taskName: 'task-b', runSlug: 'run-b' });
      const abort = () => controller.abort();
      if (boundary === 'preflight') doubles.preflight.mockImplementationOnce(abort);
      if (boundary === 'MCP preparation') doubles.prepare.mockImplementationOnce(async () => {
        abort();
        return { dispose: doubles.dispose };
      });
      if (boundary === 'provider response') doubles.call.mockImplementationOnce(async () => {
        abort();
        return { status: 'done', structuredOutput: { message: 'late reply', summary: null } };
      });
      if (boundary === 'prepared cleanup') doubles.dispose.mockImplementationOnce(abort);
      if (boundary === 'manager MCP cleanup') doubles.release.mockImplementationOnce(abort);
      if (boundary === 'publication') doubles.update.mockImplementationOnce(async (_id: string, update: (saved: Goal) => Goal) => {
        abort();
        goal = update(goal);
      });

      await recoverManagerEvents('/project', {}, controller.signal);

      expect(goal.events!.every((event) => !event.processed)).toBe(true);
      expect(doubles.call).toHaveBeenCalledTimes(boundary === 'preflight' || boundary === 'MCP preparation' ? 0 : 1);
      expect(doubles.dispose).toHaveBeenCalledTimes(boundary === 'preflight' ? 0 : 1);
      expect(doubles.release).toHaveBeenCalledTimes(1);
      expect(doubles.ensure).not.toHaveBeenCalled();
      expect(recordManagerRunFailure).not.toHaveBeenCalled();
    },
  );

  it('starts a fresh session for a saved answer and its recovery after provider failure', async () => {
    const answer = { text: 'JSON', source: 'tui' as const, answeredAt: '2026-10-08T00:00:00Z' };
    Object.assign(goal, { events: [{ id: 'answer-event', kind: 'answer', questionId: '650e8400-e29b-41d4-a716-446655440001', answer, processed: false }],
      sessions: [{ provider: 'mock', sessionId: 'old-answer-session' }],
    });
    doubles.call.mockRejectedValueOnce(new Error('answer provider failure'));
    await processGoalAnswers('/project', goal.id, {});
    expect(goal.events![0]).toMatchObject({ processed: false, answer });
    expect(recordManagerRunFailure).toHaveBeenCalledOnce();
    expect(doubles.record).not.toHaveBeenCalled();
    await recoverManagerEvents('/project');
    expect(goal.events).toEqual([expect.objectContaining({ id: 'answer-event', kind: 'answer', questionId: '650e8400-e29b-41d4-a716-446655440001', answer, processed: true, summary: 'saved summary' })]);
    expect(JSON.parse(doubles.call.mock.calls[1]![0])).toMatchObject({ goal: { id: goal.id }, event: { answer } });
    for (const [, options] of doubles.call.mock.calls) {
      expect(options.sessionId).toBeUndefined();
      expect(options.permissionMode).toBe('readonly');
    }
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
    const { taskName, runSlug, result } = completionEvent();
    const completion = { taskName, runSlug, result };
    await processGoalCompletions('/project', goal.id, {}, completion);
    expect(doubles.record).toHaveBeenCalledExactlyOnceWith('/project', goal.id, completion);
    expect(doubles.record.mock.invocationCallOrder[0]).toBeLessThan(doubles.call.mock.invocationCallOrder[0]!);
    expect(goal.events![0]!.processed).toBe(true);
  });
  it('leaves the saved result recoverable without invoking a manager when event publication fails', async () => {
    const { taskName, runSlug, result } = completionEvent();
    doubles.record.mockRejectedValue(new Error('event write failed'));
    await expect(processGoalCompletions('/project', goal.id, {}, { taskName, runSlug, result })).resolves.toBeUndefined();
    expect(doubles.call).not.toHaveBeenCalled();
    expect(goal.events![0]!.processed).toBe(false);
  });
  it('preserves a processed result when startup diagnostics themselves cannot be saved', async () => {
    doubles.ensure.mockRejectedValue(new Error('startup state write failed'));
    await expect(processGoalCompletions('/project', goal.id)).resolves.toBeUndefined();
    expect(goal.events![0]!.processed).toBe(true);
    expect(completionEvent().result.success).toBe(true);
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
  it('rebuilds saved context with a fresh session on every turn across a provider switch', async () => {
    await processGoalCompletions('/project', goal.id);
    expect(goal.events?.[0]).toMatchObject({ processed: true, summary: 'saved summary', result: { sha: 'original-sha' } });
    expect(doubles.call.mock.calls[0]![1]).toMatchObject({ sessionId: undefined, permissionMode: 'readonly', allowedTools: ['Read', 'mcp__manager__enqueue'], mcpOnlySideEffects: ['Read', 'mcp__manager__enqueue'] });
    goal.events!.push(Object.assign({ ...goal.events![0]!, taskName: 'task-b', runSlug: 'run-b', processed: false }, { id: 'event-b' }));
    goal.workUnits = [{ taskName: 'task-b', purpose: 'saved purpose' }];
    provider = 'claude';
    doubles.call.mockResolvedValueOnce({ status: 'done', structuredOutput: { message: 'other provider', summary: null }, sessionId: 'claude-session' });
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBeUndefined();
    goal.events!.push(Object.assign({ ...goal.events![0]!, taskName: 'task-c', runSlug: 'run-c', processed: false }, { id: 'event-c' }));
    provider = 'mock';
    doubles.call.mockResolvedValueOnce({ status: 'done', structuredOutput: { message: 'resumed', summary: null } });
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call.mock.calls[2]![1].sessionId).toBeUndefined();
    expect(JSON.parse(doubles.call.mock.calls[2]![0] as string).goal.workUnits).toEqual(goal.workUnits);
    expect(Reflect.get(goal, 'sessions')).toBeUndefined();
  });
  it('does not reuse a returned session for a second pending event in the same processing call', async () => {
    goal.events!.push(Object.assign({ ...goal.events![0]!, taskName: 'task-b', runSlug: 'run-b' }, { id: 'event-b' }));
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(2);
    expect(goal.events!.every((event) => event.processed)).toBe(true);
    for (const [, options] of doubles.call.mock.calls) expect(options.sessionId).toBeUndefined();
  });
  it('passes saved purpose, exclusions, criteria, work SHA and pending questions to the provider', async () => {
    goal.workUnits = [{ taskName: 'task-a', purpose: 'verify output', integration: {
      sourceBranch: 'task/a', expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40),
      status: 'merged', recordedAt: '2026-10-08T00:00:00Z',
    } }];
    goal.questions = [{ id: '650e8400-e29b-41d4-a716-446655440001', body: 'Which format?', status: 'pending', recipient: 'human' }];
    await processGoalCompletions('/project', goal.id);
    const input = JSON.parse(doubles.call.mock.calls[0]![0]);
    expect(input).toMatchObject({ goal: {
      id: goal.id, objective: goal.objective, outOfScope: goal.outOfScope,
      acceptanceCriteria: goal.acceptanceCriteria, acceptanceCriteriaVersion: 1, workUnits: goal.workUnits, questions: goal.questions,
    }, event: { taskName: 'task-a', runSlug: 'run-a' } });
  });
  it.each(['日本語', '"\\\n'] as const)('bounds valid JSON input to 64 KiB for a single long %s field', async (text) => {
    goal.objective = text.repeat(30000);
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledOnce();
    const prompt = doubles.call.mock.calls[0]![0] as string;
    expect(() => JSON.parse(prompt)).not.toThrow();
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(prompt)).toMatchObject({ goal: { id: goal.id }, event: { runSlug: 'run-a' } });
  });
  it.each([1000, 1])('bounds accumulated history with %i decisions while retaining decision counts, the latest decision and the current event', async (decisionCount) => {
    goal.events = [...Array.from({ length: 1000 }, (_, index) => ({
      id: `old-event-${index}`, kind: 'completion' as const, taskName: `old-${index}`, runSlug: `old-run-${index}`, processed: true,
      result: { success: true, interrupted: false }, summary: 'old summary'.repeat(100),
    })), goal.events![0]!];
    const decisions: NonNullable<Goal['decisions']> = Array.from({ length: 1000 }, (_, index) => ({
      id: `old-decision-${index}`, eventId: `old-event-${index}`, operation: 'integrate',
      reason: 'old reason'.repeat(100), evidenceRefs: [`old-run-${index}/reports/test.md`],
      recordedAt: '2026-10-08T00:00:00Z', actor: 'manager', acceptanceCriteriaVersion: 1,
    }));
    const savedDecisions = decisions.slice(-decisionCount);
    goal.decisions = savedDecisions;
    await processGoalCompletions('/project', goal.id);
    const prompt = doubles.call.mock.calls[0]![0] as string;
    const input = JSON.parse(prompt) as {
      goal: { decisions: NonNullable<Goal['decisions']> };
      omissions: { decisions: { total: number; omitted: number } };
    };
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(input).toMatchObject({ goal: { id: goal.id }, event: { runSlug: 'run-a' } });
    expect(input.omissions.decisions.total).toBe(savedDecisions.length);
    expect(input.omissions.decisions.omitted).toBe(savedDecisions.length - input.goal.decisions.length);
    expect(input.goal.decisions).toContainEqual(savedDecisions.at(-1)!);
    if (decisionCount === 1) {
      expect(input.omissions.decisions.omitted).toBe(0);
      expect(input.goal.decisions).toHaveLength(1);
    } else {
      expect(input.omissions.decisions.omitted).toBeGreaterThan(0);
    }
  });
  it('rereads saved decisions before the next event on the same goal', async () => {
    goal.events!.push(Object.assign({ ...goal.events![0]!, taskName: 'task-b', runSlug: 'run-b' }, { id: 'event-b' }));
    const decision = { id: '550e8400-e29b-41d4-a716-446655440001', eventId: 'event-a',
      operation: 'notify', reason: 'validation passed', evidenceRefs: ['run-a/reports/test.md'],
      recordedAt: '2026-10-08T00:00:00Z', actor: 'manager', acceptanceCriteriaVersion: 1 };
    doubles.call.mockImplementationOnce(async () => {
      Object.assign(goal, { decisions: [decision] });
      return { status: 'done', structuredOutput: { message: 'first event', summary: null }, sessionId: 'returned-session' };
    });
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(2);
    const input = JSON.parse(doubles.call.mock.calls[1]![0]);
    expect(input.goal.decisions).toContainEqual(decision);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBeUndefined();
  });

  it('includes saved operation names and results when retrying the same event with a fresh session', async () => {
    const operation = { id: 'operation-a', eventId: 'event-a', operationName: 'notify:progress',
      status: 'completed', result: { notificationId: '650e8400-e29b-41d4-a716-446655440001' } };
    doubles.call.mockImplementationOnce(async () => {
      Object.assign(goal, { operations: [operation] });
      throw new Error('provider failed after notification');
    });
    await processGoalCompletions('/project', goal.id);
    await processGoalCompletions('/project', goal.id);
    expect(doubles.call).toHaveBeenCalledTimes(2);
    expect(JSON.parse(doubles.call.mock.calls[1]![0]).goal.operations).toContainEqual(operation);
    expect(doubles.call.mock.calls[1]![1].sessionId).toBeUndefined();
    expect(goal.events![0]!.processed).toBe(true);
  });
  it.each(['completion', 'answer', 'recovery'] as const)('preserves an aborted goal event without invoking the manager through %s', async (entry) => {
    Object.assign(goal, { executionStatus: 'aborted' });
    if (entry === 'completion') {
      const { taskName, runSlug, result } = completionEvent();
      await processGoalCompletions('/project', goal.id, {}, { taskName, runSlug, result });
      expect(doubles.record).toHaveBeenCalledOnce();
    } else if (entry === 'answer') {
      Object.assign(goal, { events: [{ id: 'answer-event', kind: 'answer', questionId: '650e8400-e29b-41d4-a716-446655440001', processed: false,
        answer: { text: 'JSON', source: 'tui', answeredAt: '2026-10-08T00:00:00Z' } }] });
      await processGoalAnswers('/project', goal.id, {});
      expect(goal.events![0]!.processed).toBe(false);
    } else await recoverManagerEvents('/project');
    expect(doubles.call).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
    if (entry !== 'answer') expect(goal.events![0]!.processed).toBe(false);
  });
  it.each(['provider', 'prepared cleanup'] as const)('keeps a failed event pending after %s failure and still judges saved work for launch', async (failure) => {
    if (failure === 'provider') doubles.call.mockRejectedValue(new Error('provider failed after enqueue'));
    else doubles.dispose.mockRejectedValue(new Error('cleanup failed'));
    await processGoalCompletions('/project', goal.id);
    expect(goal.events![0]!.processed).toBe(false);
    expect(completionEvent().result.sha).toBe('original-sha');
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
      Object.assign(goal, { events: [{ id: 'orphan-event', kind: 'completion' as const, taskName: 'orphan', runSlug: 'orphan-run',
        processed: false, result: { success: false, interrupted: true } }] });
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
