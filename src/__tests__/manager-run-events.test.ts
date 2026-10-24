import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import type { SavedManagerEvent } from '../infra/goals/events.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(), remove: vi.fn(), get: vi.fn(), update: vi.fn(),
  plan: vi.fn(), connect: vi.fn(), dispose: vi.fn(), preflight: vi.fn(),
  turn: vi.fn(), createExecutor: vi.fn(), notify: vi.fn(),
}));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: doubles.read, deleteManagerEvent: doubles.remove }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', () => ({ connectManagerMcp: doubles.connect }));
vi.mock('../features/manager/turnResponse.js', () => ({ getManagerOutputSchema: () => ({ type: 'object' }) }));
vi.mock('../features/manager/turnExecutor.js', () => ({ createManagerTurnExecutor: doubles.createExecutor }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.notify }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({ patrolInterval: 1800 }) }));

let inbox: SavedManagerEvent[];
let goal: Goal;
function saved(taskName: string): SavedManagerEvent {
  return { filePath: `/inbox/${taskName}.json`, event: {
    kind: 'completion', goalId: goalRecord().id, createdAt: '2026-10-14T00:00:00Z',
    taskName, runSlug: `run-${taskName}`, result: { success: true, interrupted: false },
  } };
}
beforeEach(() => {
  vi.resetAllMocks();
  inbox = []; goal = goalRecord();
  doubles.read.mockImplementation(() => [...inbox]);
  doubles.remove.mockImplementation((event: SavedManagerEvent) => { inbox = inbox.filter((item) => item !== event); });
  doubles.get.mockImplementation(async () => goal);
  doubles.update.mockImplementation(async (_id: string, transform: (value: Goal) => Goal) => { goal = transform(goal); return goal; });
  doubles.plan.mockReturnValue({ ctx: { provider: { preflight: doubles.preflight }, providerType: 'mock', model: undefined, lang: 'ja' }, strategy: { systemPrompt: 'manager fixture' } });
  doubles.connect.mockResolvedValue({ servers: {}, dispose: doubles.dispose });
  doubles.createExecutor.mockReturnValue({ execute: async (input: { prompt: string; abortSignal: AbortSignal; goal: unknown }) => {
    const result = await doubles.turn({ text: input.prompt, abortSignal: input.abortSignal, goal: input.goal });
    if (result.kind === 'error') throw new Error(result.message);
    return { message: result.message, summary: null, sessionId: undefined };
  } });
  doubles.turn.mockResolvedValue({ kind: 'reply', message: 'task-X を取り込み、task-Y を投入しました' });
});
afterEach(() => vi.useRealTimers());

function patrol(filePath = '/inbox/patrol.json'): SavedManagerEvent {
  return { filePath, event: { kind: 'patrol', goalId: goal.id, createdAt: new Date().toISOString() } };
}

it.each(['claude', 'claude-sdk', 'codex', 'opencode', 'mock'] as const)('exposes goal execution only when the %s event manager has a permission judge', async (providerType) => {
  const usesJudge = providerType === 'claude' || providerType === 'claude-sdk' || providerType === 'codex';
  doubles.plan.mockReturnValueOnce({
    ctx: { provider: { preflight: doubles.preflight }, providerType, lang: 'ja' },
    strategy: { systemPrompt: 'manager fixture' },
    ...(usesJudge ? { permissionJudge: { language: 'ja', systemPrompt: 'judge fixture',
      managerPersona: 'manager fixture', managerPolicy: 'policy fixture',
      resolution: { provider: providerType, model: undefined, providerOptions: {} } } } : {}),
  });
  inbox = [saved('task-a')];
  const manager = createRunEventManager('/project');
  try {
    expect(await manager.processPending(new AbortController().signal, 1)).toBe(true);
    expect(doubles.connect.mock.calls[0]?.[3]?.enableGoalExecutionTools === true).toBe(usesJudge);
    expect(doubles.turn).toHaveBeenCalledOnce();
  } finally { await manager.close(); }
});

