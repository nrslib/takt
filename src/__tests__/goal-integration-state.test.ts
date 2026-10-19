import { beforeEach,expect,it,vi } from 'vitest';
import { checkGoalCompletion,completeGoal,integrateGoalTask,reopenGoal } from '../infra/goals/integration.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ get: vi.fn(), getSync: vi.fn(), list: vi.fn(), update: vi.fn(), tasks: vi.fn(), merge: vi.fn(), sha: vi.fn(), included: vi.fn(), contentIncluded: vi.fn(), worktrees: vi.fn(), diff: vi.fn(), environment: vi.fn(), gitSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: doubles.gitSync }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: doubles.environment }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; getSync = doubles.getSync; list = doubles.list; update = doubles.update; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems = doubles.tasks; } }));
vi.mock('../infra/goals/merge-git.js', () => ({ mergeGoalBranch: doubles.merge, targetWorktrees: doubles.worktrees }));
vi.mock('../infra/goals/git-command.js', async (original) => ({
  ...await original<typeof import('../infra/goals/git-command.js')>(),
  resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included, isGoalContentIncluded: doubles.contentIncluded,
}));
vi.mock('../infra/goals/diff-summary.js', () => ({ readGoalDiffSummary: doubles.diff, GOAL_DIFF_MAX_FILES: 50 }));
const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks(); goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.getSync.mockImplementation(() => structuredClone(goal));
  doubles.list.mockImplementation(async () => ({ goals: [goal], errors: [] }));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => { goal = transform(goal); return structuredClone(goal); });
  doubles.tasks.mockReturnValue([{ name: 'task', goalId: goal.id, goalPurpose: '入力を検証する', status: 'completed', branch: 'takt/result', completion: { branch: 'takt/result' } }]);
  doubles.sha.mockResolvedValue(sourceSha); doubles.included.mockResolvedValue(false); doubles.contentIncluded.mockResolvedValue(false);
  doubles.merge.mockResolvedValue({ status: 'merged', sha: targetSha }); doubles.worktrees.mockResolvedValue([]);
  doubles.diff.mockResolvedValue({ filesChanged: 1, additions: 2, deletions: 1, files: [], truncated: false, totalsTruncated: false });
  doubles.environment.mockResolvedValue({});
  doubles.gitSync.mockImplementation((_command: string, args: string[]) => ({
    pid: 1, output: [null, Buffer.alloc(0), Buffer.alloc(0)], stdout: Buffer.from(args.includes('rev-parse') ? `${targetSha}\n`
      : args.includes('--is-ancestor') ? '' : args.includes('merge-base') ? `${'c'.repeat(40)}\n` : 'pending.txt\0'), stderr: Buffer.alloc(0),
    status: args.includes('--is-ancestor') ? 1 : 0, signal: null,
  }));
});
it('integrates reviewed task work and records it only in the shared work log', async () => {
  doubles.contentIncluded.mockResolvedValue(true);
  expect(await integrateGoalTask('/project', goal.id, 'task', sourceSha, undefined, policy, 'ja')).toMatchObject({ status: 'merged', sha: targetSha });
  expect(doubles.merge).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, goal.branch, undefined);
  expect(goal.workLog).toEqual([expect.objectContaining({ summary: expect.stringContaining('task') })]);
  expect(goal.notifications).toEqual([expect.objectContaining({ kind: 'progress' })]);
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
  const waiting = structuredClone(goal);
  doubles.update.mockClear();
  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included: false });
  expect(goal).toEqual(waiting);
  expect(doubles.update).not.toHaveBeenCalled();
  doubles.contentIncluded.mockResolvedValue(true); doubles.sha.mockResolvedValue(targetSha);
  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included: true, targetSha });
  expect(goal).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  expect(goal.notifications).toEqual([
    expect.objectContaining({ kind: 'awaiting_merge' }), expect.objectContaining({ kind: 'completed', body: 'evidence' }),
  ]);
  expect(doubles.contentIncluded).toHaveBeenLastCalledWith('/project', sourceSha, targetSha, undefined);
});
it('recognizes included content without ancestry in a checked-out target without changing Git', async () => {
  doubles.contentIncluded.mockResolvedValue(true);
  doubles.sha.mockResolvedValueOnce(sourceSha).mockResolvedValueOnce(targetSha);
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  expect(goal).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  expect(goal.notifications).toEqual([expect.objectContaining({ kind: 'completed', body: 'evidence' })]);
  expect(doubles.merge).not.toHaveBeenCalled();
  expect(doubles.worktrees).not.toHaveBeenCalled();
});
it.each([
  { replaceApproval: false, includedOnRetry: false },
  { replaceApproval: true, includedOnRetry: false },
  { replaceApproval: true, includedOnRetry: true },
])('checks completion with approval replacement=$replaceApproval and retry inclusion=$includedOnRetry', async ({ replaceApproval, includedOnRetry }) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const updatedSha = 'c'.repeat(40);
  doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === goal.branch ? updatedSha : targetSha);
  doubles.contentIncluded.mockClear();
  let finishCheck!: (included: boolean) => void;
  let checkStarted!: () => void;
  const checking = new Promise<void>((resolve) => { checkStarted = resolve; });
  doubles.contentIncluded.mockImplementationOnce(() => {
    checkStarted();
    return new Promise<boolean>((resolve) => { finishCheck = resolve; });
  });

  const completing = checkGoalCompletion('/project', goal.id, undefined, policy);
  await Promise.race([checking, completing]);
  expect(doubles.contentIncluded).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, targetSha, undefined);
  if (replaceApproval) {
    await completeGoal('/project', goal.id, updatedSha, 'updated evidence', 'approve', undefined, policy);
  }
  const before = structuredClone(goal);
  expect(before).toMatchObject({ status: 'awaiting_merge', completion: { goalSha: replaceApproval ? updatedSha : sourceSha } });
  finishCheck(true);

  if (!replaceApproval) {
    expect(await completing).toMatchObject({ included: true, targetSha, goal: { status: 'completed' } });
    expect(goal.completion).toEqual({ ...before.completion, targetBranch: before.integrationBranch, targetSha });
    expect(goal.notifications).toEqual([...before.notifications!, expect.objectContaining({ kind: 'completed', body: 'evidence' })]);
    return;
  }
  await expect(completing).rejects.toThrow();
  expect(goal).toEqual(before);
  doubles.contentIncluded.mockClear();
  doubles.contentIncluded.mockResolvedValue(includedOnRetry);

  const retried = await checkGoalCompletion('/project', goal.id, undefined, policy);

  expect(doubles.contentIncluded).toHaveBeenCalledExactlyOnceWith('/project', updatedSha, targetSha, undefined);
  expect(retried).toMatchObject({ included: includedOnRetry });
  if (includedOnRetry) {
    expect(retried).toMatchObject({ targetSha, goal: { status: 'completed', completion: { goalSha: updatedSha, targetSha } } });
    expect(goal.completion).toEqual({ ...before.completion, targetBranch: before.integrationBranch, targetSha });
    expect(goal.notifications).toEqual([...before.notifications!, expect.objectContaining({ kind: 'completed', body: 'updated evidence' })]);
  } else {
    expect(goal).toEqual(before);
  }
});

