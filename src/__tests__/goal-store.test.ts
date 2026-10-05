import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), lstat: vi.fn(), readdir: vi.fn(),
  safe: vi.fn(), capture: vi.fn(), assertSnapshot: vi.fn(), exclusive: vi.fn(),
}));
vi.mock('node:fs', () => ({ readdirSync: doubles.readdir }));
vi.mock('../shared/utils/private-file.js', () => ({
  readPrivateFileState: doubles.read, writeNewPrivateFileWithMode: doubles.write,
  capturePrivateDirectoryReadSnapshot: doubles.capture, assertPrivateDirectoryReadSnapshot: doubles.assertSnapshot,
}));
vi.mock('../shared/utils/private-path-identity.js', () => ({
  assertSafePath: doubles.safe, lstatOrUndefined: doubles.lstat,
}));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusiveAsync: doubles.exclusive }));

describe('GoalStore validation and publication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.lstat.mockReturnValue({});
    doubles.read.mockReturnValue({ state: { exists: false } });
    doubles.exclusive.mockImplementation(async (_path: string, action: () => unknown) => action());
  });
  it('validates and publishes a new complete record inside the lock', async () => {
    expect(await new GoalStore('/project').create(goalRecord())).toEqual(goalRecord());
    expect(doubles.write).toHaveBeenCalledWith(`/project/.takt/goals/${goalId}/goal.json`, expect.any(String), 0o600);
    expect(JSON.parse(doubles.write.mock.calls[0]![1] as string)).toEqual(goalRecord());
  });
  it('refuses an existing record without publishing', async () => {
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(goalRecord())) });
    await expect(new GoalStore('/project').create(goalRecord())).rejects.toThrow();
    expect(doubles.write).not.toHaveBeenCalled();
  });
  it('rejects a saved ID that differs from its directory', async () => {
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' })) });
    await expect(new GoalStore('/project').get(goalId)).rejects.toThrow();
  });
  it('reads all published records and checks traversal identity', async () => {
    doubles.readdir.mockReturnValue([{ name: goalId }]);
    doubles.capture.mockReturnValue({ path: '/project/.takt/goals' });
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(goalRecord())) });
    expect(await new GoalStore('/project').list()).toEqual({ goals: [goalRecord()], errors: [] });
    expect(doubles.assertSnapshot).toHaveBeenCalledWith({ path: '/project/.takt/goals' });
  });
  it('ignores only an unpublished registration directory', async () => {
    doubles.readdir.mockReturnValue([{ name: goalId }]);
    expect(await new GoalStore('/project').list()).toEqual({ goals: [], errors: [] });
  });
  it.each([
    '{', JSON.stringify({ id: goalId }), 'null',
    JSON.stringify({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' }),
  ])('keeps healthy records before and after an invalid saved record %#', async (content) => {
    const before = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655439999' };
    const after = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', objective: '{' };
    doubles.readdir.mockReturnValue([{ name: after.id }, { name: goalId }, { name: before.id }]);
    doubles.read.mockImplementation((filePath: string) => ({
      content: Buffer.from(filePath.includes(before.id) ? JSON.stringify(before)
        : filePath.includes(after.id) ? JSON.stringify(after) : content),
    }));
    const result = await new GoalStore('/project').list();
    expect(result.goals).toEqual([before, after]);
    expect(result.errors).toEqual([{ goalId, error: expect.any(Error) }]);
    expect(result.errors[0]!.error.message).toMatch(/Invalid goal file/);
    expect(doubles.assertSnapshot).toHaveBeenCalledTimes(1);
  });
  it.each(['safe', 'capture', 'readdir', 'read', 'assertSnapshot'] as const)(
    'keeps %s access or identity failure as a whole-list failure', async (operation) => {
      doubles.readdir.mockReturnValue([{ name: goalId }]);
      const error = new Error('access or identity failure');
      doubles[operation].mockImplementation(() => { throw error; });
      await expect(new GoalStore('/project').list()).rejects.toBe(error);
    },
  );
  it('rejects an invalid directory ID as a whole-list failure', async () => {
    doubles.readdir.mockReturnValue([{ name: '../outside' }]);
    await expect(new GoalStore('/project').list()).rejects.toThrow();
    expect(doubles.read).not.toHaveBeenCalled();
  });
});
