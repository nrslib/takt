import * as privateFiles from '../shared/utils/private-file.js';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { iteratePendingInquiries, listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { iterateTestDisplayEvents } from './helpers/manager-display-items.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import { basename } from 'node:path';
import { formatGoalNotification } from '../infra/goals/notifications.js';
import { conversationProjection } from '../features/daemon/conversationProjection.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { DaemonDisplayFiles } from '../infra/daemon/displayFiles.js';
import { DaemonEpicFiles } from '../infra/daemon/epicFiles.js';
import { EpicStore } from '../infra/epics/store.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { epicDefinition, epicRecord, secondGoalId } from './helpers/epic-fixtures.js';
import { createEpic, getEpic, updateEpicDefinition } from '../infra/epics/index.js';
import { buildTurnBusinessContext } from '../features/daemonTurn/turnContext.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
let directory: string;
let repository: string;
function assignment() { return { kind: 'repository' as const, repositoryDirectory: repository, repositoryDirectories: [repository] }; }
function save(goal: Goal) {
  const path = join(repository, '.takt', 'goals', goal.id); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'goal.json'), JSON.stringify(goal));
}
async function collect<T>(source: AsyncIterable<T>) { const values: T[] = []; for await (const value of source) values.push(value); return values; }
beforeEach(() => { directory = getGlobalConfigDir(); repository = join(directory, 'repository'); mkdirSync(repository); });
afterEach(() => vi.restoreAllMocks());

it('restores Epic definitions and retained history larger than 16 MiB saved by the public API', async () => {
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Large Epic', repositoryDirectories: [] });
  const owner = { globalConfigDirectory: directory, workspaceId: workspace.id };
  const objective = 'x'.repeat(8 * 1024 * 1024);
  const original = await createEpic({ ...owner, ...epicDefinition(), objective, reason: 'Create integration definition' });
  const path = join(directory, 'workspaces', workspace.id, 'epics', original.id, 'epic.json');
  expect(statSync(path).size).toBeGreaterThan(16 * 1024 * 1024);
  const files = new DaemonEpicFiles(directory);
  expect(await files.get(workspace.id, original.id)).toEqual(await getEpic({ ...owner, epicId: original.id }));
  expect(await collect(files.list(workspace.id))).toEqual([original]);

  const updated = await updateEpicDefinition({ ...owner, epicId: original.id,
    changes: { objective: `${objective} updated` }, reason: 'Retain the previous definition' });
  expect(statSync(path).size).toBeGreaterThan(16 * 1024 * 1024);
  const identity = { kind: 'workspace' as const, workspaceId: workspace.id };
  const project = () => collect(conversationProjection(new DaemonRouting(directory), new DaemonDisplayFiles(), identity, () => false));
  for (const _attempt of [1, 2]) {
    const items = await project();
    expect(items.filter((item) => item.kind === 'epic')).toEqual([
      { kind: 'epic', epic: updated, memberProgress: [], recovery: [] },
    ]);
    expect(items.filter((item) => item.kind === 'display_event')).toEqual([]);
  }
  const assignment = await new DaemonRouting(directory).display(identity);
  const businessContext = await buildTurnBusinessContext(assignment, null, directory);
  const context = JSON.parse(businessContext);
  expect(Buffer.byteLength(JSON.stringify(context.epics))).toBeLessThanOrEqual(16 * 1024);
  expect(context.epics).toMatchObject([{ epic: { id: updated.id, status: updated.status, revision: updated.revision,
    detailsTruncated: true, retrieval: expect.stringContaining('takt_get_epic') }, recovery: [] }]);
  expect(context.epics[0].epic.objective.length).toBeLessThan(updated.objective.length);
  expect(businessContext).not.toContain(updated.objective);
  const errors = vi.fn();
  const conversations = new DaemonConversations(new ConversationStateStore(directory), new DaemonRouting(directory),
    new DaemonNotifications(directory), async () => {}, errors);
  const source = new FileDaemonWatchSource(conversations, async () => {}, errors);
  const epicReads = vi.spyOn(DaemonEpicFiles.prototype, 'get');
  try {
    epicReads.mockClear();
    expect(await source.hasWork(new DaemonPersistedFiles(directory))).toBe(true);
    expect(epicReads).toHaveBeenCalledOnce();
    expect(await source.hasWork(new DaemonPersistedFiles(directory))).toBe(true);
    expect(epicReads).toHaveBeenCalledOnce();
    expect(await source.patrols()).toMatchObject([{ workspaceId: workspace.id, epicIds: [updated.id] }]);
    expect(epicReads).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await source.close();
    await conversations.close();
  }
  expect(await getEpic({ ...owner, epicId: original.id })).toEqual(updated);
});

