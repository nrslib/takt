import { beforeEach, expect, it, vi } from 'vitest';
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
  expect(inbox.map((event) => event.event.taskName)).toEqual(['task-a']);
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
  expect(inbox.map(({ event }) => event.taskName)).toEqual(['task-a', 'task-c']);
  await expect(manager.processPending(signal, 2)).resolves.toBe(true);
  expect(doubles.turn).toHaveBeenCalledTimes(3);
  expect(inbox.map(({ event }) => event.taskName)).toEqual(['task-a']);
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
