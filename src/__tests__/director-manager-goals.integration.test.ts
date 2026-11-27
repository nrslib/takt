import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readDirectorManagerGoals } from '../infra/director/managerGoals.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { isGoalFinished } from '../infra/goals/activity.js';
import { goalRecord } from './helpers/goal-fixtures.js';

let repository: string;
beforeEach(async () => { repository = await mkdtemp(join(tmpdir(), 'takt-director-goals-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(repository, { recursive: true, force: true }); });

async function save(goal: Goal, directoryId = goal.id) {
  const directory = join(repository, '.takt', 'goals', directoryId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'goal.json');
  await writeFile(path, JSON.stringify(goal));
  return path;
}
async function read(): Promise<Goal[]> {
  const goals: Goal[] = [];
  for await (const goal of readDirectorManagerGoals(repository, new AbortController().signal)) goals.push(goal);
  return goals;
}

it.each(['missing .takt', 'missing goals'])('reads an uninitialized goal area as empty: %s', async (state) => {
  if (state === 'missing goals') await mkdir(join(repository, '.takt'));
  expect(await read()).toEqual([]);
});

it.each([
  { status: 'created', executionStatus: 'active', finished: false },
  { status: 'created', executionStatus: 'paused', finished: false },
  { status: 'awaiting_merge', executionStatus: 'active', finished: false },
  { status: 'completed', executionStatus: 'active', finished: true },
  { status: 'created', executionStatus: 'aborted', finished: true },
] as const)('reads $status/$executionStatus without modifying its record', async ({ status, executionStatus, finished }) => {
  const goal = GoalSchema.parse({ ...goalRecord(), status, executionStatus,
    ...(status === 'created' ? {} : { completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      summary: 'finished', instructions: [], changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    } }),
  });
  const path = await save(goal);
  const before = await readFile(path, 'utf8');
  expect(await read()).toEqual([goal]);
  expect(isGoalFinished((await read())[0]!)).toBe(finished);
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('reads every goal beyond display limits and accepts a large valid record', async () => {
  const goals = Array.from({ length: 55 }, () => GoalSchema.parse({ ...goalRecord(), id: randomUUID() }));
  goals[54] = GoalSchema.parse({ ...goals[54], constraints: Array.from({ length: 5 }, () => 'x'.repeat(65_536)) });
  for (const goal of goals) await save(goal);
  expect(Buffer.byteLength(JSON.stringify(goals[54]))).toBeGreaterThan(256 * 1024);
  const saved = await read();
  expect(saved.map((goal) => goal.id).sort()).toEqual(goals.map((goal) => goal.id).sort());
  expect(saved.find((goal) => goal.id === goals[54]!.id)).toEqual(goals[54]);
});

it('rejects corrupt JSON instead of returning an empty result', async () => {
  const path = await save(GoalSchema.parse(goalRecord()));
  await writeFile(path, '{invalid');
  await expect(read()).rejects.toThrow();
});

it('rejects a saved identity that differs from the goal directory', async () => {
  await save(GoalSchema.parse(goalRecord()), randomUUID());
  await expect(read()).rejects.toThrow();
});

it('rejects a missing goal record', async () => {
  await mkdir(join(repository, '.takt', 'goals', goalRecord().id), { recursive: true });
  await expect(read()).rejects.toThrow();
});

it.each(['.takt', 'goals', 'goal directory', 'goal file'])('rejects a symbolic link at %s', async (location) => {
  const path = await save(GoalSchema.parse(goalRecord()));
  const original = location === '.takt' ? join(repository, '.takt') : location === 'goals'
    ? join(repository, '.takt', 'goals') : location === 'goal directory' ? join(path, '..') : path;
  const moved = join(repository, 'outside');
  await rename(original, moved);
  await symlink(moved, original);
  await expect(read()).rejects.toThrow();
});

it.each(['goal directory', 'goal file'])('rejects the wrong file type at %s', async (location) => {
  const goal = GoalSchema.parse(goalRecord());
  const path = await save(goal);
  if (location === 'goal file') {
    await rm(path);
    await mkdir(path);
  } else {
    await rm(join(path, '..'), { recursive: true });
    await writeFile(join(path, '..'), 'not a directory');
  }
  await expect(read()).rejects.toThrow();
});

it('propagates a private file read failure', async () => {
  await save(GoalSchema.parse(goalRecord()));
  const failure = Object.assign(new Error('unreadable'), { code: 'EACCES' });
  vi.spyOn(privateFiles, 'readEntirePrivateFile').mockRejectedValueOnce(failure);
  await expect(read()).rejects.toBe(failure);
});

it('refuses to publish a goal when an ancestor is replaced during reading', async () => {
  const goal = GoalSchema.parse(goalRecord());
  await save(goal);
  vi.spyOn(privateFiles, 'readEntirePrivateFile').mockImplementationOnce(async () => {
    const root = join(repository, '.takt', 'goals');
    await rename(root, join(repository, 'previous-goals'));
    await save(goal);
    return Buffer.from(JSON.stringify(goal));
  });
  await expect(read()).rejects.toThrow();
});

it('reads changed records again on a subsequent evaluation', async () => {
  const goal = GoalSchema.parse(goalRecord());
  await save(goal);
  expect(isGoalFinished((await read())[0]!)).toBe(false);
  await save({ ...goal, executionStatus: 'aborted' });
  expect(isGoalFinished((await read())[0]!)).toBe(true);
});