it.each([
  { path: 'included', completedReplacement: false },
  { path: 'auto', completedReplacement: false },
  { path: 'approve', completedReplacement: false },
  { path: 'checked_out', completedReplacement: false },
  { path: 'approve', completedReplacement: true },
  { path: 'repeat', completedReplacement: false },
  { path: 'check_false', completedReplacement: false },
].flatMap((scenario) => [false, true].map((replaceApproval) => ({ ...scenario, replaceApproval }))))(
  'protects $path with replacement=$replaceApproval and completed replacement=$completedReplacement',
  async ({ path, replaceApproval, completedReplacement }) => {
    if (path === 'repeat' || path === 'check_false') {
      await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
    }
    doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === goal.branch ? sourceSha : targetSha);
    doubles.contentIncluded.mockResolvedValue(path === 'included');
    doubles.contentIncluded.mockClear();
    doubles.update.mockClear();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const starting = new Promise<void>((resolve) => { started = resolve; });
    if (path === 'auto' || path === 'checked_out') {
      doubles.merge.mockImplementationOnce(async () => {
        started();
        await waiting;
        return path === 'auto' ? { status: 'merged', sha: targetSha }
          : { status: 'checked_out', worktrees: ['/target-worktree'] };
      });
    } else if (path === 'approve') {
      doubles.worktrees.mockImplementationOnce(async () => {
        started();
        await waiting;
        return ['/target-worktree'];
      });
    } else {
      doubles.contentIncluded.mockImplementationOnce(async () => {
        started();
        await waiting;
        return path === 'included';
      });
    }
    const pending = path === 'check_false' ? checkGoalCompletion('/project', goal.id, undefined, policy)
      : completeGoal('/project', goal.id, sourceSha, 'evidence',
        path === 'auto' || path === 'checked_out' ? 'auto' : 'approve', undefined, policy);
    await Promise.race([starting, pending]);
    expect(doubles.contentIncluded).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, targetSha, undefined);
    if (replaceApproval) {
      const updatedSha = 'c'.repeat(40);
      doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === goal.branch ? updatedSha : targetSha);
      doubles.contentIncluded.mockResolvedValue(completedReplacement);
      await completeGoal('/project', goal.id, updatedSha, 'updated evidence', 'approve', undefined, policy);
      expect(goal).toMatchObject({ status: completedReplacement ? 'completed' : 'awaiting_merge', completion: {
        goalSha: updatedSha, ...(completedReplacement ? { targetSha } : {}),
      } });
    }
    const before = structuredClone(goal);
    doubles.update.mockClear();
    release();
    if (replaceApproval) {
      await expect(pending).rejects.toThrow();
      expect(goal).toEqual(before);
      return;
    }
    const result = await pending;
    if (path === 'repeat' || path === 'check_false') {
      expect(result).toEqual(path === 'repeat' ? { status: before.status, completion: before.completion }
        : { included: false, goal: before });
      expect(goal).toEqual(before);
      expect(doubles.update).not.toHaveBeenCalled();
    } else {
      const completed = path === 'included' || path === 'auto';
      expect(result).toMatchObject({ status: completed ? 'merged' : 'awaiting_merge', goal });
      expect(goal).toMatchObject({ status: completed ? 'completed' : 'awaiting_merge', completion: {
        goalSha: sourceSha, ...(completed ? { targetSha } : { worktrees: ['/target-worktree'] }),
      } });
      expect(goal.notifications).toEqual([expect.objectContaining({ kind: completed ? 'completed' : 'awaiting_merge' })]);
    }
  },
);

