import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { makeStep } from './test-helpers.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), enqueue: vi.fn(), validate: vi.fn(), list: vi.fn(), ensure: vi.fn() }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }),
  sendSavedGoalNotifications: vi.fn(),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../infra/goals/turn-lock.js', () => ({ withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action() }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: vi.fn() }));
vi.mock('../infra/task/enqueueService.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/task/enqueueService.js')>(), enqueueTask: doubles.enqueue }));
vi.mock('../features/mcp/goalWorkflowValidation.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../features/mcp/goalWorkflowValidation.js')>(), validateGoalWorkflow: doubles.validate }));
vi.mock('../infra/config/index.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../infra/config/index.js')>(), listWorkflows: doubles.list }));
import { GoalWorkflowNotAllowedError } from '../features/mcp/goalWorkflowValidation.js';
import { enqueueTaktGoalTask, listTaktWorkflows } from '../features/mcp/goalOperations.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { TaskState } from '../infra/task/types.js';

let goal: Goal;
const input = { cwd: '/project', goalId: goalRecord().id, purpose: '検証を追加する', task: 'self-contained task', workflow: 'safe' };
const safeWorkflow: WorkflowConfig = { name: 'safe', description: 'safe description', steps: [makeStep({ name: 'work' })], initialStep: 'work', maxSteps: 4 };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => goal);
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); return goal; });
  doubles.enqueue.mockResolvedValue({ taskName: 'actual-name-2' });
});
afterEach(() => vi.restoreAllMocks());
it('recovers a published task with its original workflow result after goal publication fails', async () => {
  goal.events = [{ id: 'event-a', kind: 'completion', taskName: 'trigger', runSlug: 'run-a', result: { success: true, interrupted: false }, processed: false }];
  const deps = { goalEventContext: { goalId: goal.id, eventId: 'event-a' } };
  const tasks: TaskState[] = [];
  vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockImplementation(() => tasks);
  doubles.enqueue.mockImplementation(async (request) => {
    tasks.push({ name: 'actual-name-2', goalId: goal.id, goalOperationId: request.goalOperationId,
      kind: 'pending', status: 'pending', createdAt: '2026-10-08T00:00:00Z', filePath: '/project/.takt/tasks.yaml' });
    return { taskName: 'actual-name-2', tasksFile: '/project/.takt/tasks.yaml', workflow: input.workflow };
  });
  const update = doubles.update.getMockImplementation()!;
  doubles.update.mockImplementationOnce(update).mockRejectedValueOnce(new Error('publication failed'));
  const request = { ...input, operationName: 'work:validation' };
  expect((await enqueueTaktGoalTask(request, deps, new AbortController().signal)).isError).toBe(true);
  expect(goal.operations?.[0]?.status).toBe('pending');
  const recovered = await enqueueTaktGoalTask(request, deps, new AbortController().signal);
  expect(recovered.isError).toBeUndefined();
  expect(JSON.parse(recovered.content[0]!.type === 'text' ? recovered.content[0]!.text : '')).toEqual({ taskName: 'actual-name-2', tasksFile: '/project/.takt/tasks.yaml', workflow: 'safe' });
  expect(doubles.enqueue).toHaveBeenCalledOnce();
  expect(goal.workUnits).toEqual([{ taskName: 'actual-name-2', purpose: input.purpose }]);
});
it('exposes persisted goal ownership in task summaries and preserves ordinary task summaries', () => {
  vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockReturnValue([
    { name: 'goal-work', status: 'pending', goalId: goalRecord().id },
    { name: 'ordinary-work', status: 'pending' },
  ] as ReturnType<TaskRunner['listTaskStateItems']>);
  expect(listTaktTasks({ cwd: '/project' }).content).toEqual([{ type: 'text', text: JSON.stringify({ tasks: [
    { name: 'goal-work', goalId: goalRecord().id, status: 'pending' },
    { name: 'ordinary-work', status: 'pending' },
  ] }) }]);
});
it('fixes execution context in the common enqueue and records the name it actually returns', async () => {
  const result = await enqueueTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  expect(doubles.enqueue.mock.calls[0]![0]).toMatchObject({ goalId: goal.id, goalPurpose: input.purpose, taskContext: { baseBranch: goal.branch }, worktree: true, autoPr: false, shouldPublishBranchToOrigin: false });
  expect(goal.workUnits).toEqual([{ taskName: 'actual-name-2', purpose: input.purpose }]);
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
  expect(doubles.enqueue.mock.invocationCallOrder[0]).toBeLessThan(doubles.ensure.mock.invocationCallOrder[0]!);
});
it.each(['missing goal', 'forbidden workflow'] as const)('refuses success after %s fails', async (failure) => {
  if (failure === 'missing goal') doubles.get.mockRejectedValue(new Error('missing'));
  if (failure === 'forbidden workflow') doubles.validate.mockImplementation(() => { throw new Error('forbidden'); });
  expect((await enqueueTaktGoalTask(input, {}, new AbortController().signal)).isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
  expect(goal.workUnits).toBeUndefined();
  expect(doubles.ensure).not.toHaveBeenCalled();
});
it('reads workflow descriptions and refuses an unresolved listed workflow', () => {
  doubles.list.mockReturnValue(['safe']);
  doubles.validate.mockReturnValue(safeWorkflow);
  const result = listTaktWorkflows({ cwd: input.cwd }, {});
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ workflows: [{ name: 'safe', description: 'safe description' }] }) }]);
  doubles.validate.mockImplementation(() => { throw new Error('unresolved workflow'); });
  expect(listTaktWorkflows({ cwd: input.cwd }, {}).isError).toBe(true);
  expect(doubles.enqueue).not.toHaveBeenCalled();
});
it('excludes forbidden workflows and path identifiers from the listed goal candidates', () => {
  doubles.list.mockReturnValue(['safe', 'forbidden', 'work.yaml']);
  doubles.validate.mockImplementation((identifier: string) => {
    if (identifier !== 'safe') throw new GoalWorkflowNotAllowedError('not allowed');
    return safeWorkflow;
  });
  const result = listTaktWorkflows({ cwd: input.cwd }, {});
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '')).toEqual({
    workflows: [{ name: 'safe', description: 'safe description' }],
  });
  expect(doubles.validate.mock.calls).toEqual([
    ['safe', input.cwd], ['forbidden', input.cwd], ['work.yaml', input.cwd],
  ]);
  expect(doubles.enqueue).not.toHaveBeenCalled();
});

