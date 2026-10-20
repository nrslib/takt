import { beforeEach,expect,it,vi } from 'vitest';
import { toTaskInfo } from '../infra/task/mapper.js';
import { TaskRecordSchema,TasksFileSchema,type TasksFileData } from '../infra/task/schema.js';
import type { TaskStore } from '../infra/task/store.js';
import { TaskExceedService } from '../infra/task/taskExceedService.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import type { TaskState } from '../infra/task/types.js';
import { goalId,goalRecord } from './helpers/goal-fixtures.js';
const goals = vi.hoisted(() => ({ get: vi.fn(), stale: vi.fn(), retryMetadata: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = goals.get; } }));
vi.mock('../infra/task/process.js', () => ({ isStaleRunningTask: goals.stale }));
vi.mock('../core/workflow/run/retry-metadata.js', () => ({ readRetryMetadataByRunSlug: goals.retryMetadata }));
let state: TasksFileData;
const save = vi.fn();
const store = { update: (action: (saved: TasksFileData) => TasksFileData | undefined) => {
  const next = action(state);
  if (next !== undefined) {
    state = TasksFileSchema.parse(next);
    save();
  }
  return state;
} } as unknown as TaskStore;
beforeEach(() => {
  vi.resetAllMocks();
  goals.get.mockReturnValue(goalRecord());
  goals.stale.mockReturnValue(true);
  goals.retryMetadata.mockReturnValue({});
  state = { tasks: [TaskRecordSchema.parse({ name: 'task-a', status: 'running', content: 'Task', goal_id: goalId, created_at: '2026-10-06T00:00:00Z', started_at: '2026-10-06T00:00:00Z', completed_at: null, owner_pid: 10 })] };
});

it.each([
  { selectedGoal: undefined, goalTasksOnly: false, recovered: ['task-a', 'other', 'ordinary'] },
  { selectedGoal: goalId, goalTasksOnly: false, recovered: ['task-a'] },
  { selectedGoal: undefined, goalTasksOnly: true, recovered: ['task-a', 'other'] },
])('notifies only saved stale tasks in the selected scope: $selectedGoal / $goalTasksOnly', ({ selectedGoal, goalTasksOnly, recovered }) => {
  const running = state.tasks[0]!;
  const old = { ...running, name: 'old', status: 'failed' as const, owner_pid: null,
    completed_at: '2026-10-06T00:01:00Z', failure: { error: 'previous failure' } };
  state.tasks.push(
    { ...running, name: 'other', goal_id: '650e8400-e29b-41d4-a716-446655440001' },
    { ...running, name: 'ordinary', goal_id: undefined },
    { ...running, name: 'live', owner_pid: 20 }, old,
  );
  goals.stale.mockImplementation((pid: number) => pid !== 20);
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store, undefined, goalTasksOnly);
  const observed: TaskState[] = [];
  const onRecovered = (task: TaskState) => {
    expect(state.tasks.find(({ name }) => name === task.name)?.status).toBe('failed');
    observed.push(task);
  };

  expect(lifecycle.failInterruptedRunningTasks(selectedGoal, onRecovered)).toBe(recovered.length);
  expect(save).toHaveBeenCalledOnce();

  expect(observed.map(({ name }) => name)).toEqual(recovered);
  for (const task of observed) {
    expect(task).toMatchObject({ status: 'failed', kind: 'failed', filePath: '/project/.takt/tasks.yaml' });
    if (task.goalId !== undefined) expect(task.completion).toMatchObject({ success: false, interrupted: true });
  }
  expect(state.tasks.find(({ name }) => name === 'live')?.status).toBe('running');
  expect(state.tasks.find(({ name }) => name === 'old')).toEqual(old);
  expect(lifecycle.failInterruptedRunningTasks(selectedGoal, onRecovered)).toBe(0);
  expect(observed.map(({ name }) => name)).toEqual(recovered);
  expect(save).toHaveBeenCalledOnce();
});

