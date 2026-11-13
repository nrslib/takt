import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addWorker, listWorkers, removeWorker, startWorker } from '../features/workerPool/workerCommands.js';

const doubles = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn(), remove: vi.fn(), run: vi.fn() }));
vi.mock('../infra/worker-pool/workerRegistry.js', () => ({ WorkerRegistry: class {
  add = doubles.add; list = doubles.list; remove = doubles.remove;
} }));
vi.mock('../features/workerPool/remoteWorker.js', () => ({ runRemoteWorker: doubles.run }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

it('prints the token once after registration succeeds and omits token material from listing', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  doubles.add.mockResolvedValue({ token: 'plain-token' });
  await addWorker('w1', 2);
  expect(doubles.add).toHaveBeenCalledExactlyOnceWith('w1', 2);
  expect(output).toHaveBeenCalledExactlyOnceWith('plain-token\n');
  output.mockClear();
  doubles.list.mockResolvedValue([{ name: 'w1', concurrency: 2, tokenHash: 'hidden-hash' }]);
  await listWorkers();
  expect(output).toHaveBeenCalledExactlyOnceWith('w1\t2\n');
  await removeWorker('w1'); expect(doubles.remove).toHaveBeenCalledExactlyOnceWith('w1');
});

it('does not print a token when registration persistence fails', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  doubles.add.mockRejectedValueOnce(new Error('Cannot save registration'));
  await expect(addWorker('w1', 2)).rejects.toThrow('Cannot save registration');
  expect(output).not.toHaveBeenCalled();
});

it('starts an executable worker and removes its signal handlers on exit', async () => {
  const listeners = process.listenerCount('SIGTERM');
  doubles.run.mockImplementation(async (input: Parameters<typeof import('../features/workerPool/remoteWorker.js').runRemoteWorker>[0]) => {
    expect(input).toMatchObject({ url: 'http://localhost', token: 'token' });
    expect(input.executor?.execute).toBeTypeOf('function');
    process.emit('SIGTERM');
    expect(input.signal.aborted).toBe(true);
  });
  await startWorker('http://localhost', 'token');
  expect(process.listenerCount('SIGTERM')).toBe(listeners);
});