it('projects each Epic on demand and preserves cancellation and later read failures', async () => {
  const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'Epics', repositoryDirectories: [] });
  const records = [epicRecord(), { ...epicRecord(), id: secondGoalId }]
    .map((epic) => ({ ...epic, workspaceId: workspace.id })).sort((a, b) => a.id.localeCompare(b.id));
  const store = new EpicStore(directory, workspace.id);
  for (const record of records) await store.create(record);
  const get = vi.spyOn(DaemonEpicFiles.prototype, 'get');
  const identity = { kind: 'workspace' as const, workspaceId: workspace.id };
  const read = () => conversationProjection(new DaemonRouting(directory), new DaemonDisplayFiles(), identity, () => false);
  const iterator = read();
  expect((await iterator.next()).value).toMatchObject({ kind: 'assignment' });
  expect(get).not.toHaveBeenCalled();
  expect((await iterator.next()).value).toMatchObject({ kind: 'epic', epic: records[0] });
  expect(get).toHaveBeenCalledTimes(1);
  expect((await iterator.next()).value).toMatchObject({ kind: 'epic', epic: records[1] });
  expect(get).toHaveBeenCalledTimes(2);
  expect((await iterator.next()).done).toBe(true);
  writeFileSync(join(directory, 'workspaces', workspace.id, 'epics', records[1]!.id, 'epic.json'), '{');
  let cancelled = false;
  const stopped = conversationProjection(new DaemonRouting(directory), new DaemonDisplayFiles(), identity, () => cancelled);
  await stopped.next();
  await stopped.next();
  get.mockClear();
  cancelled = true;
  expect((await stopped.next()).done).toBe(true);
  expect(get).not.toHaveBeenCalled();
  const failed = read();
  await failed.next();
  await failed.next();
  expect((await failed.next()).value).toMatchObject({ kind: 'display_event' });
  await expect(failed.next()).rejects.toThrow();
});