it('passes the event goal identity, repository and constraints separately from conversation text', async () => {
  goal = { ...goal, constraints: ['外部への送信は禁止'] };
  inbox = [saved('task-a')];
  const manager = createRunEventManager('/project');
  const signal = new AbortController().signal;
  try {
    expect(await manager.processPending(signal, 1)).toBe(true);
    expect(doubles.turn).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      goal: { id: goal.id, repositoryDirectory: '/project', constraints: goal.constraints },
    }));
    expect(JSON.parse(doubles.turn.mock.calls[0]![0].text).event.taskName).toBe('task-a');
  } finally { await manager.close(); }
});

it('transfers user MCP servers to connection setup and the merged servers to preflight and session', async () => {
  const userServers = { browser: { command: '/browser-mcp' } };
  const servers = { ...userServers, manager: { command: 'node' } };
  const providerOptions = { codex: { networkAccess: true } };
  doubles.plan.mockReturnValueOnce({
    ctx: { provider: { preflight: doubles.preflight }, providerType: 'mock', lang: 'ja', mcpServers: userServers, providerOptions },
    strategy: { systemPrompt: 'manager fixture' },
  });
  doubles.connect.mockResolvedValueOnce({ servers, dispose: doubles.dispose });
  inbox = [saved('task-a')];
  const manager = createRunEventManager('/project');
  const signal = new AbortController().signal;
  try {
    await expect(manager.processPending(signal, 10)).resolves.toBe(true);
    expect(doubles.connect).toHaveBeenCalledOnce();
    expect(doubles.connect.mock.calls[0]?.slice(0, 3)).toEqual(['/project', undefined, userServers]);
    expect(doubles.preflight).toHaveBeenCalledExactlyOnceWith({
      cwd: '/project', abortSignal: expect.any(AbortSignal), model: undefined, providerOptions,
      permissionMode: 'full', mcpServers: servers, outputSchema: { type: 'object' },
    });
    expect(doubles.createExecutor).toHaveBeenCalledWith('/project', expect.objectContaining({
      ctx: expect.objectContaining({ mcpServers: servers, providerOptions }),
    }));
  } finally { await manager.close(); }
});

it('saves patrol completion without treating its record as progress and discards delayed duplicates', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  goal = { ...goal, createdAt: '2026-10-14T00:00:00Z' };
  const first = patrol(); const duplicate = patrol('/inbox/duplicate.json');
  inbox = [first];
  const manager = createRunEventManager('/project');
  doubles.turn.mockImplementationOnce(async () => {
    vi.setSystemTime('2026-10-14T01:05:00Z');
    return { kind: 'reply', message: '点検を終えました' };
  });
  await manager.processPending(new AbortController().signal, 10);
  expect(goal.lastPatrolCompletedAt).toBe('2026-10-14T01:05:00.000Z');
  expect(goal.workLog).toEqual([expect.objectContaining({ kind: 'patrol' })]);
  const context = JSON.parse(doubles.turn.mock.calls[0]![0].text);
  expect(context.patrol.lastProgressAt).toBe(goal.createdAt);
  vi.setSystemTime('2026-10-14T02:00:00Z');
  inbox = [duplicate];
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([]); expect(doubles.turn).toHaveBeenCalledOnce();
  inbox = [patrol()];
  await manager.processPending(new AbortController().signal, 10);
  expect(JSON.parse(doubles.turn.mock.calls[1]![0].text).patrol.lastProgressAt).toBe(goal.createdAt);
  await manager.close();
});

it.each(['paused', 'aborted', 'completed', 'recent'] as const)('discards a %s patrol without a manager turn or retrying failures', async (state) => {
  const failed = saved('task-a'); inbox = [failed];
  doubles.turn.mockResolvedValueOnce({ kind: 'error', message: 'failed' });
  const manager = createRunEventManager('/project');
  await manager.processPending(new AbortController().signal, 10);
  if (state === 'paused' || state === 'aborted') goal = { ...goal, executionStatus: state };
  if (state === 'completed') goal = { ...goal, status: 'completed' };
  if (state === 'recent') goal = { ...goal, lastPatrolCompletedAt: new Date().toISOString() };
  inbox.push(patrol());
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([failed]); expect(doubles.turn).toHaveBeenCalledOnce();
  await manager.close();
});