it('returns the saved task as a partial success when only goal recording fails', async () => {
  doubles.update.mockRejectedValue(new Error('failed publication'));
  const result = await enqueueTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '')).toMatchObject({
    taskName: 'actual-name-2', taskEnqueued: true, workUnitRecorded: false, workUnitRecordError: expect.any(String),
  });
  expect(doubles.enqueue).toHaveBeenCalledOnce();
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith(input.cwd);
  expect(goal.workUnits).toBeUndefined();
});

const waitingQuestion = {
  id: '650e8400-e29b-41d4-a716-446655440001', body: '出力形式はどれですか',
  status: 'pending' as const, recipient: 'human' as const, dependentWorkKeys: ['export'],
};

it('rejects declared dependent work before saving a task and identifies the unanswered question', async () => {
  goal = Object.assign(goalRecord(), { questions: [waitingQuestion] });
  const request = { ...input, workKey: 'export' };

  const result = await enqueueTaktGoalTask(request, {}, new AbortController().signal);

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(waitingQuestion.id);
  expect(doubles.enqueue).not.toHaveBeenCalled();
  expect(goal.workUnits).toBeUndefined();
  expect(doubles.ensure).not.toHaveBeenCalled();
});

it.each(['documentation', undefined])('allows work key %s when it does not depend on the waiting question', async (workKey) => {
  goal = Object.assign(goalRecord(), { questions: [waitingQuestion] });
  const request = { ...input, ...(workKey === undefined ? {} : { workKey }) };

  const result = await enqueueTaktGoalTask(request, {}, new AbortController().signal);

  expect(result.isError).toBeUndefined();
  expect(doubles.enqueue).toHaveBeenCalledOnce();
  expect(goal.workUnits).toEqual([expect.objectContaining({ taskName: 'actual-name-2' })]);
});

it.each(['answered', 'withdrawn'] as const)('allows previously dependent work once the question is %s', async (status) => {
  goal = Object.assign(goalRecord(), { questions: [{ ...waitingQuestion, status,
    ...(status === 'answered' ? { answer: { text: 'JSON', source: 'tui' as const, answeredAt: '2026-10-08T00:00:00Z' } } : {}),
  }] });
  const request = { ...input, workKey: 'export' };

  const result = await enqueueTaktGoalTask(request, {}, new AbortController().signal);

  expect(result.isError).toBeUndefined();
  expect(doubles.enqueue).toHaveBeenCalledOnce();
  expect(doubles.enqueue.mock.calls[0]![0]).toMatchObject({ goalWorkKey: 'export' });
  expect(goal.workUnits).toEqual([expect.objectContaining({ taskName: 'actual-name-2', workKey: 'export' })]);
});
