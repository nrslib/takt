import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskStore } from '../infra/task/store.js';
import { toTaskInfo } from '../infra/task/mapper.js';
import { TaskRecordSchema, type TasksFileData } from '../infra/task/schema.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import { TaskExceedService } from '../infra/task/taskExceedService.js';
import { goalId } from './helpers/goal-fixtures.js';
vi.mock('../infra/task/process.js', () => ({ isStaleRunningTask: () => true }));
vi.mock('../core/workflow/run/retry-metadata.js', () => ({ readRetryMetadataByRunSlug: () => ({}) }));
let state: TasksFileData;
const store = { update: (action: (saved: TasksFileData) => TasksFileData) => { state = action(state); return state; } } as unknown as TaskStore;
beforeEach(() => {
  vi.resetAllMocks();
  state = { tasks: [TaskRecordSchema.parse({ name: 'task-a', status: 'running', content: 'Task', goal_id: goalId, created_at: '2026-10-06T00:00:00Z', started_at: '2026-10-06T00:00:00Z', completed_at: null, owner_pid: 10 })] };
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
