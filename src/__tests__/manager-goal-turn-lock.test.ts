import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ acquire: vi.fn(), current: vi.fn(), release: vi.fn() }));
vi.mock('../infra/task/project-execution-lock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/project-execution-lock.js')>(),
  acquireExecutionLock: doubles.acquire, getProjectExecutionOwner: doubles.current,
}));
import { withGoalTurns } from '../infra/goals/turn-lock.js';
const first = '550e8400-e29b-41d4-a716-446655440000';
const second = '550e8400-e29b-41d4-a716-446655440001';
beforeEach(() => {
  vi.resetAllMocks();
  doubles.acquire.mockReturnValue({ owner: { ownerId: 'host-owner' }, release: doubles.release });
});
it('orders and deduplicates goal ownership and releases all leases when a turn fails', async () => {
  await expect(withGoalTurns('/project', [second, first, second], async (owners) => {
    expect(owners).toEqual({ [first]: 'host-owner', [second]: 'host-owner' });
    throw new Error('provider failed');
  })).rejects.toThrow();
  expect(doubles.acquire.mock.calls.map(([path]) => path)).toEqual([`/project/.takt/goals/${first}`, `/project/.takt/goals/${second}`]);
  expect(doubles.release).toHaveBeenCalledTimes(2);
});
it('allows a delegated MCP update only for its matching live owner token', async () => {
  doubles.current.mockReturnValue({ ownerId: 'host-owner' });
  await withGoalTurns('/project', [first], async () => {}, { [first]: 'host-owner' });
  expect(doubles.acquire).not.toHaveBeenCalled();
  expect(doubles.release).not.toHaveBeenCalled();
  await withGoalTurns('/project', [first], async () => {}, { [first]: 'other-owner' });
  expect(doubles.acquire).toHaveBeenCalledTimes(1);
});
it('does not acquire ownership after cancellation or for an invalid goal path', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(withGoalTurns('/project', [first], async () => {}, {}, controller.signal)).rejects.toThrow();
  await expect(withGoalTurns('/project', ['../outside'], async () => {})).rejects.toThrow();
  expect(doubles.acquire).not.toHaveBeenCalled();
});