it.each(['repeat', 'check_false'] as const)('returns the latest saved evidence without writing on %s', async (path) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  doubles.contentIncluded.mockImplementationOnce(async () => {
    goal = { ...goal, completion: { ...goal.completion!, summary: 'latest evidence' } };
    return false;
  });
  doubles.update.mockClear();

  const result = path === 'repeat' ? await completeGoal('/project', goal.id, sourceSha, 'repeated', 'approve', undefined, policy)
    : await checkGoalCompletion('/project', goal.id, undefined, policy);

  expect(result).toEqual(path === 'repeat' ? { status: goal.status, completion: goal.completion }
    : { included: false, goal });
  expect(doubles.update).not.toHaveBeenCalled();
});

it.each(['awaiting_merge', 'reopened'] as const)('accepts a newly reviewed SHA after %s without a concurrent approval change', async (initial) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  if (initial === 'reopened') await reopenGoal('/project', goal.id, 'more work', undefined);
  expect(goal).toMatchObject({ status: initial === 'reopened' ? 'created' : 'awaiting_merge', completion: { goalSha: sourceSha } });
  const updatedSha = 'c'.repeat(40);
  doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === goal.branch ? updatedSha : targetSha);

  expect(await completeGoal('/project', goal.id, updatedSha, 'updated evidence', 'approve', undefined, policy)).toMatchObject({
    status: 'awaiting_merge', completion: { goalSha: updatedSha, summary: 'updated evidence' }, goal,
  });
  expect(goal.completion?.goalSha).toBe(updatedSha);
});