it('notifies blocked for a failed patrol, removes it and waits for the next interval', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  inbox = [patrol()];
  doubles.turn.mockResolvedValueOnce({ kind: 'error', message: 'patrol failed' });
  const manager = createRunEventManager('/project');
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([]);
  expect(goal.lastPatrolCompletedAt).toBe('2026-10-14T01:00:00.000Z');
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.any(Error));
  inbox = [patrol()];
  await manager.processPending(new AbortController().signal, 10);
  expect(doubles.turn).toHaveBeenCalledOnce();
  vi.setSystemTime('2026-10-14T01:30:00Z'); inbox = [patrol()];
  await manager.processPending(new AbortController().signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(2); expect(inbox).toEqual([]);
  await manager.close();
});

it('retries failed events from the whole project only during patrol and preserves failures for the next patrol', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  const otherGoal = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440002' };
  const first = saved('task-a');
  const second = { ...saved('task-b'), event: { ...saved('task-b').event, goalId: otherGoal.id } };
  inbox = [first, second];
  doubles.get.mockImplementation(async (id: string) => id === otherGoal.id ? otherGoal : goal);
  doubles.turn.mockResolvedValueOnce({ kind: 'error', message: 'first failed' }).mockResolvedValueOnce({ kind: 'error', message: 'second failed' });
  const manager = createRunEventManager('/project'); const signal = new AbortController().signal;
  await manager.processPending(signal, 10); await manager.processPending(signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(2);
  doubles.turn.mockResolvedValueOnce({ kind: 'reply', message: 'first succeeded' }).mockResolvedValueOnce({ kind: 'error', message: 'second still failed' });
  inbox = [patrol(), first, second];
  await manager.processPending(signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(5);
  expect(inbox).toEqual([second]);
  expect(JSON.parse(doubles.turn.mock.calls[4]![0].text).event.kind).toBe('patrol');
  await manager.processPending(signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(5);
  vi.setSystemTime('2026-10-14T01:30:00Z'); inbox.push(patrol());
  await manager.processPending(signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(7); expect(inbox).toEqual([]);
  await manager.close();
});

it('rechecks patrol eligibility after provider startup and retains interrupted patrols', async () => {
  inbox = [patrol()];
  doubles.preflight.mockImplementationOnce(async () => { goal = { ...goal, executionStatus: 'paused' }; });
  const manager = createRunEventManager('/project');
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([]); expect(doubles.turn).not.toHaveBeenCalled();
  goal = { ...goal, executionStatus: 'active' }; inbox = [patrol()];
  const controller = new AbortController();
  doubles.turn.mockImplementationOnce(async () => { controller.abort(); return { kind: 'error', message: 'interrupted' }; });
  await manager.processPending(controller.signal, 10);
  expect(inbox).toHaveLength(1); expect(goal.lastPatrolCompletedAt).toBeUndefined(); expect(doubles.notify).not.toHaveBeenCalled();
  await manager.close();
});

it('includes failed-event retries in the polling limit and retains paused failures until another patrol', async () => {
  const first = saved('task-a'); const second = saved('task-b');
  const pausedGoal = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440002', executionStatus: 'active' as Goal['executionStatus'] };
  const pausedEvent = { ...saved('task-c'), event: { ...saved('task-c').event, goalId: pausedGoal.id } };
  doubles.get.mockImplementation(async (id: string) => id === pausedGoal.id ? pausedGoal : goal);
  doubles.turn.mockResolvedValue({ kind: 'error', message: 'failed' });
  inbox = [pausedEvent, first, second];
  const manager = createRunEventManager('/project'); const signal = new AbortController().signal;
  await manager.processPending(signal, 10);
  pausedGoal.executionStatus = 'paused';
  inbox.push(patrol()); doubles.turn.mockResolvedValue({ kind: 'reply', message: '点検' });
  await manager.processPending(signal, 2);
  expect(doubles.turn).toHaveBeenCalledTimes(5);
  expect(inbox).toEqual([pausedEvent, second]);
  pausedGoal.executionStatus = 'active';
  await manager.processPending(signal, 10);
  expect(doubles.turn).toHaveBeenCalledTimes(5);
  await manager.close();
});
it('awaits each event before starting the next and saves each result in order', async () => {
  inbox = [saved('task-a'), saved('task-b')];
  let finish!: () => void;
  doubles.turn.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ kind: 'reply', message: 'task-a を取り込みました' }); }));
  const manager = createRunEventManager('/project');
  const processing = manager.processPending(new AbortController().signal, 10);
  await vi.waitFor(() => expect(doubles.turn).toHaveBeenCalledOnce());
  expect(inbox).toHaveLength(2);
  finish(); await processing;
  expect(doubles.turn).toHaveBeenCalledTimes(2);
  expect(doubles.turn.mock.calls[0]![0].text).toContain('task-a');
  expect(doubles.turn.mock.calls[1]![0].text).toContain('task-b');
  expect(goal.workLog.map((record) => record.summary)).toEqual(['task-a を取り込みました', 'task-X を取り込み、task-Y を投入しました']);
  expect(inbox).toEqual([]);
  expect(doubles.connect).toHaveBeenCalledOnce();
  expect(doubles.preflight).toHaveBeenCalledOnce();
  expect(doubles.preflight).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'full', mcpServers: {} }));
  await manager.close();
  expect(doubles.dispose).toHaveBeenCalledOnce();
});
it.each(['provider', 'startup', 'memory'] as const)('retains a failed event and emits blocked after %s failure', async (failure) => {
  inbox = [saved('task-a')];
  const error = new Error('injected failure');
  if (failure === 'provider') doubles.turn.mockResolvedValue({ kind: 'error', message: error.message });
  if (failure === 'startup') doubles.preflight.mockRejectedValue(error);
  if (failure === 'memory') doubles.update.mockRejectedValue(error);
  const manager = createRunEventManager('/project');
  await expect(manager.processPending(new AbortController().signal, 10)).resolves.toBe(false);
  expect(inbox).toHaveLength(1); expect(doubles.remove).not.toHaveBeenCalled();
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.any(Error));
  await manager.close(); expect(doubles.dispose).toHaveBeenCalledOnce();
});
it('releases the manager MCP when startup fails and starts a fresh one for the next event', async () => {
  inbox = [saved('task-a'), saved('task-b')];
  doubles.preflight.mockRejectedValueOnce(new Error('startup failed'));
  const manager = createRunEventManager('/project');
  await expect(manager.processPending(new AbortController().signal, 10)).resolves.toBe(true);
  expect(doubles.connect).toHaveBeenCalledTimes(2);
  expect(doubles.dispose).toHaveBeenCalledOnce();
  expect(inbox.map((event) => event.event.kind === 'completion' ? event.event.taskName : event.event.kind)).toEqual(['task-a']);
  await manager.close();
  expect(doubles.dispose).toHaveBeenCalledTimes(2);
});
it('continues other goals and new events while attempting a failed event only once across polling rounds', async () => {
  const failed = saved('task-a');
  const otherGoal = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440002' };
  const next = { ...saved('task-b'), event: { ...saved('task-b').event, goalId: otherGoal.id } };
  const arriving = { ...saved('task-c'), event: { ...saved('task-c').event, goalId: otherGoal.id } };
  inbox = [failed, next];
  doubles.get.mockImplementation(async (id: string) => id === goal.id ? goal : otherGoal);
  doubles.turn.mockResolvedValueOnce({ kind: 'error', message: 'task-a failed' });
  doubles.remove.mockImplementation((event: SavedManagerEvent) => {
    inbox = inbox.filter((item) => item !== event);
    if (event === next) inbox.push(arriving);
  });
  const manager = createRunEventManager('/project');

  await expect(manager.processPending(new AbortController().signal, 10)).resolves.toBe(true);

  expect(inbox).toEqual([failed, arriving]);
  expect(doubles.turn).toHaveBeenCalledTimes(2);
  await expect(manager.processPending(new AbortController().signal, 10)).resolves.toBe(true);
  expect(inbox).toEqual([failed]);
  expect(doubles.turn).toHaveBeenCalledTimes(3);
  for (const [index, name] of ['task-a', 'task-b', 'task-c'].entries()) {
    expect(doubles.turn.mock.calls[index]![0].text).toContain(name);
  }
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.any(Error));
  expect(doubles.remove.mock.calls.map(([event]) => event)).toEqual([next, arriving]);

  await expect(manager.processPending(new AbortController().signal, 10)).resolves.toBe(false);
  expect(inbox).toEqual([failed]);
  expect(doubles.turn).toHaveBeenCalledTimes(3);
  expect(doubles.notify).toHaveBeenCalledOnce();
  await manager.close();
});
it('leaves paused events and does not create a manager for an empty or paused inbox', async () => {
  const manager = createRunEventManager('/project');
  await manager.processPending(new AbortController().signal, 10);
  inbox = [saved('task-a')]; goal = { ...goal, executionStatus: 'paused' };
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toHaveLength(1); expect(doubles.createExecutor).not.toHaveBeenCalled();
  goal = { ...goal, executionStatus: 'aborted' };
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([]); expect(doubles.createExecutor).not.toHaveBeenCalled();
  await manager.close();
});
it('keeps an interrupted event without blocked notification', async () => {
  const controller = new AbortController();
  inbox = [saved('task-a')];
  doubles.turn.mockImplementation(async () => { controller.abort(); return { kind: 'error', message: 'interrupted' }; });
  const manager = createRunEventManager('/project');
  await manager.processPending(controller.signal, 10);
  expect(inbox).toHaveLength(1); expect(doubles.notify).not.toHaveBeenCalled();
  await manager.close();
});

