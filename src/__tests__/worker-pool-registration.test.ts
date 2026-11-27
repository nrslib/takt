import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WorkerRegistry, workerTokenIdentity } from '../infra/worker-pool/workerRegistry.js';

const data = vi.hoisted(() => ({ bytes: undefined as Buffer | undefined }));
vi.mock('node:fs/promises', () => ({ rm: vi.fn(async () => {}) }));
vi.mock('../infra/daemon/privateFile.js', () => ({
  readPrivateFile: vi.fn(async () => data.bytes),
  writePrivateFile: vi.fn(async (_path: string, content: string) => { data.bytes = Buffer.from(content); }),
}));
vi.mock('../infra/daemon/lock.js', () => ({ FileAsyncLock: class {
  exclusive<T>(_path: string, action: () => Promise<T>) { return action(); }
} }));
beforeEach(() => { data.bytes = undefined; });

it('stores only the registration and token hash and authenticates after constructing a new registry', async () => {
  const registered = await new WorkerRegistry('/config').add('w1', 2);
  const saved = JSON.parse(data.bytes!.toString()) as Record<string, unknown>[];
  expect(saved).toEqual([{ name: 'w1', concurrency: 2, registrationGeneration: registered.registration.registrationGeneration,
    tokenHash: createHash('sha256').update(registered.token).digest('hex') }]);
  for (const record of saved) for (const value of Object.values(record)) expect(value).not.toBe(registered.token);
  const identity = workerTokenIdentity(registered.token);
  expect(identity).toEqual({ workerId: 'w1', registrationGeneration: registered.registration.registrationGeneration });
  expect(Buffer.from(registered.token.split('.')[1]!, 'base64url')).toHaveLength(32);
  await expect(new WorkerRegistry('/config').authorize(registered.token, async (worker) => worker.concurrency)).resolves.toBe(2);
});

it('authenticates the new generation and rejects the removed token after registering the same name again', async () => {
  const registry = new WorkerRegistry('/config');
  const first = await registry.add('w1', 2);
  await registry.remove('w1');
  const second = await registry.add('w1', 3);
  expect(second.registration.registrationGeneration).not.toBe(first.registration.registrationGeneration);
  expect(second.token).not.toBe(first.token);
  await expect(registry.authorize(second.token, async (worker) => worker.registrationGeneration))
    .resolves.toBe(second.registration.registrationGeneration);
  const consume = vi.fn();
  await expect(registry.authorize(first.token, consume)).rejects.toThrow(/removed/);
  expect(consume).not.toHaveBeenCalled();
});

it('rejects a tampered token before calling the authorized operation', async () => {
  const registry = new WorkerRegistry('/config');
  const first = await registry.add('w1', 1);
  const consume = vi.fn();
  await expect(registry.authorize(`${first.token.split('.')[0]}.invalid`, consume)).rejects.toThrow();
  await expect(registry.authorize('unregistered-token', consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it('refuses duplicate names and the builtin name without replacing the saved registration', async () => {
  const registry = new WorkerRegistry('/config');
  const first = await registry.add('w1', 2);
  await expect(registry.add('w1', 3)).rejects.toThrow();
  await expect(registry.add('builtin', 1)).rejects.toThrow();
  expect(await registry.list()).toEqual([first.registration]);
});