it('uses the latest evidence when saving completion for the same approval', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  doubles.contentIncluded.mockResolvedValue(true);
  const update = doubles.update.getMockImplementation()!;
  doubles.update.mockImplementationOnce(async (id: string, transform: (current: Goal) => Goal) => {
    goal = { ...goal, completion: { ...goal.completion!, summary: 'latest evidence' } };
    return update(id, transform);
  });

  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({
    included: true, goal: { status: 'completed', completion: { goalSha: sourceSha, summary: 'latest evidence' } },
  });
  expect(goal.notifications?.at(-1)).toMatchObject({ kind: 'completed', body: 'latest evidence' });
});

it.each(['created', 'completed'] as const)('rejects a completion check when the saved status becomes %s', async (status) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  doubles.contentIncluded.mockResolvedValue(true);
  const update = doubles.update.getMockImplementation()!;
  const before = { ...structuredClone(goal), status, completion: { ...goal.completion!, ...(status === 'completed' ? { targetSha } : {}) } };
  doubles.update.mockImplementationOnce(async (id: string, transform: (current: Goal) => Goal) => {
    goal = structuredClone(before);
    return update(id, transform);
  });

  await expect(checkGoalCompletion('/project', goal.id, undefined, policy)).rejects.toThrow();
  expect(goal).toEqual(before);
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

it.each(['  追加の修正が必要  ', '理'.repeat(128 * 1024)])('reopens waiting work while preserving evidence and the complete reason', async (reason) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  doubles.sha.mockResolvedValue(targetSha);
  const result = await reopenGoal('/project', goal.id, reason, undefined);
  expect(goal.status).toBe('created');
  expect(goal.completion).toEqual(before.completion);
  expect(goal.notifications).toEqual(before.notifications);
  expect(goal.workLog).toEqual([...before.workLog, expect.objectContaining({ summary: reason, id: result.workLogEntryId })]);
  expect(result).toEqual({ goal, workLogEntryId: goal.workLog.at(-1)!.id });
  expect(doubles.contentIncluded).toHaveBeenLastCalledWith('/project', sourceSha, targetSha, undefined);
  expect(doubles.sha).toHaveBeenLastCalledWith('/project', goal.integrationBranch, undefined);
});

it.each(['created', 'completed'] as const)('rejects reopening a %s goal without saving', async (status) => {
  if (status === 'completed') await completeGoal('/project', goal.id, sourceSha, 'evidence', 'auto', undefined, policy);
  const before = structuredClone(goal);
  doubles.update.mockClear();
  await expect(reopenGoal('/project', goal.id, '追加の修正', undefined)).rejects.toThrow();
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
});

it('rejects an included approval SHA and directs the manager to check completion', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  doubles.contentIncluded.mockResolvedValue(true);
  doubles.update.mockClear();
  await expect(reopenGoal('/project', goal.id, '追加の修正', undefined)).rejects.toThrow('takt_check_goal_completion');
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
});

it('propagates Git failures without reopening or saving a reason', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  doubles.contentIncluded.mockRejectedValue(new Error('Git failed'));
  doubles.update.mockClear();
  await expect(reopenGoal('/project', goal.id, '追加の修正', undefined)).rejects.toThrow('Git failed');
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
});

it('rechecks the saved status before applying the reopen update', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  doubles.contentIncluded.mockImplementation(async () => { goal = { ...goal, status: 'completed', completion: { ...goal.completion!, targetSha } }; return false; });
  const before = structuredClone(goal);
  await expect(reopenGoal('/project', goal.id, '追加の修正', undefined)).rejects.toThrow();
  expect(goal).toEqual({ ...before, status: 'completed', completion: { ...before.completion!, targetSha } });
});

