import { beforeEach, expect, it, vi } from 'vitest';
import type { Goal, GoalTaskResult } from '../infra/goals/schema.js';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ tasks: vi.fn(), update: vi.fn(), registered: vi.fn(), records: vi.fn(), read: vi.fn(), write: vi.fn(), diagnostic: vi.fn() }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { update = doubles.update; } }));
vi.mock('../infra/goals/registration.js', () => ({ getRegisteredGoal: doubles.registered }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: doubles.diagnostic }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }));
vi.mock('../infra/config/host-state.js', () => ({ hostProjectStateDirectory: () => '/host' }));
vi.mock('../shared/utils/private-file.js', () => ({ readPrivateFileState: doubles.read, writePrivateFile: doubles.write }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusive: (_path: string, action: () => unknown) => action() }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.records() }; } } }));
import { saveGoalCompletionEvidence, markGoalCompletionProcessed } from '../infra/goals/completion-evidence.js';
import { recordGoalCompletion, reconcileGoalTasks } from '../infra/goals/reconcile.js';

let goal: Goal;
let records: TaskRecord[];
let files: Map<string, string>;
const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'original-sha' } };
beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  records = [];
  files = new Map();
  doubles.registered.mockImplementation(async () => goal);
  doubles.records.mockImplementation(() => records);
  doubles.tasks.mockImplementation(() => records.map((record) => ({ name: record.name, goalId: record.goal_id, goalPurpose: record.goal_purpose, runSlug: record.run_slug, completion: record.completion })));
  doubles.read.mockImplementation((path: string) => files.has(path) ? { content: Buffer.from(files.get(path)!) } : { state: { exists: false } });
  doubles.write.mockImplementation((path: string, data: string) => files.set(path, data));
  doubles.update.mockImplementation(async (_id: string, action: (saved: Goal) => Goal) => { goal = action(goal); });
});
function savedTask(name = 'task-a', run = 'run-a', result: GoalTaskResult = completion.result) {
  const task = TaskRecordSchema.parse({ name, run_slug: run, completion: result, goal_id: goal.id, goal_purpose: '検証する',
    status: 'completed', content: 'work', created_at: '2026-10-06T00:00:00Z', started_at: '2026-10-06T00:00:00Z', completed_at: '2026-10-06T00:01:00Z', owner_pid: null });
  records.push(task);
  saveGoalCompletionEvidence('/project', task);
  return task;
}
it('recovers saved work and preserves host processed state across repeated recovery and a next run', async () => {
  const task = savedTask();
  await reconcileGoalTasks('/project', goal.id);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.workUnits).toEqual([{ taskName: 'task-a', purpose: '検証する' }]);
  expect(goal.events).toEqual([{ ...completion, processed: false }]);
  markGoalCompletionProcessed('/project', goal.id, completion, 'saved summary', undefined);
  const next = { ...task, run_slug: 'run-b', completion: { ...completion.result, sha: 'next-sha' } };
  records = [next];
  saveGoalCompletionEvidence('/project', next);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.events!.map(({ runSlug, result, processed }) => [runSlug, result.sha, processed])).toEqual([['run-a', 'original-sha', true], ['run-b', 'next-sha', false]]);
});
it('does not write a goal with no tasks or saved completion events', async () => {
  await reconcileGoalTasks('/project', goal.id);
  expect(doubles.update).not.toHaveBeenCalled();
});
it('verifies captured completions and preserves host summaries on repeated direct notification', async () => {
  savedTask();
  await recordGoalCompletion('/project', goal.id, completion);
  markGoalCompletionProcessed('/project', goal.id, completion, 'saved summary', undefined);
  await recordGoalCompletion('/project', goal.id, completion);
  savedTask('task-b');
  await recordGoalCompletion('/project', goal.id, { ...completion, taskName: 'task-b' });
  expect(goal.events).toEqual([
    { ...completion, processed: true, summary: 'saved summary' },
    { ...completion, taskName: 'task-b', processed: false },
  ]);
  expect(doubles.tasks).not.toHaveBeenCalled();
});
it.each(['direct', 'recovery', 'old run'] as const)('replaces invalid duplicates with one host event: %s', async (entry) => {
  savedTask();
  goal.events = [0, 1].map(() => ({ ...completion, result: { ...completion.result, sha: 'forged-sha' }, processed: true, summary: 'forged summary' }));
  if (entry === 'old run') records = records.map((record) => ({ ...record, status: 'pending', run_slug: undefined, completion: undefined }));
  if (entry === 'direct') await recordGoalCompletion('/project', goal.id, completion);
  else await reconcileGoalTasks('/project', goal.id);
  expect(goal.events).toEqual([{ ...completion, processed: false }]);
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.events).toHaveLength(1);
});
it.each(['missing evidence', 'missing task', 'modified task'] as const)('retains rejected records for diagnosis without creating evidence: %s', async (change) => {
  savedTask();
  goal.events = [{ ...completion, processed: false }];
  if (change === 'missing evidence') files.clear();
  if (change === 'missing task') records = [];
  if (change === 'modified task') records = records.map((record) => ({ ...record, completion: { ...completion.result, sha: 'forged-sha' } }));
  const writes = doubles.write.mock.calls.length;
  await reconcileGoalTasks('/project', goal.id);
  expect(goal.events).toEqual([{ ...completion, processed: false }]);
  expect(doubles.diagnostic).toHaveBeenCalled();
  expect(doubles.write).toHaveBeenCalledTimes(writes);
  await expect(recordGoalCompletion('/project', goal.id, completion)).rejects.toThrow();
});
