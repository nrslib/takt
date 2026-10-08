import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  get: vi.fn(), list: vi.fn(), update: vi.fn(), tasks: vi.fn(), merge: vi.fn(), sha: vi.fn(), included: vi.fn(), worktrees: vi.fn(), diff: vi.fn(),
}));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  get = doubles.get; list = doubles.list; update = doubles.update;
} }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; } }));
vi.mock('../infra/goals/merge-git.js', () => ({ mergeGoalBranch: doubles.merge, targetWorktrees: doubles.worktrees }));
vi.mock('../infra/goals/git-command.js', () => ({ resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included }));

vi.mock('../infra/goals/diff-summary.js', () => ({ readGoalDiffSummary: doubles.diff, GOAL_DIFF_MAX_FILES: 50 }));

import { assertReviewedGoalSha, checkGoalCompletion, completeGoal, getGoalTaskSource, integrateGoalTask } from '../infra/goals/integration.js';

const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), workUnits: [{ taskName: 'task', purpose: '成果の確認' }] };
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [structuredClone(goal)], errors: [] }));
  doubles.update.mockImplementation(async (_id: string, update: (value: Goal) => Goal) => {
    goal = update(structuredClone(goal)); return structuredClone(goal);
  });
  doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, branch: 'takt/result', completion: { branch: 'takt/result' } }]);
  doubles.sha.mockResolvedValue(sourceSha);
  doubles.merge.mockResolvedValue({ status: 'merged', sha: targetSha });
  doubles.included.mockResolvedValue(false);
  doubles.worktrees.mockResolvedValue([]);
  doubles.diff.mockResolvedValue({ filesChanged: 1, additions: 2, deletions: 1, files: [{ path: 'file', additions: 2, deletions: 1 }], truncated: false, totalsTruncated: false });
});

