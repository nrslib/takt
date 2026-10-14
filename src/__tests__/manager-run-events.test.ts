import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRunEventManager } from '../features/manager/runEventManager.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import type { SavedManagerEvent } from '../infra/goals/events.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(), remove: vi.fn(), get: vi.fn(), update: vi.fn(),
  plan: vi.fn(), connect: vi.fn(), dispose: vi.fn(), preflight: vi.fn(),
  turn: vi.fn(), close: vi.fn(), createSession: vi.fn(), notify: vi.fn(),
}));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: doubles.read, deleteManagerEvent: doubles.remove }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', () => ({ connectManagerMcp: doubles.connect }));
vi.mock('../features/manager/conversationSession.js', () => ({
  createManagerConversationSession: doubles.createSession, getManagerOutputSchema: () => ({ type: 'object' }),
}));
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
  doubles.plan.mockReturnValue({ ctx: { provider: { preflight: doubles.preflight }, providerType: 'mock', model: undefined, lang: 'ja' }, strategy: { allowedTools: ['Read'] } });
  doubles.connect.mockResolvedValue({ servers: {}, dispose: doubles.dispose });
  doubles.createSession.mockReturnValue({ handleUserMessage: doubles.turn, getPendingSummary: () => null, close: doubles.close });
  doubles.turn.mockResolvedValue({ kind: 'reply', message: 'task-X を取り込み、task-Y を投入しました' });
});
afterEach(() => vi.useRealTimers());

function patrol(filePath = '/inbox/patrol.json'): SavedManagerEvent {
  return { filePath, event: { kind: 'patrol', goalId: goal.id, createdAt: new Date().toISOString() } };
}

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
it('uses one project session and awaits each event before starting the next', async () => {
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
  expect(doubles.createSession).toHaveBeenCalledOnce();
  expect(doubles.preflight).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'readonly', mcpServers: {} }));
  await manager.close();
  expect(doubles.close).toHaveBeenCalledOnce(); expect(doubles.dispose).toHaveBeenCalledOnce();
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
  expect(inbox).toHaveLength(1); expect(doubles.createSession).not.toHaveBeenCalled();
  goal = { ...goal, executionStatus: 'aborted' };
  await manager.processPending(new AbortController().signal, 10);
  expect(inbox).toEqual([]); expect(doubles.createSession).not.toHaveBeenCalled();
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
