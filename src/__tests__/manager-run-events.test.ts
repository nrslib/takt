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
it('uses one run session and awaits each event before starting the next', async () => {
  inbox = [saved('task-a'), saved('task-b')];
  let finish!: () => void;
  doubles.turn.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ kind: 'reply', message: 'task-a を取り込みました' }); }));
  const manager = createRunEventManager('/project');
  const processing = manager.processPending(new AbortController().signal);
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
  await expect(manager.processPending(new AbortController().signal)).rejects.toThrow();
  expect(inbox).toHaveLength(1); expect(doubles.remove).not.toHaveBeenCalled();
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', goal.id, expect.any(Error));
  await manager.close(); expect(doubles.dispose).toHaveBeenCalledOnce();
});
it('leaves paused events and does not create a manager for an empty or paused inbox', async () => {
  const manager = createRunEventManager('/project');
  await manager.processPending(new AbortController().signal);
  inbox = [saved('task-a')]; goal = { ...goal, executionStatus: 'paused' };
  await manager.processPending(new AbortController().signal);
  expect(inbox).toHaveLength(1); expect(doubles.createSession).not.toHaveBeenCalled();
  goal = { ...goal, executionStatus: 'aborted' };
  await manager.processPending(new AbortController().signal);
  expect(inbox).toEqual([]); expect(doubles.createSession).not.toHaveBeenCalled();
  await manager.close();
});
it('keeps an interrupted event without blocked notification', async () => {
  const controller = new AbortController();
  inbox = [saved('task-a')];
  doubles.turn.mockImplementation(async () => { controller.abort(); return { kind: 'error', message: 'interrupted' }; });
  const manager = createRunEventManager('/project');
  await manager.processPending(controller.signal);
  expect(inbox).toHaveLength(1); expect(doubles.notify).not.toHaveBeenCalled();
  await manager.close();
});
