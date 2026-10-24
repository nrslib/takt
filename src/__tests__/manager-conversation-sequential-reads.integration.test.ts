import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { iteratePendingInquiries, listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { iterateManagerNotices, readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
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
  save({ ...goalRecord(), notifications });
  const expected = (await readManagerDisplayEvents(repository, 'en')).notices;
  const list = vi.spyOn(GoalStore.prototype, 'list').mockRejectedValue(new Error('forbidden array read'));
  expect(await collect(iterateManagerNotices(assignment(), 'en'))).toEqual(expected);
  expect(expected.map(({ id }) => id)).toEqual(notifications.slice(0, 2).map(({ id }) => id));
  expect(expected.every(({ message }) => message.includes('line 4'))).toBe(true); expect(list).not.toHaveBeenCalled();
});
