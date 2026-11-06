import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WatchGoalReader } from '../features/daemon/watchers/goalReader.js';
import { readWatchGoals } from '../features/daemon/watchers/state.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { deferred } from './helpers/controlledDaemon.js';

let directory: string;
let reader: WatchGoalReader;
let source: FileDaemonWatchSource | undefined;
let conversations: DaemonConversations | undefined;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'takt-watch-goals-')));
  reader = new WatchGoalReader();
});
afterEach(async () => {
  await reader.close();
  await source?.close(); source = undefined;
  await conversations?.close(); conversations = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function watchSource(onError: (error: unknown) => void) {
  const globalDirectory = join(directory, 'global');
  await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: directory, command: 'manager', managerUsed: true });
  conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
    new DaemonNotifications(globalDirectory), async () => {}, onError);
  source = new FileDaemonWatchSource(conversations, async () => {}, onError);
  return { source, files: new DaemonPersistedFiles(globalDirectory) };
}

it('parses goal histories in a reusable worker and returns only observation data', async () => {
  const goal = { ...goalRecord(), createdAt: '2026-11-01T00:00:00Z', workLog: [...Array.from({ length: 200 }, () => ({
    id: randomUUID(), summary: 'history-content'.repeat(400), recordedAt: '2026-11-02T00:00:00Z',
  })), { id: randomUUID(), summary: 'patrol', kind: 'patrol', recordedAt: '2026-11-03T00:00:00Z' }] };
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  const text = JSON.stringify(goal);
  await writeFile(join(path, 'goal.json'), text);
  const parse = vi.spyOn(JSON, 'parse');
  const errors = vi.fn();
  for (const _attempt of [1, 2]) {
    const goals = [];
    for await (const value of readWatchGoals(directory, errors, reader)) goals.push(value);
    expect(goals).toMatchObject([{ id: goal.id, status: 'created', executionStatus: 'active' }]);
    expect(goals[0]).not.toHaveProperty('workLog');
  }
  expect(parse.mock.calls.some(([value]) => typeof value === 'string' && value.includes('history-content'))).toBe(false);
  expect(errors).not.toHaveBeenCalled();
});

it('keeps goals larger than 4 MiB eligible for patrol and daemon work', async () => {
  const goal = GoalSchema.parse({ ...goalRecord(), createdAt: '2026-11-01T00:00:00Z', workLog: Array.from({ length: 42 }, () => ({
    id: randomUUID(), summary: 'x'.repeat(100 * 1024), recordedAt: '2026-11-02T00:00:00Z',
  })) });
  const text = JSON.stringify(goal);
  expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), text);
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([goal.id]);
  expect(await source.hasWork(files)).toBe(true);
  const observed = await reader.read(directory, goal.id);
  expect(observed).not.toHaveProperty('workLog');
  expect(observed).not.toHaveProperty('objective');
  expect(errors).not.toHaveBeenCalled();
});

