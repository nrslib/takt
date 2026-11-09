import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FilePatrolRecords } from '../infra/daemon/patrolRecords.js';
import { readPrivateFile, writePrivateFile } from '../infra/daemon/privateFile.js';

vi.mock('../infra/daemon/privateFile.js', () => ({ readPrivateFile: vi.fn(), writePrivateFile: vi.fn() }));

const directory = '/daemon-config';
const repository = '/workspace/a/service';
const timestamp = 1793923200000;
const path = join(directory, 'daemon-patrols', `${createHash('sha256').update(repository).digest('hex')}.json`);

beforeEach(() => { vi.resetAllMocks(); });

it('reads a saved timestamp through the private file boundary', async () => {
  vi.mocked(readPrivateFile).mockResolvedValue(Buffer.from(JSON.stringify({ lastQueued: timestamp })));
  const records = new FilePatrolRecords(directory);
  await expect(records.read(repository)).resolves.toBe(timestamp);
  expect(readPrivateFile).toHaveBeenCalledWith(path, expect.any(Number));
});

it('returns no timestamp when the private file is absent', async () => {
  vi.mocked(readPrivateFile).mockResolvedValue(undefined);
  await expect(new FilePatrolRecords(directory).read(repository)).resolves.toBeUndefined();
});

it('writes the acceptance timestamp to the repository private file', async () => {
  vi.mocked(writePrivateFile).mockResolvedValue(undefined);
  await new FilePatrolRecords(directory).write(repository, timestamp);
  expect(writePrivateFile).toHaveBeenCalledExactlyOnceWith(path, JSON.stringify({ lastQueued: timestamp }));
});
