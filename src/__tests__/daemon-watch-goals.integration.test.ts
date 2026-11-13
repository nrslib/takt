import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { EpicStore } from '../infra/epics/store.js';
import { abortEpic, completeEpic, getEpic, recordEpicVerificationResult, startEpicVerification } from '../infra/epics/index.js';
import { completedEpicGoal, epicRecord, verificationResultFor } from './helpers/epic-fixtures.js';

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

it.each([true, false])('observes runnable awaiting-merge work only for merge_task=%s', async (mergeTask) => {
  const goal = GoalSchema.parse({ ...goalRecord(), status: 'awaiting_merge',
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } } });
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  await writeFile(join(directory, '.takt', 'tasks.yaml'), `tasks:\n  - name: merge-pr-123\n    status: pending\n    goal_id: ${goal.id}\n    merge_task: ${mergeTask}\n    created_at: 2026-11-06T00:00:00.000Z\n    started_at: null\n    completed_at: null\n`);
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  const launches = await source.launches();
  expect(launches).toHaveLength(mergeTask ? 1 : 0);
  if (mergeTask) expect(launches[0]).toMatchObject({ repositoryDirectory: directory, runnablePending: true, autoRun: true });
  expect(errors).not.toHaveBeenCalled();
});

it('patrols linked active and failed merge work until only human merge waits remain', async () => {
  const base = goalRecord();
  const completion = { goalBranch: base.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } };
  const statuses = ['pending', 'running', 'completed', 'pending', 'pending', 'pending', 'pending', 'failed', 'exceeded', 'pr_failed'] as const;
  const goals: Goal[] = statuses.map(() => ({ ...base, id: randomUUID(), status: 'awaiting_merge', completion }));
  goals[5]!.executionStatus = 'paused';
  goals[6]!.executionStatus = 'aborted';
  for (const goal of goals) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  const tasks = goals.map((goal, index) => ({ name: `task-${index}`, goal_id: goal.id, merge_task: index !== 3,
    status: statuses[index],
    created_at: '2026-11-06T00:00:00.000Z', started_at: null, completed_at: null }));
  tasks[4]!.goal_id = randomUUID();
  const tasksPath = join(directory, '.takt', 'tasks.yaml');
  await writeFile(tasksPath, JSON.stringify({ tasks }));
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  expect([...(await source.patrolGoalIds(directory))].sort()).toEqual([0, 1, 7, 8, 9].map((index) => goals[index]!.id).sort());
  await writeFile(tasksPath, JSON.stringify({ tasks: tasks.map((task) => ({ ...task, status: 'completed' })) }));
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(errors).not.toHaveBeenCalled();
});

it('reports corrupt tasks and patrols ordinary active goals while excluding awaiting-merge goals', async () => {
  const active = goalRecord();
  const waiting: Goal = { ...active, id: randomUUID(), status: 'awaiting_merge', completion: {
    goalBranch: active.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  for (const goal of [active, waiting]) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  await writeFile(join(directory, '.takt', 'tasks.yaml'), 'tasks: [');
  const errors = vi.fn();
  const { source } = await watchSource(errors);

  expect(await source.patrolGoalIds(directory)).toEqual([active.id]);
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
});

async function savePendingEpic() {
  const globalConfigDirectory = join(directory, 'global');
  const workspace = await createWorkspace({ globalConfigDirectory, name: '結合確認待ち', repositoryDirectories: [] });
  await writeFile(join(globalConfigDirectory, 'workspaces', workspace.id, 'workspace.json'), JSON.stringify({
    ...workspace, repositoryDirectories: [directory],
  }));
  const goal = completedEpicGoal('b'.repeat(40), 'a'.repeat(40));
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  const member = { repositoryDirectory: directory, goalId: goal.id };
  const epic = { ...epicRecord(), workspaceId: workspace.id, members: [member], targets: [{ ...member, targetSha: goal.completion!.targetSha! }] };
  await new EpicStore(globalConfigDirectory, workspace.id).create(epic);
  return { globalConfigDirectory, workspaceId: workspace.id, epicId: epic.id,
    path: join(globalConfigDirectory, 'workspaces', workspace.id, 'epics', epic.id, 'epic.json') };
}

it('keeps a pending Epic active after all goals complete and becomes idle only after the Epic is aborted', async () => {
  const context = await savePendingEpic();
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect((await source.patrols()).filter((target) => target.workspaceId === context.workspaceId))
    .toMatchObject([{ epicIds: [context.epicId] }]);
  await abortEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId,
    epicId: context.epicId, reason: '確認を中止する' });
  expect(await source.hasWork(files)).toBe(false);
  expect((await source.patrols()).filter((target) => target.workspaceId === context.workspaceId)).toEqual([]);
  expect(await getEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId, epicId: context.epicId }))
    .toMatchObject({ status: 'aborted', members: [{ repositoryDirectory: directory, goalId: goalRecord().id }] });
  expect(errors).not.toHaveBeenCalled();
});

it('keeps the same pending Epic in daemon work and patrols until explicit completion and retains its evidence afterwards', async () => {
  execFileSync('git', ['init', '--quiet', directory]);
  const saved = await savePendingEpic();
  const context = { globalConfigDirectory: saved.globalConfigDirectory, workspaceId: saved.workspaceId, epicId: saved.epicId };
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  const patrols = async () => (await source.patrols()).filter((target) => target.workspaceId === context.workspaceId);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect(await patrols()).toMatchObject([{ epicIds: [context.epicId] }]);

  const run = await startEpicVerification(context);
  await recordEpicVerificationResult({ ...context, result: verificationResultFor(run) });
  expect(await source.hasWork(files)).toBe(true);
  expect(await patrols()).toMatchObject([{ epicIds: [context.epicId] }]);

  await completeEpic(context);
  expect(await source.hasWork(files)).toBe(false);
  expect(await patrols()).toEqual([]);
  expect(await getEpic(context)).toMatchObject({ status: 'completed', currentEvidence: { id: run.id },
    members: [{ repositoryDirectory: directory, goalId: goalRecord().id }], verificationRuns: [{ id: run.id, status: 'succeeded' }] });
  expect(errors).not.toHaveBeenCalled();
});

it('keeps all active Epic IDs and reports later failures without returning a partial workspace patrol', async () => {
  const context = await savePendingEpic();
  const later = { ...epicRecord(), id: '950e8400-e29b-41d4-a716-446655440000', workspaceId: context.workspaceId };
  await new EpicStore(context.globalConfigDirectory, context.workspaceId).create(later);
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  const workspacePatrols = async () => (await source.patrols()).filter((target) => target.workspaceId === context.workspaceId);
  expect(await workspacePatrols()).toMatchObject([{ epicIds: [context.epicId, later.id] }]);
  await abortEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId, epicId: later.id, reason: 'Stop later Epic' });
  expect(await workspacePatrols()).toMatchObject([{ epicIds: [context.epicId] }]);
  expect(await source.hasWork(files)).toBe(true);
  errors.mockClear();
  await writeFile(join(context.globalConfigDirectory, 'workspaces', context.workspaceId, 'epics', later.id, 'epic.json'), '{');
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
  expect(await workspacePatrols()).toEqual([]);
  expect(errors).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'invalid JSON', 'wrong workspace'] as const)('keeps the daemon active and reports an Epic with %s', async (failure) => {
  const context = await savePendingEpic();
  if (failure === 'missing') await rm(context.path);
  else if (failure === 'invalid JSON') await writeFile(context.path, '{broken');
  else await writeFile(context.path, JSON.stringify({ ...epicRecord(), workspaceId: randomUUID() }));
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
});
