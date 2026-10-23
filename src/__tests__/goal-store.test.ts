import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), lstat: vi.fn(), readdir: vi.fn(),
  safe: vi.fn(), capture: vi.fn(), assertSnapshot: vi.fn(),
}));
vi.mock('node:fs', () => ({ readdirSync: doubles.readdir }));
vi.mock('../infra/fs/file-lock.js', () => ({ withFileLock: (_path: string, action: () => unknown) => action() }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../shared/utils/private-file.js', () => ({
  readPrivateFileState: doubles.read, writePrivateFile: doubles.write, ensurePrivateDirectory: vi.fn(),
  capturePrivateDirectoryReadSnapshot: doubles.capture, assertPrivateDirectoryReadSnapshot: doubles.assertSnapshot,
}));
vi.mock('../shared/utils/private-path-identity.js', () => ({
  assertSafePath: doubles.safe, lstatOrUndefined: doubles.lstat,
}));

describe('GoalStore validation and publication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.lstat.mockReturnValue({});
    doubles.read.mockReturnValue({ state: { exists: false } });
  });
  it('validates and publishes a new complete record without creating a lock', async () => {
    expect(await new GoalStore('/project').create(goalRecord())).toEqual(goalRecord());
    expect(doubles.write).toHaveBeenCalledOnce();
    expect(doubles.write.mock.calls[0]![0]).toBe(`/project/.takt/goals/${goalId}/goal.json`);
    expect(JSON.parse(doubles.write.mock.calls[0]![1])).toEqual(goalRecord());
  });
  it('refuses an existing record without publishing', async () => {
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(goalRecord())) });
    await expect(new GoalStore('/project').create(goalRecord())).rejects.toThrow();
    expect(doubles.write).not.toHaveBeenCalled();
  });
  it('validates updates after rereading the current record', async () => {
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(goalRecord())) });
    const entry = { id: '550e8400-e29b-41d4-a716-446655440001', summary: '検証を投入した', recordedAt: '2026-10-14T00:00:00Z' };
    const updated = await new GoalStore('/project').update(goalId, (goal) => ({ ...goal, workLog: [entry] }));
    expect(updated.workLog).toEqual([entry]);
    expect(JSON.parse(doubles.write.mock.calls[0]![1])).toEqual(updated);
    await expect(new GoalStore('/project').update(goalId, (goal) => ({ ...goal, id: '550e8400-e29b-41d4-a716-446655440001' }))).rejects.toThrow();
    expect(doubles.write).toHaveBeenCalledTimes(1);
  });
  it('rejects a saved ID that differs from its directory', async () => {
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' })) });
    await expect(new GoalStore('/project').get(goalId)).rejects.toThrow();
  });
  it.each([false, true])('notifies only after saving and permits retry after a save failure: %s', async (saveFails) => {
    const saved = goalRecord();
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(saved)) });
    const failure = new Error('goal save failed');
    if (saveFails) doubles.write.mockImplementationOnce(() => { throw failure; });
    const onSaved = vi.fn(() => {
      expect(JSON.parse(doubles.write.mock.calls.at(-1)![1]).executionStatus).toBe('paused');
      expect(doubles.write.mock.invocationCallOrder.at(-1)).toBeLessThan(onSaved.mock.invocationCallOrder.at(-1)!);
    });
    const update = () => new GoalStore('/project').update(goalId,
      (goal) => ({ ...goal, executionStatus: 'paused' }), onSaved);
    if (saveFails) {
      await expect(update()).rejects.toBe(failure);
      expect(onSaved).not.toHaveBeenCalled();
    }
    await expect(update()).resolves.toMatchObject({ executionStatus: 'paused' });
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it('reads the latest execution state synchronously through the same store without writing', () => {
    const store = new GoalStore('/project');
    const saved = goalRecord();
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(saved)) });
    expect(store.getSync(goalId)).toEqual(saved);
    const paused = { ...saved, executionStatus: 'paused' as const };
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(paused)) });
    expect(store.getSync(goalId)).toEqual(paused);
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(saved)) });
    expect(store.getSync(goalId)).toEqual(saved);
    expect(doubles.write).not.toHaveBeenCalled();
  });
  it('reads all published records and checks traversal identity', async () => {
    doubles.readdir.mockReturnValue([{ name: goalId }]);
    doubles.capture.mockReturnValue({ path: '/project/.takt/goals' });
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(goalRecord())) });
    expect(await new GoalStore('/project').list()).toEqual({ goals: [goalRecord()], errors: [] });
    expect(doubles.assertSnapshot).toHaveBeenCalledWith({ path: '/project/.takt/goals' });
  });
  it('projects and selects one validated record at a time without changing default listing', async () => {
    const other = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' };
    doubles.readdir.mockReturnValue([{ name: goalId }, { name: other.id }]);
    doubles.read.mockImplementation((file: string) => ({ content: Buffer.from(JSON.stringify(file.includes(other.id) ? other : goalRecord())) }));
    const project = vi.fn((goal: Goal) => goal.id === goalId ? { id: goal.id } : undefined);
    expect(await new GoalStore('/project').list(project)).toEqual({ goals: [{ id: goalId }], errors: [] });
    expect(project).toHaveBeenCalledTimes(2);
    expect(doubles.assertSnapshot).toHaveBeenCalledOnce();
    expect((await new GoalStore('/project').list()).goals).toEqual([goalRecord(), other]);
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