it('notifies only after a successful save and retries a failed save without duplicate notifications', () => {
  let saveFails = true;
  const saveAttempt = vi.fn();
  const publicationStore = { update(action: (saved: TasksFileData) => TasksFileData | undefined) {
    const mutation = action(state);
    if (mutation === undefined) return state;
    const next = TasksFileSchema.parse(mutation);
    saveAttempt();
    if (saveFails) throw new Error('recovery save failed');
    state = next;
    return state;
  } } as unknown as TaskStore;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', publicationStore);
  const onRecovered = vi.fn((_task: TaskState) => expect(state.tasks[0]!.status).toBe('failed'));

  expect(() => lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toThrow('recovery save failed');
  expect(state.tasks[0]!.status).toBe('running');
  expect(onRecovered).not.toHaveBeenCalled();
  saveFails = false;
  expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(1);
  expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'task-a', status: 'failed' }));
  saveFails = true;
  expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(0);
  expect(onRecovered).toHaveBeenCalledOnce();
  expect(saveAttempt).toHaveBeenCalledTimes(2);
});

it.each([false, true])('does not save or notify tasks already recovered by another caller (own task: %s)', (hasOwnTask) => {
  const running = state.tasks[0]!;
  if (hasOwnTask) state.tasks.push({ ...running, name: 'own' });
  const competingStore = { update(action: (saved: TasksFileData) => TasksFileData | undefined) {
    state = { tasks: [{ ...running, status: 'failed', owner_pid: null,
      completed_at: '2026-10-06T00:01:00Z', failure: { error: 'recovered elsewhere' } }, ...state.tasks.slice(1)] };
    return store.update(action);
  } } as unknown as TaskStore;
  const onRecovered = vi.fn();
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', competingStore);

  expect(lifecycle.failInterruptedRunningTasks(undefined, onRecovered)).toBe(hasOwnTask ? 1 : 0);

  expect(save).toHaveBeenCalledTimes(hasOwnTask ? 1 : 0);
  if (hasOwnTask) {
    expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'own', status: 'failed' }));
  } else {
    expect(onRecovered).not.toHaveBeenCalled();
  }
});

it.each(['selected goal', 'goal tasks only'] as const)('skips saving excluded recovery tasks and recovers after changing %s', (scope) => {
  const selectedGoal = scope === 'selected goal' ? '650e8400-e29b-41d4-a716-446655440001' : undefined;
  if (scope === 'goal tasks only') delete state.tasks[0]!.goal_id;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store, undefined, scope === 'goal tasks only');
  const onRecovered = vi.fn();

  expect(lifecycle.failInterruptedRunningTasks(selectedGoal, onRecovered)).toBe(0);

  expect(state.tasks[0]!.status).toBe('running');
  expect(save).not.toHaveBeenCalled();
  expect(onRecovered).not.toHaveBeenCalled();
  const unrestricted = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store, undefined, false);
  expect(unrestricted.failInterruptedRunningTasks(scope === 'selected goal' ? goalId : undefined, onRecovered)).toBe(1);
  expect(save).toHaveBeenCalledOnce();
  expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'task-a', status: 'failed' }));
});

it.each([false, true])('recovers every stale task and retains saved retry metadata when reading throws: %s', (readFails) => {
  const resumePoint = { version: 2 as const,
    stack: [{ workflow: 'default', workflow_ref: 'default', step: 'review', kind: 'agent' as const, occurrence: 1 }],
    iteration: 4, elapsed_ms: 100, workflow_call_invocations: {}, workflow_step_participations: {} };
  state.tasks[0] = { ...state.tasks[0]!, run_slug: 'run-a', start_step: 'review',
    resume_point: resumePoint, exceeded_current_iteration: 4, exceeded_max_steps: 20 };
  state.tasks.push({ ...state.tasks[0]!, name: 'other', run_slug: 'run-b' });
  goals.retryMetadata.mockImplementation((_cwd: string, slug: string) => {
    if (readFails && slug === 'run-a') throw new Error('metadata read failed');
    return { startStep: 'fix', currentIteration: 5 };
  });
  const warning = vi.fn();
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store, warning);

  expect(lifecycle.failInterruptedRunningTasks()).toBe(2);

  expect(state.tasks[0]).toMatchObject({ status: 'failed', run_slug: 'run-a', owner_pid: null,
    start_step: readFails ? 'review' : 'fix', exceeded_current_iteration: readFails ? 4 : 5,
    completion: { success: false, interrupted: true } });
  expect(state.tasks[0]!.resume_point).toEqual(readFails ? resumePoint : undefined);
  expect(state.tasks[0]!.exceeded_max_steps).toBe(readFails ? 20 : undefined);
  expect(state.tasks[1]).toMatchObject({ status: 'failed', start_step: 'fix', exceeded_current_iteration: 5 });
  expect(warning).toHaveBeenCalledTimes(readFails ? 1 : 0);
  if (readFails) {
    expect(warning.mock.calls[0]![0]).toContain('task-a');
    expect(warning.mock.calls[0]![0]).toContain('metadata read failed');
  }
});