it.each(['legacy', 'structured'] as const)('collects %s PR retries and saves one limit notification for goals over 4 MiB through the worker', async (kind) => {
  const failure = { id: randomUUID(), recordedAt: '2026-11-06T00:00:00.000Z', goalSha: 'a'.repeat(40),
    error: 'Goal PR push failed: commit_refs' };
  const goal = GoalSchema.parse({ ...goalRecord(), status: 'awaiting_merge',
    workLog: [...Array.from({ length: 42 }, () => ({ id: randomUUID(), summary: 'retry-history'.repeat(10_000), recordedAt: failure.recordedAt })),
      { id: failure.id, summary: failure.error, recordedAt: failure.recordedAt }],
    ...(kind === 'structured' ? { pullRequestFailure: failure } : {}),
    completion: { goalBranch: goalRecord().branch, goalSha: failure.goalSha, targetBranch: 'main', summary: 'verified',
      humanChecks: 'Open result', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
  });
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  const text = JSON.stringify(goal);
  expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
  await writeFile(join(path, 'goal.json'), text);
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  const parse = vi.spyOn(JSON, 'parse');
  const stringify = vi.spyOn(JSON, 'stringify');
  const [target] = await source.pullRequestRetries();
  expect(target).toMatchObject({ goalId: goal.id, failureId: failure.id, expectedSha: failure.goalSha, error: failure.error,
    generation: createHash('sha256').update(JSON.stringify([failure.id, failure.goalSha, goal.branch, goal.integrationBranch, goal.completion])).digest('hex') });
  expect(await source.pullRequestRetry(target!)).toEqual(target);
  expect(await source.patrolGoalIds(directory)).toEqual([goal.id]);
  const observed = await reader.read(directory, goal.id);
  expect(observed.pullRequestRetry).toEqual({ failure, generation: target!.generation });
  expect(observed).not.toHaveProperty('workLog');
  expect(observed).not.toHaveProperty('completion');
  const options = { signal: new AbortController().signal, timeoutMs: 10_000 };
  expect(await source.notifyPullRequestRetryLimit(target!, options)).toBe(true);
  const notified = await reader.read(directory, goal.id);
  expect(notified.blockedNotifications).toHaveLength(1);
  expect(await source.notifyPullRequestRetryLimit(target!, options)).toBe(true);
  expect((await reader.read(directory, goal.id)).blockedNotifications).toEqual(notified.blockedNotifications);
  expect(parse.mock.calls.some(([value]) => typeof value === 'string' && value.includes('retry-history'))).toBe(false);
  expect(stringify.mock.calls.some(([value]) => typeof value === 'object' && value !== null && 'workLog' in value)).toBe(false);
  parse.mockRestore(); stringify.mockRestore();
  const saved = GoalSchema.parse(JSON.parse(await readFile(join(path, 'goal.json'), 'utf8')) as unknown);
  expect(saved).toEqual({ ...goal, notifications: [expect.objectContaining({ kind: 'blocked', severity: 'error' })] });
  expect(errors).not.toHaveBeenCalled();
});

it('rereads only the requested PR retry goal and reports its latest eligibility', async () => {
  const goal = GoalSchema.parse({ ...goalRecord(), status: 'awaiting_merge',
    pullRequestFailure: { id: randomUUID(), recordedAt: '2026-11-06T00:00:00.000Z', goalSha: 'a'.repeat(40), error: 'commit_refs' },
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified',
      humanChecks: 'Open result', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
  });
  const other = { ...goal, id: randomUUID() };
  for (const value of [goal, other]) {
    const path = join(directory, '.takt', 'goals', value.id);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), JSON.stringify(value));
  }
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  const target = (await source.pullRequestRetries()).find((value) => value.goalId === goal.id)!;
  // 他のゴールが壊れていても、対象の再確認では読み込まない。
  await writeFile(join(directory, '.takt', 'goals', other.id, 'goal.json'), '{invalid');
  const read = vi.spyOn(WatchGoalReader.prototype, 'read');
  expect(await source.pullRequestRetry(target)).toEqual(target);
  expect(read.mock.calls).toEqual([[directory, goal.id]]);
  read.mockClear();
  await writeFile(join(directory, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify({ ...goal, executionStatus: 'paused' }));
  expect(await source.pullRequestRetry(target)).toBeUndefined();
  expect(read.mock.calls).toEqual([[directory, goal.id]]);
  expect(errors).not.toHaveBeenCalled();
});

it.each(['goal', 'execution'] as const)('rechecks eligibility after waiting for the existing %s save lock', async (kind) => {
  const failure = { id: randomUUID(), recordedAt: '2026-11-06T00:00:00.000Z', goalSha: 'a'.repeat(40), error: 'commit_refs' };
  const goal = GoalSchema.parse({ ...goalRecord(), status: 'awaiting_merge', pullRequestFailure: failure,
    completion: { goalBranch: goalRecord().branch, goalSha: failure.goalSha, targetBranch: 'main', summary: 'verified',
      humanChecks: 'Open result', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
  });
  const path = join(directory, '.takt', 'goals', goal.id, 'goal.json');
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(goal));
  const lockPath = kind === 'goal' ? `${path}.lock` : join(directory, '.takt', 'goal-execution.lock');
  const options = { signal: new AbortController().signal, timeoutMs: 10_000 };
  const acquired = deferred<void>(); const release = deferred<void>(); const waiting = deferred<void>();
  const held = new FileAsyncLock().exclusive(lockPath, async () => { acquired.resolve(); await release.promise; }, options);
  await Promise.race([acquired.promise, held]);
  const exclusive = FileAsyncLock.prototype.exclusive;
  vi.spyOn(FileAsyncLock.prototype, 'exclusive').mockImplementation(function (this: FileAsyncLock, path, action, options) {
    if (path === lockPath) waiting.resolve();
    return exclusive.call(this, path, action, options);
  });
  const saving = reader.savePullRequestRetryLimit(directory, goal.id, failure.id, failure.goalSha, 'en', options);
  try {
    await waiting.promise;
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(goal));
    await writeFile(path, JSON.stringify({ ...goal, executionStatus: 'paused' }));
  } finally { release.resolve(); await held; }
  expect(await saving).toBe(false);
  expect(GoalSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)).toEqual({ ...goal, executionStatus: 'paused' });
});

