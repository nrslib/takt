import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import type { TaskListItem, TaskState } from '../infra/task/types.js';
import type { FailedTaskRetryPersistenceOptions } from '../features/tasks/taskRetryPersistence.js';
import { buildTaskRetryStartOptions } from '../features/tasks/list/taskRetryStartSelection.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { makeStep } from './test-helpers.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { recordGoalTaskRetry } from '../infra/goals/taskRetry.js';
import { requeueGoalTaskInputSchema, retryGoalTaskInputSchema } from '../features/mcp/goalTaskRetrySchemas.js';

const doubles = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), states: vi.fn(), tasks: vi.fn(), prepare: vi.fn(),
  context: vi.fn(), persist: vi.fn(), exceeded: vi.fn(), ensure: vi.fn(), allowed: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; } }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../infra/goals/turn-lock.js', () => ({
  withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }),
  sendSavedGoalNotifications: vi.fn(),
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class {
  listTaskStateItems = doubles.states;
  listAllTaskItems = doubles.tasks;
  listFailedTasks = doubles.tasks;
  listExceededTasks = doubles.tasks;
  requeueExceededTask = doubles.exceeded;
} }));
vi.mock('../features/tasks/taskRetryPreparation.js', async (original) => ({
  ...await original<typeof import('../features/tasks/taskRetryPreparation.js')>(),
  prepareFailedTaskRetry: doubles.prepare,
  buildFailedTaskRetryStartContext: doubles.context,
}));
vi.mock('../features/tasks/taskRetryPersistence.js', async (original) => ({
  ...await original<typeof import('../features/tasks/taskRetryPersistence.js')>(),
  persistFailedTaskRetry: doubles.persist,
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(),
  assertCwdAllowedByMcpRoot: doubles.allowed,
}));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(),
  resolveConfigValue: () => 'ja',
}));

import { requeueTaktGoalTask, retryTaktGoalTask } from '../features/mcp/goalTaskRetryOperations.js';

const input = { cwd: '/project', goalId: goalRecord().id, taskName: 'goal-work' };
const workflow = {
  name: 'safe', description: 'fixture', initialStep: 'plan', maxSteps: 10,
  steps: [makeStep({ name: 'plan' }), makeStep({ name: 'review' })],
};
let goal: Goal;
let state: TaskState;
let task: TaskListItem;
let order: string;

function invoke(kind: 'requeue' | 'retry', extra: Record<string, unknown> = {}, event = false) {
  const deps = event ? { goalEventContext: { goalId: goal.id, eventId: 'completion-a' } } : {};
  const signal = new AbortController().signal;
  return kind === 'requeue'
    ? requeueTaktGoalTask({ ...input, ...extra }, deps, signal)
    : retryTaktGoalTask({ ...input, task: 'Revised canonical order', ...extra }, deps, signal);
}

beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), workUnits: [{ taskName: input.taskName, purpose: '検証', workKey: 'validation' }],
    events: [{ id: 'completion-a', kind: 'completion', taskName: input.taskName, runSlug: 'failed-run',
      result: { success: false, interrupted: false }, processed: false }] };
  state = { kind: 'failed', status: 'failed', name: input.taskName, goalId: goal.id,
    createdAt: '2026-10-08T00:00:00Z', filePath: '/project/.takt/tasks.yaml',
    workflow: 'safe', branch: 'takt/goal-work', worktreePath: '/project/clone',
    taskDir: '.takt/tasks/goal-work', runSlug: 'failed-run', failure: { step: 'review', error: 'provider unavailable' } };
  task = { ...state, content: 'Original canonical order', data: {
    task: 'Original canonical order', workflow: 'safe', retry_note: 'Existing note', goal_id: goal.id,
    branch: state.branch, worktree: state.worktreePath,
  } };
  order = task.content;
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(structuredClone(goal));
    return structuredClone(goal);
  });
  doubles.states.mockImplementation(() => [structuredClone(state)]);
  doubles.tasks.mockImplementation(() => [{ ...task, ...state, data: { ...task.data, goal_id: state.goalId } }]);
  doubles.prepare.mockImplementation(() => ({
    worktreePath: state.worktreePath, failure: state.failure, failedStep: 'review',
    matchedRunSlug: 'failed-run', runMeta: null, previousWorkflow: 'safe',
    previousOrderContent: order, resumePoint: undefined,
  }));
  const options = { projectCwd: input.cwd, lookupCwd: '/project/clone', preferredRootStep: 'review' };
  doubles.context.mockReturnValue({ workflowName: 'safe', workflowConfig: workflow,
    workflowOverride: undefined, options, startOptions: buildTaskRetryStartOptions(workflow, options) });
  doubles.persist.mockImplementation((options: FailedTaskRetryPersistenceOptions & { goalOperationId?: string }) => {
    if (options.goalOperationId !== undefined) {
      expect(goal.operations).toContainEqual(expect.objectContaining({ id: options.goalOperationId, status: 'pending' }));
    }
    order = options.revisedOrder?.content ?? order;
    state = { ...state, kind: 'pending', status: 'pending', goalOperationId: options.goalOperationId };
  });
  doubles.exceeded.mockImplementation((_name: string, options?: { goalOperationId?: string }) => {
    if (options?.goalOperationId !== undefined) {
      expect(goal.operations).toContainEqual(expect.objectContaining({ id: options.goalOperationId, status: 'pending' }));
    }
    state = { ...state, kind: 'pending', status: 'pending', goalOperationId: options?.goalOperationId };
  });
});
afterEach(() => vi.restoreAllMocks());