it('keeps retry metadata read errors visible for ordinary terminal failure', () => {
  state.tasks[0]!.run_slug = 'run-a';
  const failure = new Error('metadata read failed');
  goals.retryMetadata.mockImplementation(() => { throw failure; });
  const task = toTaskInfo('/project', '/project/.takt/tasks.yaml', state.tasks[0]!);
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store);

  expect(() => lifecycle.failTask({ task, success: false, response: 'failed', executionLog: [],
    startedAt: task.createdAt, completedAt: '2026-10-06T00:01:00Z' })).toThrow(failure);
  expect(state.tasks[0]!.status).toBe('running');
});

it('keeps unreadable goal candidates pending and warns while claiming ordinary work', () => {
  state.tasks[0] = { ...state.tasks[0]!, status: 'pending', started_at: null, owner_pid: null };
  state.tasks.push({ ...state.tasks[0]!, name: 'ordinary', goal_id: undefined });
  const warning = vi.fn();
  goals.get.mockImplementation(() => { throw new Error('goal is unreadable'); });
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store, warning);
  expect(lifecycle.claimNextTasks(1).map(({ name }) => name)).toEqual(['ordinary']);
  expect(state.tasks.map(({ status }) => status)).toEqual(['pending', 'running']);
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0]![0]).toContain('task-a');
});