it('limits attempted events per poll, including failures, and continues with the remaining inbox next time', async () => {
  inbox = [saved('task-a'), saved('task-b'), saved('task-c')];
  doubles.turn.mockResolvedValueOnce({ kind: 'error', message: 'failed' });
  const manager = createRunEventManager('/project');
  const signal = new AbortController().signal;
  await expect(manager.processPending(signal, 2)).resolves.toBe(true);
  expect(doubles.turn).toHaveBeenCalledTimes(2);
  expect(inbox.map(({ event }) => event.kind === 'completion' ? event.taskName : event.kind)).toEqual(['task-a', 'task-c']);
  await expect(manager.processPending(signal, 2)).resolves.toBe(true);
  expect(doubles.turn).toHaveBeenCalledTimes(3);
  expect(inbox.map(({ event }) => event.kind === 'completion' ? event.taskName : event.kind)).toEqual(['task-a']);
  expect(doubles.notify).toHaveBeenCalledOnce();
  await manager.close();
});

it('does not let paused events consume the processing limit for active goals', async () => {
  const paused = { ...goal, id: '650e8400-e29b-41d4-a716-446655440002', executionStatus: 'paused' as const };
  const first = saved('paused');
  inbox = [{ ...first, event: { ...first.event, goalId: paused.id } }, saved('active')];
  doubles.get.mockImplementation(async (id: string) => id === paused.id ? paused : goal);
  const manager = createRunEventManager('/project');
  await expect(manager.processPending(new AbortController().signal, 1)).resolves.toBe(true);
  expect(doubles.turn).toHaveBeenCalledOnce();
  expect(doubles.turn.mock.calls[0]![0].text).toContain('active');
  expect(inbox).toHaveLength(1);
  await manager.close();
});

