import { beforeEach,expect,it,vi } from 'vitest';
import { checkGoalCompletion,completeGoal,integrateGoalTask } from '../infra/goals/integration.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), update: vi.fn(), tasks: vi.fn(), merge: vi.fn(), sha: vi.fn(), included: vi.fn(), worktrees: vi.fn(), diff: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; list = doubles.list; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; } }));
vi.mock('../infra/goals/merge-git.js', () => ({ mergeGoalBranch: doubles.merge, targetWorktrees: doubles.worktrees }));
vi.mock('../infra/goals/git-command.js', () => ({ resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included }));
vi.mock('../infra/goals/diff-summary.js', () => ({ readGoalDiffSummary: doubles.diff, GOAL_DIFF_MAX_FILES: 50 }));
const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks(); goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [goal], errors: [] }));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => { goal = transform(goal); return structuredClone(goal); });
  doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, goalPurpose: '入力を検証する', status: 'completed', branch: 'takt/result', completion: { branch: 'takt/result' } }]);
  doubles.sha.mockResolvedValue(sourceSha); doubles.included.mockResolvedValue(false);
  doubles.merge.mockResolvedValue({ status: 'merged', sha: targetSha }); doubles.worktrees.mockResolvedValue([]);
  doubles.diff.mockResolvedValue({ filesChanged: 1, additions: 2, deletions: 1, files: [], truncated: false, totalsTruncated: false });
});
it('integrates reviewed task work and records it only in the shared work log', async () => {
  expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).toMatchObject({ status: 'merged', sha: targetSha });
  expect(doubles.merge).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, goal.branch, undefined);
  expect(goal.workLog).toEqual([expect.objectContaining({ summary: expect.stringContaining('task') })]);
  expect(goal.notifications).toEqual([expect.objectContaining({ kind: 'progress' })]);
  expect(goal).not.toHaveProperty('workUnits');
});
it('does nothing when Git already contains the reviewed result, including after recording failed', async () => {
  doubles.update.mockRejectedValueOnce(new Error('save failed'));
  await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).rejects.toThrow();
  doubles.included.mockResolvedValue(true);
  expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).toMatchObject({ status: 'merged' });
  expect(doubles.merge).toHaveBeenCalledOnce();
  expect(doubles.update).toHaveBeenCalledOnce();
});
it.each(['changed SHA', 'different goal', 'still running'])('rejects %s before changing Git', async (condition) => {
  if (condition === 'changed SHA') doubles.sha.mockResolvedValue(targetSha);
  else doubles.tasks.mockReturnValue([{ name: 'task', goalId: condition === 'different goal' ? 'other' : goal.id, status: 'running', branch: 'takt/result', completion: { branch: 'takt/result' } }]);
  await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).rejects.toThrow();
  expect(doubles.merge).not.toHaveBeenCalled(); expect(doubles.update).not.toHaveBeenCalled();
});
it.each(['conflict', 'checked_out'] as const)('leaves work unrecorded after a %s merge result', async (status) => {
  doubles.merge.mockResolvedValue({ status, conflicts: ['file'], worktrees: ['/worktree'] });
  expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'en')).toMatchObject({ status });
  expect(doubles.update).not.toHaveBeenCalled();
});
it('waits for the target branch to contain the saved goal SHA before completing', async () => {
  expect(await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy)).toMatchObject({ status: 'awaiting_merge' });
  expect(goal.status).toBe('awaiting_merge'); expect(doubles.merge).not.toHaveBeenCalled();
  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included: false });
  doubles.included.mockResolvedValue(true); doubles.sha.mockResolvedValue(targetSha);
  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included: true, targetSha });
  expect(goal).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  expect(doubles.included).toHaveBeenLastCalledWith('/project', sourceSha, targetSha, undefined);
});
it('recognizes a merge already performed into a checked-out target without changing Git', async () => {
  doubles.included.mockResolvedValue(true);
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  expect(goal.status).toBe('completed'); expect(doubles.merge).not.toHaveBeenCalled();
  expect(doubles.worktrees).not.toHaveBeenCalled();
});
it('automatically completes only after a successful target merge and does not repeat it', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'auto', undefined, policy);
  expect(goal).toMatchObject({ status: 'completed', completion: { targetSha } });
  expect(await completeGoal('/project', goal.id, sourceSha, 'evidence', 'auto', undefined, policy)).toEqual({ goal });
  expect(doubles.merge).toHaveBeenCalledOnce(); expect(goal.notifications).toHaveLength(1);
});
it('preserves awaiting-merge evidence on repeated completion requests', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  await completeGoal('/project', goal.id, sourceSha, 'repeated', 'approve', undefined, policy);
  expect(goal).toEqual(before); expect(doubles.diff).toHaveBeenCalledOnce();
});

it('lets the manager integrate reviewed useful work from a failed task', async () => {
  doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, goalPurpose: '確認済みの途中成果', status: 'failed', branch: 'takt/result', completion: { success: false, branch: 'takt/result' } }]);
  expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).toMatchObject({ status: 'merged' });
  expect(doubles.merge).toHaveBeenCalledOnce();
});