describe('goal task retry validation', () => {
  it.each(['requeue', 'retry'] as const)('rejects %s outside the allowed project before effects', async (kind) => {
    doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });
    expect((await invoke(kind)).isError).toBe(true);
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.persist).not.toHaveBeenCalled();
    expect(doubles.exceeded).not.toHaveBeenCalled();
  });

  describe.each(['requeue', 'retry'] as const)('%s', (kind) => {
    it.each(['another goal', 'ordinary task', 'missing work unit', 'missing task'] as const)(
      'rejects %s without changing the task or canonical order', async (caseName) => {
        if (caseName === 'another goal') state.goalId = '650e8400-e29b-41d4-a716-446655440001';
        if (caseName === 'ordinary task') delete state.goalId;
        if (caseName === 'missing work unit') goal.workUnits = [];
        if (caseName === 'missing task') { doubles.states.mockReturnValue([]); doubles.tasks.mockReturnValue([]); }
        const before = structuredClone(state);
        const result = await invoke(kind);
        expect(result.isError).toBe(true);
        expect(firstTextContent(result.content)).toMatch(caseName === 'missing work unit'
          ? /no work unit/iu : /does not belong.*goal/iu);
        expect(state).toEqual(before);
        expect(order).toBe('Original canonical order');
        expect(doubles.persist).not.toHaveBeenCalled();
        expect(doubles.exceeded).not.toHaveBeenCalled();
      },
    );

    describe.each([false, true])('dependent questions with event context: %s', (event) => {
      const questionId = '650e8400-e29b-41d4-a716-446655440001';
      const extra = event ? { operationName: `${kind}:goal-work` } : {};

      beforeEach(() => {
        goal = GoalSchema.parse({ ...goal, questions: [{
          id: questionId, recipient: 'human', body: '検証の実行条件を確認してください',
          dependentWorkKeys: ['validation'], status: 'pending',
        }] });
      });

      it('returns the pending question reason and ID without changing the task, order or queue', async () => {
        const before = structuredClone(state);

        const result = await invoke(kind, extra, event);

        expect(result.isError).toBe(true);
        const text = firstTextContent(result.content);
        expect(text).toMatch(/waiting.*questions?/iu);
        expect(text).toContain(questionId);
        expect(state).toEqual(before);
        expect(order).toBe('Original canonical order');
        expect(doubles.persist).not.toHaveBeenCalled();
        expect(doubles.exceeded).not.toHaveBeenCalled();
      });

      it('returns the task to pending when the same dependent question is withdrawn', async () => {
        goal = GoalSchema.parse({ ...goal,
          questions: goal.questions!.map((question) => ({ ...question, status: 'withdrawn' })),
        });

        const result = await invoke(kind, extra, event);

        expect(result.isError).toBeUndefined();
        expect(state.status).toBe('pending');
        expect(order).toBe(kind === 'retry' ? 'Revised canonical order' : 'Original canonical order');
      });
    });

    it.each(['pending', 'running', 'completed', 'pr_failed'] as const)('rejects %s tasks before retry effects', async (status) => {
      state = { ...state, kind: status, status };
      const result = await invoke(kind);
      expect(result.isError).toBe(true);
      const text = firstTextContent(result.content);
      expect(text).toMatch(new RegExp(`cannot\\s+${kind}\\b`, 'iu'));
      expect(text).toMatch(new RegExp(`\\b${status}\\b`, 'u'));
      expect(state.status).toBe(status);
      expect(doubles.persist).not.toHaveBeenCalled();
      expect(doubles.exceeded).not.toHaveBeenCalled();
      expect(doubles.ensure).not.toHaveBeenCalled();
    });

    it.each(['paused', 'aborted', 'completed', 'awaiting_merge'] as const)('rejects %s goals before retry effects', async (status) => {
      if (status === 'paused' || status === 'aborted') goal.executionStatus = status;
      else {
        goal.status = status;
        goal.completion = { goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: goal.integrationBranch,
          summary: 'evidence', instructions: [],
          changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
          ...(status === 'completed' ? { targetSha: 'a'.repeat(40) } : {}),
        };
      }
      const before = structuredClone(goal);
      const result = await invoke(kind);
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(status === 'paused' ? /goal.*paused/iu
        : status === 'aborted' ? /goal.*aborted/iu : /cannot accept work/iu);
      expect(goal).toEqual(before);
      expect(doubles.persist).not.toHaveBeenCalled();
      expect(doubles.exceeded).not.toHaveBeenCalled();
      expect(doubles.ensure).not.toHaveBeenCalled();
    });

    it('rejects a different goal event before saving an operation', async () => {
      const deps = { goalEventContext: { goalId: '650e8400-e29b-41d4-a716-446655440001', eventId: 'completion-a' } };
      const signal = new AbortController().signal;
      const eventInput = { ...input, operationName: `${kind}:goal-work` };
      const result = kind === 'requeue' ? await requeueTaktGoalTask(eventInput, deps, signal)
        : await retryTaktGoalTask({ ...eventInput, task: 'Revised canonical order' }, deps, signal);
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/operation.*another goal/iu);
      expect(doubles.update).not.toHaveBeenCalled();
      expect(doubles.persist).not.toHaveBeenCalled();
    });

    it('requires an operation name in an event turn', async () => {
      const result = await invoke(kind, {}, true);
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/require.*operationName/iu);
      expect(doubles.update).not.toHaveBeenCalled();
      expect(doubles.persist).not.toHaveBeenCalled();
    });
  });

  it('does not offer Retry for an exceeded task', async () => {
    state = { ...state, kind: 'exceeded', status: 'exceeded' };
    const result = await invoke('retry');
    expect(result.isError).toBe(true);
    const text = firstTextContent(result.content);
    expect(text).toMatch(/cannot\s+retry\b/iu);
    expect(text).toMatch(/\bexceeded\b/u);
    expect(doubles.persist).not.toHaveBeenCalled();
    expect(doubles.exceeded).not.toHaveBeenCalled();
  });

  it('rejects exceeded work without a saved stopping position before recording or queueing', async () => {
    state = { ...state, kind: 'exceeded', status: 'exceeded' };
    const result = await invoke('requeue');
    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).toMatch(/no saved stopping position/iu);
    expect(state.status).toBe('exceeded');
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.exceeded).not.toHaveBeenCalled();
  });

  it('rejects an unknown retry start step before revising the order', async () => {
    const result = await invoke('retry', { startStep: 'missing' });
    expect(result.isError).toBe(true);
    const text = firstTextContent(result.content);
    expect(text).toMatch(/unknown.*step/iu);
    expect(text).toMatch(/\bmissing\b/u);
    expect(order).toBe('Original canonical order');
    expect(doubles.persist).not.toHaveBeenCalled();
  });

  it('rejects empty revised instructions before preparing or recording work', async () => {
    const result = await invoke('retry', { task: '  ', operationName: 'retry:goal-work' }, true);
    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).toMatch(/task.*required/iu);
    expect(doubles.prepare).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.persist).not.toHaveBeenCalled();
  });
});