it.each([
  { updatedSha: sourceSha, includedOnRetry: false },
  { updatedSha: 'c'.repeat(40), includedOnRetry: false },
  { updatedSha: 'c'.repeat(40), includedOnRetry: true },
])('checks the saved approval $updatedSha before reopening and uses inclusion=$includedOnRetry on retry', async ({ updatedSha, includedOnRetry }) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === goal.branch ? updatedSha : targetSha);
  doubles.contentIncluded.mockClear();
  let finishCheck!: (included: boolean) => void;
  let checkStarted!: () => void;
  const checking = new Promise<void>((resolve) => { checkStarted = resolve; });
  doubles.contentIncluded.mockImplementationOnce(() => {
    checkStarted();
    return new Promise<boolean>((resolve) => { finishCheck = resolve; });
  });
  const reason = '追加の修正';
  const reopening = reopenGoal('/project', goal.id, reason, undefined);
  await Promise.race([checking, reopening]);
  expect(doubles.contentIncluded).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, targetSha, undefined);
  await completeGoal('/project', goal.id, updatedSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  expect(before).toMatchObject({ status: 'awaiting_merge', executionStatus: 'active', completion: { goalSha: updatedSha } });
  finishCheck(false);

  if (updatedSha === sourceSha) {
    await reopening;
  } else {
    await expect(reopening).rejects.toThrow('takt_check_goal_completion');
    expect(goal).toEqual(before);
    doubles.contentIncluded.mockResolvedValue(includedOnRetry);
    if (includedOnRetry) {
      await expect(reopenGoal('/project', goal.id, reason, undefined)).rejects.toThrow('takt_check_goal_completion');
      expect(goal).toEqual(before);
      expect(doubles.contentIncluded).toHaveBeenLastCalledWith('/project', updatedSha, targetSha, undefined);
      return;
    }
    await reopenGoal('/project', goal.id, reason, undefined);
  }

  expect(doubles.contentIncluded).toHaveBeenLastCalledWith('/project', updatedSha, targetSha, undefined);
  expect(goal).toEqual({ ...before, status: 'created', workLog: [
    ...before.workLog, expect.objectContaining({ summary: reason }),
  ] });
});

it('does not save a reopen after cancellation during the containment check', async () => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  const controller = new AbortController();
  doubles.contentIncluded.mockImplementation(async () => { controller.abort(); return false; });
  doubles.update.mockClear();
  await expect(reopenGoal('/project', goal.id, '追加の修正', controller.signal)).rejects.toThrow();
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
});

it.each([
  { finalTarget: targetSha, included: false },
  { finalTarget: 'c'.repeat(40), included: true },
  { finalTarget: 'd'.repeat(40), included: false },
])('checks target $finalTarget at save time and rejects only included approvals', async ({ finalTarget, included }) => {
  await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
  const before = structuredClone(goal);
  const reason = '追加の修正';
  let currentTarget = targetSha;
  doubles.sha.mockImplementation(async () => currentTarget);
  doubles.contentIncluded.mockClear();
  let finishCheck!: (included: boolean) => void;
  let checkStarted!: () => void;
  const checking = new Promise<void>((resolve) => { checkStarted = resolve; });
  doubles.contentIncluded.mockImplementationOnce(() => {
    checkStarted();
    return new Promise<boolean>((resolve) => { finishCheck = resolve; });
  });
  const update = doubles.update.getMockImplementation()!;
  doubles.update.mockImplementationOnce(async (id: string, transform: (current: Goal) => Goal) => {
    currentTarget = finalTarget;
    return update(id, transform);
  });
  doubles.gitSync.mockImplementation((_command: string, args: string[]) => ({
    pid: 1, output: [null, Buffer.alloc(0), Buffer.alloc(0)], stdout: Buffer.from(args.includes('rev-parse') ? `${currentTarget}\n`
      : args.includes('--is-ancestor') ? '' : args.includes('merge-base') ? `${'e'.repeat(40)}\n`
        : args.includes(sourceSha) && args.includes(finalTarget) && included ? 'unrelated.txt\0' : 'pending.txt\0'), stderr: Buffer.alloc(0),
    status: args.includes('--is-ancestor') ? 1 : 0, signal: null,
  }));

  const reopening = reopenGoal('/project', goal.id, reason, undefined);
  await Promise.race([checking, reopening]);
  expect(doubles.contentIncluded).toHaveBeenCalledExactlyOnceWith('/project', sourceSha, targetSha, undefined);
  finishCheck(false);
  if (included) {
    await expect(reopening).rejects.toThrow('takt_check_goal_completion');
    expect(goal).toEqual(before);
  } else {
    const result = await reopening;
    expect(goal).toEqual({ ...before, status: 'created', workLog: [
      ...before.workLog, expect.objectContaining({ summary: reason, id: result.workLogEntryId }),
    ] });
  }
  expect(doubles.gitSync).toHaveBeenCalledWith('git', expect.arrayContaining([
    'rev-parse', '--verify', `refs/heads/${goal.integrationBranch}^{commit}`,
  ]), expect.objectContaining({ cwd: '/project' }));
  expect(doubles.gitSync).toHaveBeenCalledWith('git', expect.arrayContaining([
    'merge-base', '--is-ancestor', sourceSha, finalTarget,
  ]), expect.objectContaining({ cwd: '/project' }));
});

