import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskStore } from '../infra/task/store.js';
import { TaskDeletionService } from '../infra/task/taskDeletionService.js';
import { TasksFileSchema } from '../infra/task/schema.js';

vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: () => undefined }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  let state = TasksFileSchema.parse({ tasks: [{ name: 'remote', content: 'work', status: 'failed',
    failure: { error: 'failed' }, started_at: new Date().toISOString(), completed_at: new Date().toISOString(), created_at: new Date().toISOString() }] });
  const store = new TaskStore('/project');
  vi.spyOn(store, 'read').mockImplementation(() => structuredClone(state));
  const update = vi.spyOn(store, 'update').mockImplementation((mutate) => {
    const next = mutate(structuredClone(state));
    if (next !== undefined) state = TasksFileSchema.parse(next);
    return structuredClone(state);
  });
  return { service: new TaskDeletionService(store), store, update, state: () => state };
}

it('keeps the task until the worker ACK arrives and performs each update outside the waiting period', async () => {
  const f = fixture();
  const operation = f.service.deleteRemoteTask('remote', 'failed', new AbortController().signal);
  expect(f.state().tasks).toHaveLength(1);
  const deletionId = f.state().tasks[0]!.deletion!.id;
  await vi.advanceTimersByTimeAsync(300);
  expect(f.state().tasks).toHaveLength(1);
  expect(f.update).toHaveBeenCalledTimes(1);
  f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task,
    deletion: { ...task.deletion!, remote_ack: true } })) }), { deletionId });
  await vi.advanceTimersByTimeAsync(100);
  await operation;
  expect(f.state().tasks).toEqual([]);
  expect(f.update.mock.calls.at(-1)![1]).toEqual({ deletionId });
});

it('keeps the task and releases its deletion reservation after a missing ACK times out', async () => {
  const f = fixture();
  const result = f.service.deleteRemoteTask('remote', 'failed', new AbortController().signal).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toBeInstanceOf(Error);
  expect((await result as Error).message).toContain('acknowledge');
  expect(f.state().tasks).toHaveLength(1);
  expect(f.state().tasks[0]!.deletion).toBeUndefined();
});

it('keeps the task when the caller cancels before a worker ACK', async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = f.service.deleteRemoteTask('remote', 'failed', controller.signal).catch((error: unknown) => error);
  controller.abort(new Error('cancelled'));
  await vi.advanceTimersByTimeAsync(100);
  expect((await result as Error).message).toBe('cancelled');
  expect(f.state().tasks[0]!.deletion).toBeUndefined();
});

it('runs local cleanup only after ACK and keeps the task if that cleanup fails', async () => {
  const f = fixture();
  const cleanup = vi.fn(() => { throw new Error('local cleanup failed'); });
  const result = f.service.deleteRemoteTask('remote', 'failed', new AbortController().signal, cleanup).catch((error: unknown) => error);
  expect(cleanup).not.toHaveBeenCalled();
  f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, deletion: { ...task.deletion!, remote_ack: true } })) }));
  await vi.advanceTimersByTimeAsync(100);
  expect((await result as Error).message).toBe('local cleanup failed');
  expect(f.state().tasks).toHaveLength(1);
  expect(f.state().tasks[0]!.deletion).toBeUndefined();
});
