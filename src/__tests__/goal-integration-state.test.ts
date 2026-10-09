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
const notificationPolicy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
const disabledNotifications = { question: false, awaiting_merge: false, completed: false, progress: false, blocked: false, custom: false };
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
  it.each(['merged', 'conflict', 'checked_out'] as const)('preserves the work key and records progress only for %s integration', async (status) => {
    goal.workUnits![0]!.workKey = 'export';
    doubles.merge.mockResolvedValue({ status, sha: targetSha, conflicts: ['file'], worktrees: ['/human'] });
    await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, notificationPolicy);
    expect(goal.workUnits![0]!.workKey).toBe('export');
    expect(goal.workUnits![0]!.integration?.status).toBe(status);
    expect(goal.notifications?.map((notice) => notice.kind) ?? []).toEqual(status === 'merged' ? ['progress'] : []);
  });

  it('records awaiting merge once, then completion only after the approved SHA is included', async () => {
    await completeGoal('/project', goal.id, sourceSha, 'acceptance evidence', 'approve', undefined, notificationPolicy);
    await completeGoal('/project', goal.id, sourceSha, 'acceptance evidence', 'approve', undefined, notificationPolicy);
    expect(goal.notifications?.map((notice) => notice.kind)).toEqual(['awaiting_merge']);
    await checkGoalCompletion('/project', goal.id, undefined, notificationPolicy);
    expect(goal.status).toBe('awaiting_merge');
    expect(goal.notifications).toHaveLength(1);
    doubles.included.mockResolvedValue(true);
    await checkGoalCompletion('/project', goal.id, undefined, notificationPolicy);
    expect(goal.status).toBe('completed');
    expect(goal.notifications?.map((notice) => notice.kind)).toEqual(['awaiting_merge', 'completed']);
  });
  it.each(['auto', 'approve'] as const)('uses only the saved integration branch in %s mode', async (mode) => {
    goal.integrationBranch = 'release';
    const result = await completeGoal('/project', goal.id, sourceSha, 'evidence', mode, undefined, disabledNotifications);
    expect(doubles.sha).toHaveBeenLastCalledWith('/project', 'release', undefined);
    expect(result).toMatchObject({ completion: { targetBranch: 'release' }, recorded: true });
    expect(goal.completion?.targetBranch).toBe('release');
    if (mode === 'auto') {
      expect(doubles.merge).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, 'release', undefined);
    } else {
      expect(doubles.merge).not.toHaveBeenCalled();
      expect(doubles.worktrees).toHaveBeenCalledExactlyOnceWith('/project', 'release', undefined);
      expect(goal.completion?.instructions).toContain("git switch 'release'");
    }
  });

  it('records the actual merge SHA and preserves work purpose and other goal state', async () => {
    goal.events = [{ taskName: 'task', runSlug: 'run', processed: true, result: { success: false, interrupted: false } }];
    goal.sessions = [{ provider: 'mock', sessionId: 'session' }];
    const before = structuredClone(goal);
    const result = await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: true });
    expect(goal.workUnits).toEqual([{ taskName: 'task', purpose: '成果の確認', integration: {
      sourceBranch: 'takt/result', expectedSha: sourceSha, status: 'merged', goalSha: targetSha, recordedAt: expect.any(String),
    } }]);
    expect(goal.events).toEqual(before.events);
    expect(goal.sessions).toEqual(before.sessions);
  });

  it.each([undefined, 'another-goal'])('rejects a task owned by %s before Git operations', async (goalId) => {
    doubles.tasks.mockReturnValue([{ name: 'task', goalId, completion: { branch: 'takt/result' } }]);
    await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications)).rejects.toThrow();
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
    await expect(integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications)).rejects.toThrow();
    expect(doubles.merge).not.toHaveBeenCalled();
    expect(doubles.update).not.toHaveBeenCalled();
  });

  it('reports Git success separately from publication failure and records on retry', async () => {
    doubles.update.mockRejectedValueOnce(new Error('publication failed'));
    const result = await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: false, recordError: expect.any(String) });
    expect(goal.workUnits![0]!.integration).toBeUndefined();
    expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications)).toMatchObject({ recorded: true });
    expect(goal.workUnits![0]!.integration?.goalSha).toBe(targetSha);
  });

  it.each([
    { status: 'conflict', conflicts: ['file.txt'] },
    { status: 'checked_out', worktrees: ['/human'] },
  ])('records refused task integration result $status', async (result) => {
    doubles.merge.mockResolvedValue(result);
    expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, disabledNotifications)).toMatchObject({ ...result, recorded: true });
    expect(goal.status).toBe('created');
    expect(goal.workUnits![0]!.integration).toMatchObject(result);
  });

  it('completes only after automatic integration and reports recording failure accurately', async () => {
    goal.integrationBranch = 'release';
    doubles.update.mockRejectedValueOnce(new Error('publication failed'));
    const result = await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', undefined, disabledNotifications);
    expect(result).toMatchObject({ status: 'merged', sha: targetSha, recorded: false });
    expect(goal.status).toBe('created');
    expect(doubles.merge).toHaveBeenCalledWith('/project', sourceSha, 'release', undefined);
    await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', undefined, disabledNotifications);
    expect(goal.status).toBe('completed');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetSha, targetBranch: 'release', summary: 'criteria and evidence', changeSummary: await doubles.diff.mock.results[0]!.value });
  });

  it('retains an open goal on main merge conflicts', async () => {
    doubles.merge.mockResolvedValue({ status: 'conflict', conflicts: ['file'] });
    expect(await completeGoal('/project', goal.id, sourceSha, 'evidence', 'auto', undefined, disabledNotifications))
      .toEqual({ status: 'conflict', conflicts: ['file'] });
    expect(doubles.update).not.toHaveBeenCalled();
    expect(goal.status).toBe('created');
  });

  it.each(['approve', 'auto'] as const)('waits for a human in %s mode when required', async (mode) => {
    doubles.merge.mockResolvedValue({ status: 'checked_out', worktrees: ['/human'] });
    await completeGoal('/project', goal.id, sourceSha, 'evidence', mode, undefined, disabledNotifications);
    expect(goal.status).toBe('awaiting_merge');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetBranch: 'main', summary: 'evidence', instructions: expect.any(Array) });
    if (mode === 'approve') expect(doubles.merge).not.toHaveBeenCalled();
    else expect(goal.completion?.worktrees).toEqual(['/human']);
  });

  it('checks the saved approved SHA across human integration and later goal changes', async () => {
    goal.integrationBranch = 'release';
    await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, disabledNotifications);
    doubles.sha.mockResolvedValue(targetSha);
    await checkGoalCompletion('/project', goal.id, undefined, disabledNotifications);
    expect(doubles.sha).toHaveBeenLastCalledWith('/project', 'release', undefined);
    expect(goal.status).toBe('awaiting_merge');
    expect(doubles.included).toHaveBeenLastCalledWith('/project', sourceSha, targetSha, undefined);
    doubles.included.mockResolvedValue(true);
    await checkGoalCompletion('/project', goal.id, undefined, disabledNotifications);
    expect(goal.status).toBe('completed');
    expect(goal.completion).toMatchObject({ goalSha: sourceSha, targetSha, targetBranch: 'release', summary: 'evidence' });
    expect(await checkGoalCompletion('/project', goal.id, undefined, disabledNotifications)).toMatchObject({ goal: { status: 'completed' } });
  });

  it('checks the saved integration branch even when a prior completion recorded a different target', async () => {
    goal.integrationBranch = 'release';
    await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, disabledNotifications);
    goal.completion = { ...goal.completion!, targetBranch: 'develop' };
    expect(await checkGoalCompletion('/project', goal.id, undefined, disabledNotifications)).toMatchObject({ included: false });
    expect(doubles.sha).toHaveBeenLastCalledWith('/project', 'release', undefined);
    expect(goal.status).toBe('awaiting_merge');
    doubles.included.mockResolvedValue(true);
    await checkGoalCompletion('/project', goal.id, undefined, disabledNotifications);
    expect(goal.completion).toMatchObject({ targetBranch: 'release', targetSha: sourceSha });
    expect(goal.status).toBe('completed');
  });
});

it.each(['auto', 'approve'] as const)('records checked-out target paths and commands in %s mode', async (mode) => {
  const directory = "/human's tree";
  doubles.merge.mockResolvedValue({ status: 'checked_out', worktrees: [directory] });
  doubles.worktrees.mockResolvedValue([directory]);
  const result = await completeGoal('/project', goal.id, sourceSha, 'evidence', mode, undefined, disabledNotifications);
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
  goal.integrationBranch = 'release';
  doubles.sha.mockResolvedValueOnce(sourceSha).mockResolvedValueOnce(targetSha);
  const result = await completeGoal('/project', goal.id, sourceSha, 'criteria and evidence', 'auto', undefined, disabledNotifications);
  expect(doubles.diff).toHaveBeenCalledWith('/project', targetSha, sourceSha, 50, undefined);
  expect(doubles.diff.mock.invocationCallOrder[0]).toBeLessThan(doubles.merge.mock.invocationCallOrder[0]!);
  expect(result).toMatchObject({ completion: { summary: 'criteria and evidence', changeSummary: { filesChanged: 1, additions: 2, deletions: 1 } } });
});