it.each(['preflight', 'turn'] as const)('retains a timed-out event during %s, skips ordinary polls and retries it on patrol', async (stage) => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  const event = saved('task-a'); inbox = [event];
  let finish!: () => void;
  let turnSignal!: AbortSignal;
  doubles[stage].mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((resolve) => {
    turnSignal = abortSignal;
    finish = () => resolve({ kind: 'error', message: 'provider interrupted' });
  }));
  const manager = createRunEventManager('/project');
  const signal = new AbortController().signal;
  let settled = false;
  const processing = manager.processPending(signal, 10).then((handled) => { settled = true; return handled; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(turnSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(turnSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(turnSignal.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(doubles.notify).not.toHaveBeenCalled();
    expect(inbox).toEqual([event]);
    finish();
    expect(await processing).toBe(false);
    expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.objectContaining({
      message: expect.stringMatching(/timed out/i),
    }));
    expect(vi.getTimerCount()).toBe(0);
    const attempts = doubles[stage].mock.calls.length;
    await manager.processPending(signal, 10);
    expect(doubles[stage]).toHaveBeenCalledTimes(attempts);
    inbox.push(patrol());
    expect(await manager.processPending(signal, 10)).toBe(true);
    expect(inbox).toEqual([]);
    expect(goal.workLog.map((record) => record.kind)).toEqual([undefined, 'patrol']);
    expect(doubles.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finish(); await processing; await manager.close();
  }
});

it.each(['preflight', 'turn'] as const)('notifies a timed-out patrol during %s and waits for the next patrol interval', async (stage) => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  inbox = [patrol()];
  doubles[stage].mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(new Error('provider interrupted')), { once: true });
  }));
  const manager = createRunEventManager('/project');
  const signal = new AbortController().signal;
  try {
    const processing = manager.processPending(signal, 10);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(await processing).toBe(true);
    expect(inbox).toEqual([]);
    expect(goal.lastPatrolCompletedAt).toBe('2026-10-14T01:30:00.000Z');
    expect(goal.workLog).toEqual([]);
    expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.objectContaining({
      message: expect.stringMatching(/timed out/i),
    }));
    const attempts = doubles[stage].mock.calls.length;
    inbox.push(patrol());
    await manager.processPending(signal, 10);
    expect(doubles[stage]).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    inbox.push(patrol());
    await manager.processPending(signal, 10);
    expect(inbox).toEqual([]);
    expect(doubles.turn).toHaveBeenLastCalledWith(expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(goal.workLog).toEqual([expect.objectContaining({ kind: 'patrol' })]);
    expect(doubles.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await manager.close(); }
});