it('reports invalid goals and continues observing valid goals', async () => {
  const valid = goalRecord();
  const invalidId = randomUUID();
  for (const [id, text] of [[valid.id, JSON.stringify(valid)], [invalidId, '{invalid']]) {
    const path = join(directory, '.takt', 'goals', id!);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), text!);
  }
  const errors = vi.fn();
  const ids = [];
  for await (const goal of readWatchGoals(directory, errors, reader)) ids.push(goal.id);
  expect(ids).toEqual([valid.id]);
  expect(errors).toHaveBeenCalledOnce();
  expect(await reader.read(directory, valid.id)).toMatchObject({ id: valid.id });
});

it.each(['missing', 'invalid JSON', 'invalid schema'] as const)('keeps the daemon alive and reports a goal with %s', async (failure) => {
  const goal = GoalSchema.parse({ ...goalRecord(), executionStatus: 'aborted' });
  const inactivePath = join(directory, '.takt', 'goals', goal.id);
  const unreadablePath = join(directory, '.takt', 'goals', randomUUID());
  await mkdir(inactivePath, { recursive: true });
  await writeFile(join(inactivePath, 'goal.json'), JSON.stringify(goal));
  await mkdir(unreadablePath);
  if (failure !== 'missing') await writeFile(join(unreadablePath, 'goal.json'), failure === 'invalid JSON' ? '{invalid' : '{}');
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
  await rm(unreadablePath, { recursive: true });
  expect(await source.hasWork(files)).toBe(false);
  expect(errors).toHaveBeenCalledOnce();
});

it('bounds pending worker requests and rejects reads after closing', async () => {
  const reads = Array.from({ length: 32 }, () => reader.read(directory, randomUUID()));
  await expect(reader.read(directory, randomUUID())).rejects.toThrow();
  const settled = Promise.allSettled(reads);
  await reader.close();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  await expect(reader.read(directory, randomUUID())).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking later goal reads or shutdown', async () => {
  const goal = goalRecord(); const fifoId = randomUUID();
  for (const id of [goal.id, fifoId]) await mkdir(join(directory, '.takt', 'goals', id), { recursive: true });
  execFileSync('mkfifo', [join(directory, '.takt', 'goals', fifoId, 'goal.json')]);
  await writeFile(join(directory, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify(goal));
  await expect(reader.read(directory, fifoId)).rejects.toThrow();
  expect(await reader.read(directory, goal.id)).toMatchObject({ id: goal.id });
  await reader.close();
}, 10_000);

it.each(['.takt', 'goals', 'goal', 'goal.json'] as const)('rejects a symlink at %s for both goal listing and direct reading', async (part) => {
  const goal = goalRecord();
  const foreign = join(directory, 'foreign');
  const repository = join(directory, 'registered');
  await mkdir(join(foreign, '.takt', 'goals', goal.id), { recursive: true });
  await writeFile(join(foreign, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify(goal));
  const segments = ['.takt', 'goals', goal.id, 'goal.json'];
  const index = part === '.takt' ? 0 : part === 'goals' ? 1 : part === 'goal' ? 2 : 3;
  await mkdir(join(repository, ...segments.slice(0, index)), { recursive: true });
  await symlink(join(foreign, ...segments.slice(0, index + 1)), join(repository, ...segments.slice(0, index + 1)),
    part === 'goal.json' ? 'file' : 'junction');
  await expect(reader.read(repository, goal.id)).rejects.toThrow();
  const errors = vi.fn();
  const listed = async () => {
    const goals = [];
    for await (const observed of readWatchGoals(repository, errors, reader)) goals.push(observed);
    return goals;
  };
  if (index < 2) await expect(listed()).rejects.toThrow();
  else {
    expect(await listed()).toEqual([]);
    if (index === 3) expect(errors).toHaveBeenCalledOnce();
  }
});