it('invalidates only matching pending records and preserves running, terminal and unrelated records', () => {
  const running = state.tasks[0]!;
  const pending = { ...running, name: 'pending', status: 'pending' as const, started_at: null, owner_pid: null };
  const completed = { ...running, name: 'completed', status: 'completed' as const, owner_pid: null,
    completed_at: '2026-10-06T00:01:00Z', pr_url: 'https://example.com/pull/1' };
  const other = { ...pending, name: 'other', goal_id: '650e8400-e29b-41d4-a716-446655440001' };
  const ordinary = { ...pending, name: 'ordinary', goal_id: undefined };
  state = { tasks: [running, pending, completed, other, ordinary] };
  const validatedStore = { update(action: (saved: TasksFileData) => TasksFileData) {
    state = TasksFileSchema.parse(action(state)); return state;
  } } as unknown as TaskStore;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', validatedStore);
  lifecycle.invalidatePendingGoalTasks(goalId);
  expect(state.tasks).toEqual([running, expect.objectContaining({ name: 'pending', status: 'failed', started_at: null, completed_at: null,
    failure: { error: expect.stringContaining(goalId), retryable: false } }), completed, other, ordinary]);
  const saved = structuredClone(state);
  lifecycle.invalidatePendingGoalTasks(goalId);
  expect(state).toEqual(saved);
});
it('does not return a claim or persist running state when task publication fails and permits retry', () => {
  state.tasks[0]!.status = 'pending';
  let fail = true;
  const publicationStore = { update(action: (saved: TasksFileData) => TasksFileData) {
    const next = action(state);
    if (fail) throw new Error('claim save failed');
    state = next;
    return state;
  } } as unknown as TaskStore;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', publicationStore);
  expect(() => lifecycle.claimNextTasks(1)).toThrow();
  expect(state.tasks[0]!.status).toBe('pending');
  fail = false;
  expect(lifecycle.claimNextTasks(1).map(({ name }) => name)).toEqual(['task-a']);
  expect(state.tasks[0]!.status).toBe('running');
});
it('saves a recoverable interrupted completion when the process died before publishing a result', () => {
  expect(new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store).failInterruptedRunningTasks()).toBe(1);
  expect(state.tasks[0]).toMatchObject({ status: 'failed', owner_pid: null, run_slug: expect.stringMatching(/^setup-/), completion: { success: false, interrupted: true, workflowResult: 'error', shaUnavailableReason: expect.any(String) } });
  expect(state.tasks[0]!.completion!.sha).toBeUndefined();
  new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store).failInterruptedRunningTasks();
});
it('publishes terminal status and completion in one task-store update and preserves the actual run identifier', () => {
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store);
  const task = lifecycle.updateRunningTaskExecution('task-a', { runSlug: 'run-actual' });
  const completion = { success: true, interrupted: false, sha: 'post-execution-sha' };
  lifecycle.completeTask({ task, completion, success: true, response: 'Done', executionLog: [], startedAt: '2026-10-06T00:00:00Z', completedAt: '2026-10-06T00:01:00Z' });
  expect(state.tasks[0]).toMatchObject({ status: 'completed', run_slug: 'run-actual', completion });
});
it.each([undefined, 'setup-original'])('saves the selected run ID and failed completion atomically after running persistence fails: %s', (previous) => {
  state.tasks[0]!.run_slug = previous;
  const selected = previous === undefined ? 'setup-selected' : 'run-actual';
  const task = { ...toTaskInfo('/project', '/project/.takt/tasks.yaml', state.tasks[0]!), runSlug: selected };
  const completion = { success: false, interrupted: false, workflowResult: 'error' as const, failureReason: 'running save failed' };
  let updates = 0;
  const recordingStore = { update(action: (saved: TasksFileData) => TasksFileData) { updates++; state = action(state); return state; } } as unknown as TaskStore;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', recordingStore);
  lifecycle.failTask({ task, completion, success: false, response: 'running save failed', executionLog: [], startedAt: task.createdAt, completedAt: '2026-10-06T00:01:00Z' });
  expect(updates).toBe(1);
  expect(state.tasks[0]).toMatchObject({ status: 'failed', run_slug: selected, completion });
});
it('does not change task state when terminal persistence fails', () => {
  const task = { ...toTaskInfo('/project', '/project/.takt/tasks.yaml', state.tasks[0]!), runSlug: 'setup-selected' };
  const failingStore = { update() { throw new Error('terminal save failed'); } } as unknown as TaskStore;
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', failingStore);
  expect(() => lifecycle.failTask({ task, completion: { success: false, interrupted: false }, success: false, response: 'failed', executionLog: [], startedAt: task.createdAt, completedAt: '2026-10-06T00:01:00Z' })).toThrow();
  expect(state.tasks[0]!.status).toBe('running');
});
it.each(['ordinary', 'no completion'] as const)('preserves existing run ID handling for %s failures', (condition) => {
  state.tasks[0]!.run_slug = 'existing';
  if (condition === 'ordinary') delete state.tasks[0]!.goal_id;
  const task = { ...toTaskInfo('/project', '/project/.takt/tasks.yaml', state.tasks[0]!), runSlug: 'selected' };
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store);
  lifecycle.failTask({ task, ...(condition === 'ordinary' ? { completion: { success: false, interrupted: false } } : {}), success: false, response: 'failed', executionLog: [], startedAt: task.createdAt, completedAt: '2026-10-06T00:01:00Z' });
  expect(state.tasks[0]).toMatchObject({ status: 'failed', run_slug: 'existing' });
});
it.each(['failed', 'pr_failed', 'exceeded'] as const)('saves %s with its completion and run identifier', (status) => {
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store);
  const task = lifecycle.updateRunningTaskExecution('task-a', { runSlug: 'actual-run' });
  const completion = { success: false, interrupted: false, failureReason: status };
  const result = { task, completion, success: status === 'pr_failed', response: status, executionLog: [], startedAt: task.createdAt, completedAt: '2026-10-06T00:01:00Z' };
  if (status === 'failed') lifecycle.failTask(result);
  if (status === 'pr_failed') lifecycle.prFailTask(result, 'PR failed');
  if (status === 'exceeded') new TaskExceedService(store).exceedTask(task.name, { completion, currentStep: 'work', newMaxSteps: 10, currentIteration: 5 });
  expect(state.tasks[0]).toMatchObject({ status, completion, run_slug: 'actual-run' });
});

it('limits orphan recovery to the selected goal without changing ordinary or other goal tasks', () => {
  const otherId = '650e8400-e29b-41d4-a716-446655440001';
  state.tasks.push({ ...state.tasks[0]!, name: 'other', goal_id: otherId });
  state.tasks.push({ ...state.tasks[0]!, name: 'ordinary', goal_id: undefined });
  const lifecycle = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', store);
  expect(lifecycle.failInterruptedRunningTasks(goalId)).toBe(1);
  expect(state.tasks.map((task) => task.status)).toEqual(['failed', 'running', 'running']);
  expect(lifecycle.failInterruptedRunningTasks(goalId)).toBe(0);
});
