import { beforeEach, expect, it, vi } from 'vitest';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), tasks: vi.fn(), diagnostic: vi.fn() }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: doubles.diagnostic }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }));
vi.mock('../infra/config/host-state.js', () => ({ hostProjectStateDirectory: (cwd: string) => `/host${cwd}` }));
vi.mock('../shared/utils/private-file.js', () => ({ readPrivateFileState: doubles.read, writePrivateFile: doubles.write }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusive: (_path: string, action: () => unknown) => action() }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.tasks() }; } } }));
import { saveGoalCompletionEvidence, verifiedGoalCompletionContext, markGoalCompletionProcessed, goalCompletionEvent } from '../infra/goals/completion-evidence.js';
let files: Map<string, string>;
let task: TaskRecord;
const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'saved-sha' } };
beforeEach(() => {
  vi.resetAllMocks();
  files = new Map();
  task = TaskRecordSchema.parse({ name: completion.taskName, run_slug: completion.runSlug, completion: completion.result, goal_id: goalId,
    status: 'completed', content: 'work', created_at: '2026-10-06T00:00:00Z', started_at: '2026-10-06T00:00:00Z', completed_at: '2026-10-06T00:01:00Z', owner_pid: null });
  doubles.tasks.mockImplementation(() => [task]);
  doubles.read.mockImplementation((path: string) => files.has(path) ? { content: Buffer.from(files.get(path)!) } : { state: { exists: false } });
  doubles.write.mockImplementation((path: string, data: string) => files.set(path, data));
});
it('accepts a saved result and retains processed state when the result writer is called again', () => {
  saveGoalCompletionEvidence('/project', task);
  expect(goalCompletionEvent('/project', goalId, completion)).toEqual({ ...completion, processed: false });
  markGoalCompletionProcessed('/project', goalId, completion, 'trusted summary', { provider: 'mock', sessionId: 'session' });
  saveGoalCompletionEvidence('/project', task);
  expect(verifiedGoalCompletionContext('/project', { ...goalRecord(), events: [{ ...completion, processed: false, summary: 'forged summary' }] })).toMatchObject({
    events: [{ ...completion, processed: true, summary: 'trusted summary' }], sessions: [{ provider: 'mock', sessionId: 'session' }],
  });
});
it.each(['missing evidence', 'missing task', 'goal', 'task name', 'run', 'event result', 'task result', 'project'] as const)('rejects %s before producing completion context', (change) => {
  saveGoalCompletionEvidence('/project', task);
  let id = goalId;
  let cwd = '/project';
  let event = structuredClone(completion);
  if (change === 'missing evidence') files.clear();
  if (change === 'missing task') doubles.tasks.mockReturnValue([]);
  if (change === 'goal') id = '650e8400-e29b-41d4-a716-446655440001';
  if (change === 'task name') event = { ...event, taskName: 'other' };
  if (change === 'run') event = { ...event, runSlug: 'other' };
  if (change === 'event result') event.result.sha = 'forged-sha';
  if (change === 'task result') task.completion = { ...event.result, sha: 'forged-sha' };
  if (change === 'project') cwd = '/another';
  expect(() => goalCompletionEvent(cwd, id, event)).toThrow();
  const context = verifiedGoalCompletionContext(cwd, { ...goalRecord(), id, events: [{ ...event, processed: false }] });
  expect(context.events).toEqual(change === 'event result' ? [{ ...completion, processed: false }] : []);
  if (change !== 'event result') expect(doubles.diagnostic).toHaveBeenCalledWith(cwd, expect.any(Error));
});
it('retains the previous run after retry clears its current completion but rejects a renamed run', () => {
  saveGoalCompletionEvidence('/project', task);
  task = { ...task, status: 'pending', run_slug: undefined, completion: undefined };
  expect(goalCompletionEvent('/project', goalId, completion)).toMatchObject({ processed: false, result: completion.result });
  expect(() => goalCompletionEvent('/project', goalId, { ...completion, runSlug: 'new-run' })).toThrow();
  expect(verifiedGoalCompletionContext('/project', { ...goalRecord(), events: [{ ...completion, result: { ...completion.result, sha: 'forged-sha' }, processed: true }] }).events)
    .toEqual([{ ...completion, processed: false }]);
  files.clear();
  expect(verifiedGoalCompletionContext('/project', { ...goalRecord(), events: [{ ...completion, processed: false }] }).events).toEqual([]);
});
it('keeps structured task and run pairs distinct and refuses proof from another pair', () => {
  task = { ...task, name: 'a/b', run_slug: 'c' };
  saveGoalCompletionEvidence('/project', task);
  const other = { ...task, name: 'a', run_slug: 'b/c' };
  doubles.tasks.mockReturnValue([task, other]);
  const second = { ...completion, taskName: 'a', runSlug: 'b/c' };
  expect(() => goalCompletionEvent('/project', goalId, second)).toThrow();
  saveGoalCompletionEvidence('/project', other);
  expect(files.size).toBe(2);
  expect(goalCompletionEvent('/project', goalId, second)).toMatchObject({ taskName: 'a', runSlug: 'b/c' });
});
it('filters an injected event without contaminating the verified prompt history', () => {
  saveGoalCompletionEvidence('/project', task);
  const context = verifiedGoalCompletionContext('/project', { ...goalRecord(), events: [
    { ...completion, processed: true, summary: 'untrusted summary' },
    { ...completion, taskName: 'injected', processed: false, summary: 'injected summary' },
  ] });
  expect(context.events).toEqual([{ ...completion, processed: false }]);
});

it('restores one host event when duplicates contain modified results, summaries and processed flags', () => {
  saveGoalCompletionEvidence('/project', task);
  markGoalCompletionProcessed('/project', goalId, completion, 'saved summary', undefined);
  const event = { ...completion, processed: false };
  expect(verifiedGoalCompletionContext('/project', { ...goalRecord(), events: [
    { ...event, result: { ...event.result, sha: 'forged-sha' }, summary: 'forged summary' }, event,
  ] }).events).toEqual([{ ...completion, processed: true, summary: 'saved summary' }]);
});

it.each(['host', 'project', 'other goal', 'other project', 'invalid event'] as const)('restores sessions only from matching host evidence: %s', (source) => {
  const session = { provider: 'mock', sessionId: 'goal-session' };
  const cwd = source === 'other project' ? '/other' : '/project';
  const id = source === 'other goal' ? '650e8400-e29b-41d4-a716-446655440001' : goalId;
  doubles.tasks.mockReturnValue([{ ...task, goal_id: id }]);
  saveGoalCompletionEvidence(cwd, { ...task, goal_id: id });
  if (source !== 'project') markGoalCompletionProcessed(cwd, id, completion, 'saved summary', session);
  if (source === 'invalid event') doubles.tasks.mockReturnValue([]);
  const context = verifiedGoalCompletionContext('/project', { ...goalRecord(), sessions: [session, { provider: 'claude', sessionId: 'human-session' }], events: [{ ...completion, processed: false }] });
  expect(context.sessions).toEqual(source === 'host' ? [session] : []);
});