it('reports corrupt tasks while projecting goals and inquiries with awaiting-merge goals treated as human waits', async () => {
  const active = { ...goalRecord(), questions: [createInquiry({ body: 'Goal question' })] };
  const waiting: Goal = { ...goalRecord(), id: '650e8400-e29b-41d4-a716-446655440000', status: 'awaiting_merge', completion: {
    goalBranch: active.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  save(active); save(waiting);
  const standalone = await new StandaloneInquiryStore(directory, assignment()).create({ body: 'Standalone question' });
  const tasksPath = join(repository, '.takt', 'tasks.yaml');
  writeFileSync(tasksPath, 'tasks: [');

  const items = await collect(conversationProjection(new DaemonRouting(directory), new DaemonDisplayFiles(), assignment(), () => false));

  expect(items.filter((item) => item.kind === 'goal')).toEqual([active, waiting].map((goal) => ({ kind: 'goal', goal: {
    id: goal.id, objective: goal.objective, status: goal.status, executionStatus: goal.executionStatus,
    repositoryDirectory: repository, awaitingHumanMerge: goal.id === waiting.id,
  } })));
  expect(items.filter((item) => item.kind === 'inquiry').map((item) => item.inquiry.question.id).sort())
    .toEqual([active.questions[0]!.id, standalone.id].sort());
  expect(items.filter((item) => item.kind === 'display_event')).toEqual([{ kind: 'display_event', event: {
    id: JSON.stringify(['diagnostic', tasksPath]), message: expect.stringContaining(tasksPath),
  } }]);
});

it('reads only the demanded goal payload and reports corruption discovered before the next pull', async () => {
  const first = goalRecord(); const second = { ...first, id: '650e8400-e29b-41d4-a716-446655440000' };
  save(first); save(second);
  const iterator = new GoalStore(repository).iterate();
  expect((await iterator.next()).value).toEqual(first);
  writeFileSync(join(repository, '.takt', 'goals', second.id, 'goal.json'), '{broken');
  await expect(iterator.next()).rejects.toThrow('Invalid goal file');
  await iterator.return(undefined);
});

it('cancels a read before the next corrupt goal without materializing a full list', async () => {
  const first = goalRecord(); save(first);
  const second = { ...first, id: '650e8400-e29b-41d4-a716-446655440000' }; save(second);
  writeFileSync(join(repository, '.takt', 'goals', second.id, 'goal.json'), '{broken');
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  const iterator = new GoalStore(repository).iterate();
  expect((await iterator.next()).value).toEqual(first);
  expect(await iterator.return(undefined)).toMatchObject({ done: true });
  expect(list).not.toHaveBeenCalled();
});

it('retains inquiry ordering and full values without either goal or standalone array reads', async () => {
  const questions = [3, 1, 2].map((time) => ({ ...createInquiry({ body: `Question ${time}`, options: ['CSV', 'JSON'] }),
    createdAt: `2026-10-24T00:00:0${time}.000Z` }));
  save({ ...goalRecord(), questions });
  await new StandaloneInquiryStore(directory, assignment()).create({ body: 'Standalone' });
  const expected = (await listPendingInquiries(directory, assignment())).inquiries;
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  const standalone = vi.spyOn(StandaloneInquiryStore.prototype, 'listPending').mockRejectedValue(new Error('forbidden array read'));
  expect(await collect(iteratePendingInquiries(directory, assignment()))).toEqual(expected);
  expect(list).not.toHaveBeenCalled(); expect(standalone).not.toHaveBeenCalled();
});

it('projects notifications sequentially with the existing IDs, formatting and startup exclusion while hiding work logs', async () => {
  const boundary = Date.parse('2026-10-24T00:00:01.000Z');
  const goal = { ...goalRecord(), workLog: [{ id: '650e8400-e29b-41d4-a716-446655440001',
    summary: 'old work', recordedAt: '2026-10-24T00:00:00.000Z' }], notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440002', kind: 'progress' as const,
    body: 'current notice', recordedAt: '2026-10-24T00:00:02.000Z',
  }] };
  save(goal);
  const expected = [
    { id: JSON.stringify([repository, goal.id, 'notification', goal.notifications[0]!.id]),
      message: formatGoalNotification(goal, goal.notifications[0]!, 'en', basename(repository), 'tui') },
  ];
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  expect(await collect(iterateTestDisplayEvents(assignment(), 'en', boundary))).toEqual(expected);
  expect(list).not.toHaveBeenCalled();
  const unbounded = await collect(iterateTestDisplayEvents(assignment(), 'en', -Infinity));
  expect(unbounded).toEqual(expected);
  expect(await new GoalStore(repository).get(goal.id)).toEqual(goal);
});

it('reads each goal once when independently ordering multiple inquiries or display events', async () => {
  const goals = [5, 6].map((prefix) => ({ ...goalRecord(), id: `${prefix}50e8400-e29b-41d4-a716-446655440000`,
    questions: Array.from({ length: 4 }, (_, index) => createInquiry({ body: `Question ${prefix}/${index}` })),
    notifications: Array.from({ length: 4 }, (_, index) => ({ id: `${prefix}50e8400-e29b-41d4-a716-44665544000${index}`,
      kind: 'progress' as const, body: `Notice ${index}`, recordedAt: '2026-10-24T00:00:00.000Z' })),
  }));
  for (const goal of goals) save(goal);
  const reads = vi.spyOn(privateFiles, 'readPrivateFileState');
  for (const source of [iteratePendingInquiries(directory, assignment()), iterateTestDisplayEvents(assignment(), 'en', -Infinity)]) {
    reads.mockClear();
    const items = await collect<unknown>(source);
    expect(items).toHaveLength(8);
    expect(reads.mock.calls.map(([path]) => path).filter((path) => basename(path) === 'goal.json').sort())
      .toEqual(goals.map((goal) => join(repository, '.takt', 'goals', goal.id, 'goal.json')).sort());
  }
});