it.each(['environment', 'spawn', 'rev-parse exit', 'merge-base exit', 'signal', 'missing status', 'incomplete SHA', 'buffer limit', 'content merge-base exit', 'content diff exit'])(
  'preserves the saved goal when the final Git check fails: %s', async (failure) => {
    await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
    const before = structuredClone(goal);
    if (failure === 'environment') doubles.environment.mockRejectedValueOnce(new Error('Git config failed'));
    else {
      const git = doubles.gitSync.getMockImplementation()!;
      doubles.gitSync.mockImplementation((command: string, args: string[]) => {
        const result = git(command, args);
        if (failure === 'merge-base exit' && args.includes('rev-parse')) return result;
        if (failure === 'content merge-base exit' && (args.includes('rev-parse') || args.includes('--is-ancestor'))) return result;
        if (failure === 'content diff exit' && !args.includes('diff')) return result;
        if (failure === 'spawn' || failure === 'buffer limit') return { ...result, status: null,
          error: Object.assign(new Error(failure), { code: failure === 'spawn' ? 'ENOENT' : 'ENOBUFS' }) };
        if (failure === 'signal') return { ...result, status: null, signal: 'SIGTERM' };
        if (failure === 'missing status') return { ...result, status: null };
        if (failure === 'incomplete SHA') return { ...result, stdout: Buffer.from(sourceSha.slice(0, 20)) };
        return { ...result, status: 128, stderr: Buffer.from('fatal: Git check failed') };
      });
    }
    await expect(reopenGoal('/project', goal.id, '追加の修正', undefined)).rejects.toThrow();
    expect(goal).toEqual(before);
  },
);

it.each(['before final check', 'after final check'])(
  'preserves the saved goal on cancellation %s', async (timing) => {
    await completeGoal('/project', goal.id, sourceSha, 'evidence', 'approve', undefined, policy);
    const before = structuredClone(goal);
    const controller = new AbortController();
    if (timing === 'before final check') {
      const update = doubles.update.getMockImplementation()!;
      doubles.update.mockImplementationOnce(async (id: string, transform: (current: Goal) => Goal) => {
        controller.abort();
        return update(id, transform);
      });
    } else {
      const git = doubles.gitSync.getMockImplementation()!;
      doubles.gitSync.mockImplementation((command: string, args: string[]) => {
        const result = git(command, args);
        if (args.includes('merge-base')) controller.abort();
        return result;
      });
    }
    await expect(reopenGoal('/project', goal.id, '追加の修正', controller.signal)).rejects.toThrow();
    expect(goal).toEqual(before);
    if (timing === 'before final check') expect(doubles.gitSync).not.toHaveBeenCalled();
  },
);