describe.each(['failed requeue', 'retry', 'exceeded requeue'] as const)('goal operation recovery: %s', (path) => {
  function request(extra: Record<string, unknown> = {}) {
    if (path === 'exceeded requeue' && state.status === 'failed') {
      state = { ...state, kind: 'exceeded', status: 'exceeded' };
      task = { ...task, data: { ...task.data!, start_step: 'review' } };
    }
    return invoke(path === 'retry' ? 'retry' : 'requeue', { operationName: `${path === 'retry' ? 'retry' : 'requeue'}:goal-work`,
      ...(path === 'retry' ? {} : { retryNote: '容量回復後に再開' }), ...extra }, true);
  }
  function effects() { return path === 'exceeded requeue' ? doubles.exceeded : doubles.persist; }

  async function failGoalPublication() {
    const update = doubles.update.getMockImplementation()!;
    let rejected = false;
    doubles.update.mockImplementation(async (...args) => {
      if (!rejected && state.status === 'pending') { rejected = true; throw new Error('goal publication failed'); }
      return update(...args);
    });
    expect((await request()).isError).toBe(true);
    expect(rejected).toBe(true);
    const pendingOperation = structuredClone(goal.operations![0]!);
    expect(pendingOperation.status).toBe('pending');
    expect(pendingOperation.recovery).toMatchObject({
      result: { taskName: input.taskName, status: 'pending' },
      record: { kind: path === 'retry' ? 'retry' : 'requeue', operationId: pendingOperation.id },
    });
    expect(state).toMatchObject({ status: 'pending', goalOperationId: pendingOperation.id });
    expect(goal.workUnits![0]!.retries).toBeUndefined();
    expect(order).toBe(path === 'retry' ? 'Revised canonical order' : 'Original canonical order');
    expect(effects()).toHaveBeenCalledTimes(1);
    expect(doubles.ensure).toHaveBeenCalledWith(input.cwd);
    return pendingOperation;
  }

  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  function addPendingQuestion() {
    goal = GoalSchema.parse({ ...goal, questions: [{
      id: questionId, recipient: 'human', body: '検証の実行条件を確認してください',
      dependentWorkKeys: ['validation'], status: 'pending',
    }] });
  }

  it('returns the saved result on the same event and operation name without repeating effects', async () => {
    const first = await request();
    expect(first.isError).toBeUndefined();
    const saved = structuredClone(goal);
    expect(await request()).toEqual(first);
    expect(effects()).toHaveBeenCalledTimes(1);
    expect(goal).toEqual(saved);
    expect(goal.operations).toEqual([expect.objectContaining({ status: 'completed', eventId: 'completion-a' })]);
  });

  it('rejects changed arguments under a saved operation name without changing its result', async () => {
    expect((await request()).isError).toBeUndefined();
    const saved = structuredClone(goal);
    const savedTask = structuredClone(state);
    const result = await request(path === 'retry' ? { task: 'Different instructions' } : { retryNote: '別の指示' });
    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).toMatch(/operation name.*different arguments/iu);
    expect(goal).toEqual(saved);
    expect(state).toEqual(savedTask);
    expect(effects()).toHaveBeenCalledTimes(1);
  });

  it('rejects a second operation name once the same task is pending', async () => {
    expect((await request()).isError).toBeUndefined();
    const result = await request({ operationName: 'redo:another' });
    expect(result.isError).toBe(true);
    const text = firstTextContent(result.content);
    expect(text).toMatch(new RegExp(`cannot\\s+${path === 'retry' ? 'retry' : 'requeue'}\\b`, 'iu'));
    expect(text).toMatch(/\bpending\b/u);
    expect(effects()).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('pending');
  });

  it('does not change the task if publishing the operation before its effect fails', async () => {
    doubles.update.mockRejectedValueOnce(new Error('operation publication failed'));
    expect((await request()).isError).toBe(true);
    expect(state.status).toBe(path === 'exceeded requeue' ? 'exceeded' : 'failed');
    expect(order).toBe('Original canonical order');
    expect(effects()).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
  });

  it('recovers only goal recording after the queue effect succeeded and goal publication failed', async () => {
    const pendingOperation = await failGoalPublication();
    expect((await request()).isError).toBeUndefined();
    const saved = structuredClone(goal);
    expect((await request()).isError).toBeUndefined();
    expect(goal).toEqual(saved);
    expect(effects()).toHaveBeenCalledTimes(1);
    expect(goal.operations).toEqual([expect.objectContaining({ id: pendingOperation.id, status: 'completed' })]);
  });

  it('completes saved recovery once when a dependent question is added after queue publication', async () => {
    const pendingOperation = await failGoalPublication();
    addPendingQuestion();
    const savedTask = structuredClone(state);
    const savedOrder = order;

    const result = await request();

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(firstTextContent(result.content))).toEqual(pendingOperation.recovery!.result);
    expect(goal.operations).toEqual([expect.objectContaining({
      id: pendingOperation.id, status: 'completed', result: pendingOperation.recovery!.result,
    })]);
    expect(goal.workUnits![0]!.retries).toEqual([pendingOperation.recovery!.record]);
    expect(state).toEqual(savedTask);
    expect(order).toBe(savedOrder);
    const saved = structuredClone(goal);
    expect(await request()).toEqual(result);
    expect(goal).toEqual(saved);
    expect(state).toEqual(savedTask);
    expect(order).toBe(savedOrder);
    expect(effects()).toHaveBeenCalledTimes(1);
  });

  it('rejects question-blocked recovery when only the task operation ID no longer matches', async () => {
    await failGoalPublication();
    addPendingQuestion();
    state = { ...state, goalOperationId: 'unrelated-operation' };
    const savedTask = structuredClone(state);
    const savedOrder = order;

    const result = await request();

    expect(result.isError).toBe(true);
    const text = firstTextContent(result.content);
    expect(text).toMatch(/waiting.*questions?/iu);
    expect(text).toContain(questionId);
    expect(goal.operations![0]!.status).toBe('failed');
    expect(goal.workUnits![0]!.retries).toBeUndefined();
    expect(state).toEqual(savedTask);
    expect(order).toBe(savedOrder);
    expect(effects()).toHaveBeenCalledTimes(1);
  });

  if (path === 'failed requeue') {
    it('rejects question-blocked recovery when only the saved recovery is missing', async () => {
      await failGoalPublication();
      addPendingQuestion();
      goal = { ...goal, operations: goal.operations!.map(({ recovery: _recovery, ...operation }) => operation) };
      const savedTask = structuredClone(state);
      const savedOrder = order;

      const result = await request();

      expect(result.isError).toBe(true);
      const text = firstTextContent(result.content);
      expect(text).toMatch(/waiting.*questions?/iu);
      expect(text).toContain(questionId);
      expect(goal.operations![0]!.status).toBe('failed');
      expect(goal.workUnits![0]!.retries).toBeUndefined();
      expect(state).toEqual(savedTask);
      expect(order).toBe(savedOrder);
      expect(effects()).toHaveBeenCalledTimes(1);
    });
  }

  it('does not treat another queue operation id as proof that its own effect succeeded', async () => {
    const update = doubles.update.getMockImplementation()!;
    doubles.update.mockImplementation(async (...args) => {
      const saved = await update(...args);
      if (state.status !== 'pending') state = { ...state, kind: 'pending', status: 'pending', goalOperationId: 'unrelated-operation' };
      return saved;
    });
    effects().mockImplementation(() => { throw new Error('task is already pending'); });
    expect((await request()).isError).toBe(true);
    const calls = effects().mock.calls.length;
    expect((await request()).isError).toBe(true);
    expect(goal.operations?.[0]?.status).not.toBe('completed');
    expect(state.goalOperationId).toBe('unrelated-operation');
    expect(effects().mock.calls.length).toBe(calls);
  });
});