describe('goal integration state', () => {
  it('records the actual merge SHA and preserves work purpose and other goal state', async () => {
    goal.events = [{ taskName: 'task', runSlug: 'run', processed: true, result: { success: false, interrupted: false } }];
    goal.sessions = [{ provider: 'mock', sessionId: 'session' }];
    const before = structuredClone(goal);
    const result = await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: true });
    expect(goal.workUnits).toEqual([{ taskName: 'task', purpose: '成果の確認', integration: {
      sourceBranch: 'takt/result', expectedSha: sourceSha, status: 'merged', goalSha: targetSha, recordedAt: expect.any(String),
    } }]);
    expect(goal.events).toEqual(before.events);
    expect(goal.sessions).toEqual(before.sessions);
  });

  it.each([undefined, 'another-goal'])('rejects a task owned by %s before Git operations', async (goalId) => {
    doubles.tasks.mockReturnValue([{ name: 'task', goalId, completion: { branch: 'takt/result' } }]);
    await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined)).rejects.toThrow();
    expect(doubles.merge).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
  });

  it('rejects goal branch results and inconsistent saved result branches', async () => {
    doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, completion: { branch: goal.branch } }]);
    await expect(getGoalTaskSource('/project', goal, 'task')).rejects.toThrow();
    doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, branch: 'takt/other', completion: { branch: 'takt/result' } }]);
    await expect(getGoalTaskSource('/project', goal, 'task')).rejects.toThrow();
    expect(doubles.merge).not.toHaveBeenCalled();
  });

  it('rejects an unreviewed SHA without changing saved state', async () => {
    doubles.sha.mockResolvedValue(targetSha);
    await expect(assertReviewedGoalSha('/project', goal.branch, sourceSha, undefined)).rejects.toThrow();
    await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined)).rejects.toThrow();
    expect(doubles.merge).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
  });

  it('reports Git success separately from publication failure and records on retry', async () => {
    doubles.update.mockRejectedValueOnce(new Error('publication failed'));
    const result = await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: false, recordError: expect.any(String) });
    expect(goal.workUnits![0]!.integration).toBeUndefined();
    expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined)).toMatchObject({ recorded: true });
    expect(goal.workUnits![0]!.integration?.goalSha).toBe(targetSha);
  });

  it.each([
    { status: 'conflict', conflicts: ['file.txt'] },
    { status: 'checked_out', worktrees: ['/human'] },
  ])('records refused task integration result $status', async (result) => {
    doubles.merge.mockResolvedValue(result);
    expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined)).toMatchObject({ ...result, recorded: true });
    expect(goal.status).toBe('created');
    expect(goal.workUnits![0]!.integration).toMatchObject(result);
  });

  it('completes only after automatic integration and reports recording failure accurately', async () => {
    doubles.update.mockRejectedValueOnce(new Error('publication failed'));
    const result = await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', 'release', undefined);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: false });
    expect(goal.status).toBe('created');
    expect(doubles.merge).toHaveBeenCalledWith('/project', sourceSha, 'release', undefined);
    await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', 'release', undefined);
    expect(goal.status).toBe('completed');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetSha, targetBranch: 'release', summary: 'criteria and evidence', changeSummary: await doubles.diff.mock.results[0]!.value });
  });

  it('retains an open goal on main merge conflicts', async () => {
    doubles.merge.mockResolvedValue({ status: 'conflict', conflicts: ['file'] });
    expect(await completeGoal('/project', goal.id, sourceSha, 'evidence', 'auto', 'main', undefined))
      .toEqual({ status: 'conflict', conflicts: ['file'] });
    expect(doubles.update).not.toHaveBeenCalled();
    expect(goal.status).toBe('created');
  });

  it.each(['approve', 'auto'] as const)('waits for a human in %s mode when required', async (mode) => {
    doubles.merge.mockResolvedValue({ status: 'checked_out', worktrees: ['/human'] });
    await completeGoal('/project', goal.id, sourceSha, 'evidence', mode, 'main', undefined);
    expect(goal.status).toBe('awaiting_merge');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetBranch: 'main', summary: 'evidence', instructions: expect.any(Array) });
    if (mode === 'approve') expect(doubles.merge).not.toHaveBeenCalled();
    else expect(goal.completion?.worktrees).toEqual(['/human']);
  });

  it('checks the saved approved SHA across human integration and later goal changes', async () => {
    await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', 'release', undefined);
    doubles.sha.mockResolvedValue(targetSha);
    await checkGoalCompletion('/project', goal.id, undefined);
    expect(goal.status).toBe('awaiting_merge');
    expect(doubles.included).toHaveBeenLastCalledWith('/project', sourceSha, targetSha, undefined);
    doubles.included.mockResolvedValue(true);
    await checkGoalCompletion('/project', goal.id, undefined);
    expect(goal.status).toBe('completed');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetSha, targetBranch: 'release', summary: 'evidence' });
    expect(await checkGoalCompletion('/project', goal.id, undefined)).toMatchObject({ goal: { status: 'completed' } });
  });
});

it.each(['auto', 'approve'] as const)('records checked-out target paths and commands in %s mode', async (mode) => {
  const directory = "/human's tree";
  doubles.merge.mockResolvedValue({ status: 'checked_out', worktrees: [directory] });
  doubles.worktrees.mockResolvedValue([directory]);
  const result = await completeGoal('/project', goal.id, sourceSha, 'evidence', mode, 'main', undefined);
  expect(result).toMatchObject({ completion: goal.completion, recorded: true });
  expect(goal.completion?.worktrees).toEqual([directory]);
  expect(goal.completion?.instructions).toEqual([
    "git -C '/human'\\''s tree' status --short",
    `git -C '/human'\\''s tree' merge --no-ff --no-edit '${sourceSha}'`,
  ]);
  expect(goal.completion?.changeSummary).toEqual(await doubles.diff.mock.results[0]!.value);
  expect(doubles.diff).toHaveBeenCalledWith('/project', sourceSha, sourceSha, 50, undefined);
});

it('records a bounded change summary separately from manager evidence before automatic merging', async () => {
  doubles.sha.mockResolvedValueOnce(sourceSha).mockResolvedValueOnce(targetSha);
  const result = await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', 'release', undefined);
  expect(doubles.diff).toHaveBeenCalledWith('/project', targetSha, sourceSha, 50, undefined);
  expect(doubles.diff.mock.invocationCallOrder[0]).toBeLessThan(doubles.merge.mock.invocationCallOrder[0]!);
  expect(result).toMatchObject({ completion: { summary: 'criteria and evidence', changeSummary: { filesChanged: 1, additions: 2, deletions: 1 } } });
});