it.each([
  ['completion', 'preflight'], ['completion', 'turn'], ['patrol', 'preflight'], ['patrol', 'turn'],
] as const)('retains a stopped %s event during %s without reporting a timeout or marking it failed', async (kind, stage) => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  const event = kind === 'patrol' ? patrol() : saved('task-a'); inbox = [event];
  let turnSignal!: AbortSignal;
  doubles[stage].mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
    turnSignal = abortSignal;
    abortSignal.addEventListener('abort', () => reject(new Error('provider stopped')), { once: true });
  }));
  const manager = createRunEventManager('/project');
  const controller = new AbortController();
  try {
    const processing = manager.processPending(controller.signal, 10);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(turnSignal.aborted).toBe(true);
    expect(await processing).toBe(false);
    expect(inbox).toEqual([event]);
    expect(goal.lastPatrolCompletedAt).toBeUndefined();
    expect(doubles.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // A stop must not exclude an ordinary event from subsequent polling.
    expect(await manager.processPending(new AbortController().signal, 10)).toBe(true);
    expect(inbox).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(doubles.notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await manager.close(); }
});

it('shares the timeout across preflight and the message, then gives the next event a fresh deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  const first = saved('task-a'); const second = saved('task-b'); inbox = [first, second];
  let finishPreflight!: () => void;
  let preflightSignal!: AbortSignal;
  doubles.preflight.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise<void>((resolve) => {
    preflightSignal = abortSignal;
    finishPreflight = resolve;
  }));
  const signals: AbortSignal[] = [];
  const finishes: Array<() => void> = [];
  doubles.turn.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((resolve) => {
    signals.push(abortSignal);
    finishes.push(() => resolve(abortSignal.aborted
      ? { kind: 'error', message: 'Conversation interrupted' }
      : { kind: 'reply', message: '処理完了' }));
  }));
  const manager = createRunEventManager('/project');
  const processing = manager.processPending(new AbortController().signal, 2);
  try {
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    finishPreflight();
    await vi.advanceTimersByTimeAsync(0);
    expect(preflightSignal.aborted).toBe(false);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(signals[0]!.aborted).toBe(true);
    expect(preflightSignal.aborted).toBe(true);
    finishes[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(signals[1]!.aborted).toBe(false);
    finishes[1]!();
    expect(await processing).toBe(true);
    expect(inbox).toEqual([first]);
    expect(goal.workLog).toEqual([expect.objectContaining({ summary: '処理完了' })]);
    expect(doubles.notify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finishPreflight();
    for (const finish of finishes) finish();
    await processing; await manager.close();
  }
});
