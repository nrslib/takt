import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, removeWorkspaceRepository } from '../infra/config/global/workspaceRegistry.js';
import { abortEpic, addEpicMember, createEpic } from '../infra/epics/index.js';
import type { EpicOwner } from '../infra/epics/schema.js';
import { deleteFinishedGoal } from '../infra/goals/deletion.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { epicDefinition } from './helpers/epic-fixtures.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const lockWait = vi.hoisted(() => ({ before: undefined as (() => Promise<void>) | undefined }));
// ロックを待つ間に別の操作が進む順序を、時間に頼らず再現するため、次に取るロックの前に一度だけ処理を挟む。
vi.mock('../infra/epics/lock.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/epics/lock.js')>();
  return {
    ...original,
    withWorkspaceEpicLock: async <T>(configDirectory: string, workspaceId: string, action: () => Promise<T>): Promise<T> => {
      const before = lockWait.before;
      lockWait.before = undefined;
      if (before !== undefined) await before();
      return original.withWorkspaceEpicLock(configDirectory, workspaceId, action);
    },
  };
});

const otherGoalId = '550e8400-e29b-41d4-a716-446655440001';
const startedAt = '2026-11-18T00:00:00.000Z';
const completedAt = '2026-11-18T00:10:00.000Z';
const completion = {
  goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
  summary: 'Integrated', instructions: ['Verified merge'],
  changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function globalConfigDirectory(): string {
  const directory = process.env.TAKT_CONFIG_DIR;
  if (directory === undefined) throw new Error('Isolated test configuration is required');
  return directory;
}

describe('deleteFinishedGoal', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-deletion-')));
    git(cwd, 'init', '--initial-branch=main');
    git(cwd, '-c', 'user.name=TAKT Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
    git(cwd, 'branch', goalRecord().branch);
    git(cwd, 'branch', 'integration/goal');
  });

  afterEach(() => {
    lockWait.before = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  function addGoalTask(name: string, goal: string, status: 'pending' | 'running' | 'completed' | 'failed'): void {
    new TaskRunner(cwd).addTask(`${name} content`, { slug: name, goal_id: goal });
    if (status === 'pending') return;
    new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => task.name !== name ? task : {
      ...task, status, started_at: startedAt,
      ...(status === 'running' ? { owner_pid: process.pid } : { completed_at: completedAt }),
      ...(status === 'failed' ? { failure: { error: 'Task failed' } } : {}),
    }) }));
  }

  function deletedGoalsDirectory(): string {
    return join(cwd, '.takt', 'tmp', 'deleted-goals');
  }

  function taskNames(): string[] {
    return new TaskStore(cwd).read().tasks.map((task) => task.name);
  }

  it.each<{ name: string; goal: Goal }>([
    { name: 'completed', goal: { ...goalRecord(), status: 'completed', integrationBranch: 'integration/goal', completion } },
    { name: 'aborted', goal: { ...goalRecord(), executionStatus: 'aborted', integrationBranch: 'integration/goal' } },
  ])('removes the $name goal record and its task records while keeping branches and runs', async ({ goal }) => {
    await new GoalStore(cwd).create(goal);
    addGoalTask('goal-completed-task', goalId, 'completed');
    addGoalTask('goal-failed-task', goalId, 'failed');
    addGoalTask('other-goal-task', otherGoalId, 'pending');
    const runDirectory = join(cwd, '.takt', 'runs', 'goal-run');
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'meta.json'), '{}');

    await deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined);

    expect(existsSync(join(cwd, '.takt', 'goals', goalId))).toBe(false);
    expect(new GoalStore(cwd).find(goalId)).toBeUndefined();
    expect(readdirSync(deletedGoalsDirectory())).toEqual([]);
    expect(taskNames()).toEqual(['other-goal-task']);
    expect(git(cwd, 'branch', '--list', goal.branch, 'integration/goal', '--format=%(refname:short)').split('\n').sort())
      .toEqual(['integration/goal', goal.branch].sort());
    expect(existsSync(join(runDirectory, 'meta.json'))).toBe(true);
  });

  it.each<Goal>([
    goalRecord(),
    { ...goalRecord(), executionStatus: 'paused' },
    { ...goalRecord(), status: 'awaiting_merge', completion },
  ])('refuses an unfinished goal ($status/$executionStatus) and keeps its records', async (goal) => {
    await new GoalStore(cwd).create(goal);
    addGoalTask('goal-completed-task', goalId, 'completed');
    const tasksBefore = new TaskStore(cwd).read();

    await expect(deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined)).rejects.toThrow('Only a completed or aborted goal can be deleted');

    expect(await new GoalStore(cwd).get(goalId)).toEqual(goal);
    expect(new TaskStore(cwd).read()).toEqual(tasksBefore);
  });

  it.each(['pending', 'running'] as const)('refuses a finished goal that still has a %s task and keeps every record', async (status) => {
    const goal: Goal = { ...goalRecord(), executionStatus: 'aborted' };
    await new GoalStore(cwd).create(goal);
    addGoalTask('goal-completed-task', goalId, 'completed');
    addGoalTask('goal-unfinished-task', goalId, status);
    const tasksBefore = new TaskStore(cwd).read();

    await expect(deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined)).rejects.toThrow('Goal has pending or running tasks: goal-unfinished-task');

    expect(await new GoalStore(cwd).get(goalId)).toEqual(goal);
    expect(new TaskStore(cwd).read()).toEqual(tasksBefore);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the deleted goal out of listings when its moved files cannot be removed',
    async () => {
      await new GoalStore(cwd).create({ ...goalRecord(), status: 'completed', completion });
      await new GoalStore(cwd).create({ ...goalRecord(), id: otherGoalId });
      const undeletable = join(cwd, '.takt', 'goals', goalId, 'undeletable');
      mkdirSync(undeletable);
      writeFileSync(join(undeletable, 'file'), '');
      chmodSync(undeletable, 0o500);
      try {
        await expect(deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined)).rejects.toThrow(goalId);

        expect(existsSync(join(cwd, '.takt', 'goals', goalId))).toBe(false);
        expect(new GoalStore(cwd).find(goalId)).toBeUndefined();
        const listed = await new GoalStore(cwd).list();
        expect(listed.errors).toEqual([]);
        expect(listed.goals.map((goal) => goal.id)).toEqual([otherGoalId]);
      } finally {
        for (const removed of readdirSync(deletedGoalsDirectory())) chmodSync(join(deletedGoalsDirectory(), removed, 'undeletable'), 0o700);
      }
    },
  );

  it('removes saved manager events for the deleted goal and keeps events for other goals', async () => {
    await new GoalStore(cwd).create({ ...goalRecord(), status: 'completed', completion });
    await new GoalStore(cwd).create({ ...goalRecord(), id: otherGoalId });
    saveManagerEvent(cwd, { kind: 'registered', goalId });
    saveManagerEvent(cwd, { kind: 'resumed', goalId });
    saveManagerEvent(cwd, { kind: 'registered', goalId: otherGoalId });

    await deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined);

    expect(readManagerEvents(cwd).map(({ event }) => event.goalId)).toEqual([otherGoalId]);
  });

  it('keeps the clone directory of a failed task after removing its record', async () => {
    await new GoalStore(cwd).create({ ...goalRecord(), executionStatus: 'aborted' });
    addGoalTask('goal-failed-task', goalId, 'failed');
    const cloneDirectory = join(cwd, 'clones', 'goal-failed-task');
    mkdirSync(cloneDirectory, { recursive: true });
    writeFileSync(join(cloneDirectory, 'unpushed.txt'), 'work in progress');
    new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, worktree_path: cloneDirectory })) }));

    await deleteFinishedGoal(cwd, goalId, globalConfigDirectory(), undefined);

    expect(taskNames()).toEqual([]);
    expect(existsSync(join(cloneDirectory, 'unpushed.txt'))).toBe(true);
  });

  describe('in a workspace', () => {
    let owner: EpicOwner;

    beforeEach(async () => {
      const workspace = await createWorkspace({ globalConfigDirectory: globalConfigDirectory(), name: 'goal deletion', repositoryDirectories: [cwd] });
      owner = { globalConfigDirectory: globalConfigDirectory(), workspaceId: workspace.id };
    });

    it.each(['active', 'aborted'] as const)('refuses a finished goal that an %s Epic references and keeps its records', async (epicStatus) => {
      const goal: Goal = { ...goalRecord(), status: 'completed', completion };
      await new GoalStore(cwd).create(goal);
      addGoalTask('goal-completed-task', goalId, 'completed');
      const epicId = (await createEpic({ ...owner, ...epicDefinition(), reason: 'Check the integration' })).id;
      await addEpicMember({ ...owner, epicId, member: { repositoryDirectory: cwd, goalId }, reason: 'Integrated goal' });
      if (epicStatus === 'aborted') await abortEpic({ ...owner, epicId, reason: 'No longer needed' });
      const tasksBefore = new TaskStore(cwd).read();

      await expect(deleteFinishedGoal(cwd, goalId, owner.globalConfigDirectory, owner.workspaceId)).rejects.toThrow(epicId);

      expect(await new GoalStore(cwd).get(goalId)).toEqual(goal);
      expect(new TaskStore(cwd).read()).toEqual(tasksBefore);
    });

    it('refuses from the repository manager when an Epic of the workspace the repository left references the goal', async () => {
      const goal: Goal = { ...goalRecord(), status: 'completed', completion };
      await new GoalStore(cwd).create(goal);
      const epicId = (await createEpic({ ...owner, ...epicDefinition(), reason: 'Check the integration' })).id;
      await addEpicMember({ ...owner, epicId, member: { repositoryDirectory: cwd, goalId }, reason: 'Integrated goal' });
      await abortEpic({ ...owner, epicId, reason: 'No longer needed' });
      await removeWorkspaceRepository(owner.globalConfigDirectory, owner.workspaceId, cwd);

      await expect(deleteFinishedGoal(cwd, goalId, owner.globalConfigDirectory, undefined)).rejects.toThrow(epicId);

      expect(await new GoalStore(cwd).get(goalId)).toEqual(goal);
    });

    it('refuses when the repository moves to another workspace whose Epic adds the goal while the deletion waits for the lock', async () => {
      const goal: Goal = { ...goalRecord(), status: 'completed', completion };
      await new GoalStore(cwd).create(goal);
      addGoalTask('goal-completed-task', goalId, 'completed');
      const tasksBefore = new TaskStore(cwd).read();
      let otherEpicId: string | undefined;
      lockWait.before = async () => {
        await removeWorkspaceRepository(owner.globalConfigDirectory, owner.workspaceId, cwd);
        const other = await createWorkspace({ globalConfigDirectory: owner.globalConfigDirectory, name: 'other workspace', repositoryDirectories: [cwd] });
        const otherOwner = { globalConfigDirectory: owner.globalConfigDirectory, workspaceId: other.id };
        otherEpicId = (await createEpic({ ...otherOwner, ...epicDefinition(), reason: 'Check the integration' })).id;
        await addEpicMember({ ...otherOwner, epicId: otherEpicId, member: { repositoryDirectory: cwd, goalId }, reason: 'Integrated goal' });
      };

      const deletion = deleteFinishedGoal(cwd, goalId, owner.globalConfigDirectory, owner.workspaceId);
      await deletion.catch(() => undefined);

      expect(otherEpicId).toBeDefined();
      await expect(deletion).rejects.toThrow(otherEpicId!);
      expect(await new GoalStore(cwd).get(goalId)).toEqual(goal);
      expect(new TaskStore(cwd).read()).toEqual(tasksBefore);
    });

    it('deletes a finished goal that no workspace Epic references', async () => {
      await new GoalStore(cwd).create({ ...goalRecord(), status: 'completed', completion });
      await createEpic({ ...owner, ...epicDefinition(), reason: 'Unrelated Epic' });

      await deleteFinishedGoal(cwd, goalId, owner.globalConfigDirectory, owner.workspaceId);

      expect(new GoalStore(cwd).find(goalId)).toBeUndefined();
    });
  });
});
