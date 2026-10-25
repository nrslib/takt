import * as privateFiles from '../shared/utils/private-file.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { iteratePendingInquiries, listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { iterateManagerNotices, iterateManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import { basename } from 'node:path';
import { formatGoalNotification } from '../infra/goals/notifications.js';
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

it('preserves notice policy, equal-time ordering and complete multiline bodies', async () => {
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'manager:\n  notifications:\n    custom: false\n');
  const notifications = [1, 2, 3].map((index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    kind: index === 3 ? 'custom' as const : 'progress' as const, body: `Full notice ${index}\nline 2\nline 3\nline 4`, recordedAt: '2026-10-24T00:00:00.000Z' }));
  const goal = { ...goalRecord(), notifications };
  save(goal);
  const expected = notifications.slice(0, 2).map((notification) => ({
    id: notification.id, repositoryDirectory: repository, project: basename(repository), goalId: goal.id,
    objective: goal.objective, kind: notification.kind, recordedAt: notification.recordedAt,
    message: formatGoalNotification(goal, notification, 'en', basename(repository), 'tui', 'full'),
  }));
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  expect(await collect(iterateManagerNotices(assignment(), 'en'))).toEqual(expected);
  expect(expected.map(({ id }) => id)).toEqual(notifications.slice(0, 2).map(({ id }) => id));
  expect(expected.every(({ message }) => message.includes('line 4'))).toBe(true); expect(list).not.toHaveBeenCalled();
});

it('projects work logs and notifications sequentially with the existing IDs, formatting and initial suppression', async () => {
  const boundary = Date.parse('2026-10-24T00:00:01.000Z');
  const goal = { ...goalRecord(), workLog: [{ id: '650e8400-e29b-41d4-a716-446655440001',
    summary: 'old work', recordedAt: '2026-10-24T00:00:00.000Z' }], notifications: [{
    id: '650e8400-e29b-41d4-a716-446655440002', kind: 'progress' as const,
    body: 'current notice', recordedAt: '2026-10-24T00:00:02.000Z',
  }] };
  save(goal);
  const boundaries = new Map([[repository, boundary]]);
  const expected = [
    { id: JSON.stringify([goal.id, 'work-log', goal.workLog[0]!.id]), message: goal.id + ': old work', suppressInitialDisplay: true },
    { id: JSON.stringify([goal.id, 'notification', goal.notifications[0]!.id]),
      message: formatGoalNotification(goal, goal.notifications[0]!, 'en', basename(repository), 'tui') },
  ];
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  expect(await collect(iterateManagerDisplayEvents(assignment(), 'en', boundaries, boundary))).toEqual(expected);
  expect(expected[0]).toMatchObject({ id: JSON.stringify([goal.id, 'work-log', goal.workLog[0]!.id]), suppressInitialDisplay: true });
  expect(expected[1]).not.toHaveProperty('suppressInitialDisplay');
  expect(list).not.toHaveBeenCalled();
  const addedRepository = await collect(iterateManagerDisplayEvents(assignment(), 'en', new Map(), boundary));
  expect(addedRepository[0]).not.toHaveProperty('suppressInitialDisplay');
});

it('reads each goal once when independently ordering multiple inquiries or notices', async () => {
  const goals = [5, 6].map((prefix) => ({ ...goalRecord(), id: `${prefix}50e8400-e29b-41d4-a716-446655440000`,
    questions: Array.from({ length: 4 }, (_, index) => createInquiry({ body: `Question ${prefix}/${index}` })),
    notifications: Array.from({ length: 4 }, (_, index) => ({ id: `${prefix}50e8400-e29b-41d4-a716-44665544000${index}`,
      kind: 'progress' as const, body: `Notice ${index}`, recordedAt: '2026-10-24T00:00:00.000Z' })),
  }));
  for (const goal of goals) save(goal);
  const reads = vi.spyOn(privateFiles, 'readPrivateFileState');
  for (const source of [iteratePendingInquiries(directory, assignment()), iterateManagerNotices(assignment(), 'en')]) {
    reads.mockClear();
    const items = await collect<unknown>(source);
    expect(items).toHaveLength(8);
    expect(reads.mock.calls.map(([path]) => path).filter((path) => basename(path) === 'goal.json').sort())
      .toEqual(goals.map((goal) => join(repository, '.takt', 'goals', goal.id, 'goal.json')).sort());
  }
});
