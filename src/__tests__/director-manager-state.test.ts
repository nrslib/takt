import { beforeEach, expect, it, vi } from 'vitest';
import { DirectorManagerStateStore } from '../infra/director/managerState.js';

const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../infra/daemon/privateFile.js', () => ({ readPrivateFile: files.read, writePrivateFile: files.write }));
const id = `manager-${'a'.repeat(64)}`;
beforeEach(() => vi.resetAllMocks());

it('treats a missing lifecycle record as an existing active manager', async () => {
  files.read.mockResolvedValue(undefined);
  expect(await new DirectorManagerStateStore('/config').isFired(id)).toBe(false);
});

it.each([true, false])('roundtrips fired=%s through the private file boundary and a new reader', async (fired) => {
  const signal = new AbortController().signal;
  await new DirectorManagerStateStore('/config').setFired(id, fired, signal);
  const [path, content, writeSignal] = files.write.mock.calls[0]!;
  expect(writeSignal).toBe(signal);
  files.read.mockResolvedValue(Buffer.from(content as string));
  expect(await new DirectorManagerStateStore('/config').isFired(id)).toBe(fired);
  expect(files.read).toHaveBeenCalledWith(path, expect.any(Number));
});

it.each(['{invalid', JSON.stringify({ managerId: id, fired: 'true' }),
  JSON.stringify({ managerId: `manager-${'b'.repeat(64)}`, fired: true })])('refuses invalid saved lifecycle state: %s', async (content) => {
  files.read.mockResolvedValue(Buffer.from(content));
  await expect(new DirectorManagerStateStore('/config').isFired(id)).rejects.toThrow();
});

it('rejects invalid manager identities before accessing files', async () => {
  const store = new DirectorManagerStateStore('/config');
  await expect(store.isFired('../outside')).rejects.toThrow();
  await expect(store.setFired('../outside', true, new AbortController().signal)).rejects.toThrow();
  expect(files.read).not.toHaveBeenCalled();
  expect(files.write).not.toHaveBeenCalled();
});

it('propagates storage errors without treating the manager as active', async () => {
  const failure = new Error('read failed');
  files.read.mockRejectedValue(failure);
  await expect(new DirectorManagerStateStore('/config').isFired(id)).rejects.toBe(failure);
});
