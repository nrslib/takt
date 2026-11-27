import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants as bufferConstants } from 'node:buffer';
import { DaemonEpicFiles } from '../infra/daemon/epicFiles.js';
import { epicRecord, secondGoalId, verificationRunId } from './helpers/epic-fixtures.js';

async function collect(files: DaemonEpicFiles, workspaceId: string) {
  const records = [];
  for await (const record of files.list(workspaceId)) records.push(record);
  return records;
}

const doubles = vi.hoisted(() => ({ lstat: vi.fn(), readdir: vi.fn(), read: vi.fn() }));
vi.mock('node:fs/promises', () => ({ lstat: doubles.lstat, readdir: doubles.readdir }));
vi.mock('../infra/daemon/privateFile.js', async (original) => ({ ...await original<typeof import('../infra/daemon/privateFile.js')>(), readPrivateFile: doubles.read }));
const stat = { dev: 1, ino: 1, isDirectory: () => true, isSymbolicLink: () => false };
const epic = epicRecord();

beforeEach(() => {
  vi.resetAllMocks();
  doubles.lstat.mockResolvedValue(stat);
  doubles.read.mockResolvedValue(Buffer.from(JSON.stringify(epic)));
  doubles.readdir.mockResolvedValue([{ name: epic.id, isDirectory: () => true, isSymbolicLink: () => false }]);
});

describe('Daemon Epic file reads', () => {
  it('reads and lists only records with matching identity without updating saved state', async () => {
    const files = new DaemonEpicFiles('/config');
    expect(await files.get(epic.workspaceId, epic.id)).toEqual(epic);
    expect(await collect(files, epic.workspaceId)).toEqual([epic]);
    expect(doubles.read).toHaveBeenCalledWith(`/config/workspaces/${epic.workspaceId}/epics/${epic.id}/epic.json`, bufferConstants.MAX_LENGTH);
  });
  it('rejects wrong owners, missing records, invalid IDs and symlink ancestors', async () => {
    const files = new DaemonEpicFiles('/config');
    doubles.read.mockResolvedValueOnce(Buffer.from(JSON.stringify({ ...epic, workspaceId: epic.id })));
    await expect(files.get(epic.workspaceId, epic.id)).rejects.toThrow('ownership');
    doubles.read.mockResolvedValueOnce(undefined);
    await expect(files.get(epic.workspaceId, epic.id)).rejects.toThrow('disappeared');
    await expect(files.get('../outside', epic.id)).rejects.toThrow();
    doubles.lstat.mockResolvedValueOnce({ ...stat, isSymbolicLink: () => true });
    await expect(files.get(epic.workspaceId, epic.id)).rejects.toThrow('directory');
  });
  it('rejects replacement of an ancestor during the read and invalid completion', async () => {
    const files = new DaemonEpicFiles('/config');
    doubles.read.mockImplementationOnce(async () => {
      doubles.lstat.mockResolvedValue({ ...stat, ino: 2 });
      return Buffer.from(JSON.stringify(epic));
    });
    await expect(files.get(epic.workspaceId, epic.id)).rejects.toThrow('changed');
    doubles.read.mockResolvedValueOnce(Buffer.from(JSON.stringify({ ...epic, status: 'completed' })));
    await expect(files.get(epic.workspaceId, epic.id)).rejects.toThrow();
  });
  it('allows an absent Epic directory but never hides a missing saved record', async () => {
    const files = new DaemonEpicFiles('/config');
    doubles.lstat.mockImplementation(async (path: string) => {
      if (path.endsWith('/epics')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return stat;
    });
    expect(await collect(files, epic.workspaceId)).toEqual([]);
    doubles.lstat.mockResolvedValue(stat);
    doubles.read.mockResolvedValue(undefined);
    await expect(collect(files, epic.workspaceId)).rejects.toThrow('disappeared');
  });

  it('reads one body per consumption request and does not prefetch on cancellation', async () => {
    const ids = [epic.id, secondGoalId, verificationRunId].sort((a, b) => a.localeCompare(b));
    doubles.readdir.mockResolvedValue([...ids].reverse().map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })));
    doubles.read.mockImplementation(async (path: string) => Buffer.from(JSON.stringify({ ...epic, id: ids.find((id) => path.includes(id)) })));
    const iterator = new DaemonEpicFiles('/config').list(epic.workspaceId);
    expect(doubles.read).not.toHaveBeenCalled();
    expect(await iterator.next()).toMatchObject({ done: false, value: { id: ids[0] } });
    expect(doubles.read).toHaveBeenCalledTimes(1);
    expect(await iterator.next()).toMatchObject({ done: false, value: { id: ids[1] } });
    expect(doubles.read).toHaveBeenCalledTimes(2);
    await iterator.return(undefined);
    expect(doubles.read).toHaveBeenCalledTimes(2);
  });

  it('does not hide later read failures or a changed directory at the end of enumeration', async () => {
    const ids = [epic.id, secondGoalId].sort((a, b) => a.localeCompare(b));
    doubles.readdir.mockResolvedValue(ids.map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })));
    doubles.read.mockImplementation(async (path: string) => path.includes(ids[0]!) ? Buffer.from(JSON.stringify({ ...epic, id: ids[0] })) : undefined);
    const files = new DaemonEpicFiles('/config');
    const iterator = files.list(epic.workspaceId);
    expect((await iterator.next()).value).toMatchObject({ id: ids[0] });
    await expect(iterator.next()).rejects.toThrow();
    doubles.readdir.mockResolvedValue([{ name: epic.id, isDirectory: () => true, isSymbolicLink: () => false }]);
    doubles.read.mockResolvedValue(Buffer.from(JSON.stringify(epic)));
    const replaced = files.list(epic.workspaceId);
    await replaced.next();
    doubles.lstat.mockResolvedValue({ ...stat, ino: 2 });
    await expect(replaced.next()).rejects.toThrow();
  });
});