describe('goal task retry records and input schemas', () => {
  it('preserves canonical instruction whitespace and rejects empty or oversized instructions', () => {
    expect(retryGoalTaskInputSchema.parse({ ...input, task: '  corrected order\n' }).task).toBe('  corrected order\n');
    for (const task of ['  ', 'x'.repeat(128 * 1024 + 1)]) {
      expect(retryGoalTaskInputSchema.safeParse({ ...input, task }).success).toBe(false);
      expect(requeueGoalTaskInputSchema.safeParse({ ...input, retryNote: task }).success).toBe(false);
    }
    expect(requeueGoalTaskInputSchema.parse(input).retryNote).toBeUndefined();
  });

  it('retains previous integration and purpose, without duplicating the same operation record', () => {
    const original: Goal = { ...goal, workUnits: [{
      taskName: input.taskName, purpose: '検証', workKey: 'validation',
      integration: { sourceBranch: 'takt/goal-work', expectedSha: 'a'.repeat(40),
        goalSha: 'b'.repeat(40), status: 'merged', recordedAt: '2026-10-08T00:00:00Z' },
    }] };
    const record = { kind: 'requeue' as const, recordedAt: '2026-10-11T00:00:00Z', operationId: 'requeue-operation' };
    const saved = GoalSchema.parse(recordGoalTaskRetry(original, input.taskName, record));
    expect(saved.workUnits![0]).toMatchObject({ ...original.workUnits![0], retries: [record] });
    expect(recordGoalTaskRetry(saved, input.taskName, record)).toEqual(saved);
    expect(original.workUnits![0]!.retries).toBeUndefined();
    const next = { kind: 'retry' as const, recordedAt: '2026-10-11T01:00:00Z' };
    expect(recordGoalTaskRetry(saved, input.taskName, next).workUnits![0]!.retries).toEqual([record, next]);
    expect(GoalSchema.parse(original)).toEqual(original);
  });

  it('rejects recording a task missing from the work units', () => {
    expect(() => recordGoalTaskRetry(goal, 'missing', { kind: 'retry', recordedAt: '2026-10-11T00:00:00Z' })).toThrow();
  });
});
