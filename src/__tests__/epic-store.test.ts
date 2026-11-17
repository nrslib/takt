import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpicStore } from '../infra/epics/store.js';
import { readdirSync } from 'node:fs';
import { applyEpicVerificationResult, beginEpicVerification, finishEpic } from '../infra/epics/state.js';
import {
  epicId, epicRecord, epicVerificationResult, epicWorkspaceId, secondGoalId,
  verificationResultFor, verificationRunId, verificationStartedAt,
} from './helpers/epic-fixtures.js';

const doubles = vi.hoisted(() => ({ create: vi.fn(), save: vi.fn(), read: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs', () => ({ readdirSync: vi.fn(() => []) }));
vi.mock('../shared/utils/private-file.js', () => ({
  ensurePrivateDirectory: vi.fn(), readPrivateFileState: doubles.read,
  writeNewPrivateFileWithMode: doubles.create, writePrivateFile: doubles.save,
  assertPrivateDirectoryReadSnapshot: vi.fn(), capturePrivateDirectoryReadSnapshot: vi.fn(),
}));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: doubles.stat }));

beforeEach(() => { vi.resetAllMocks(); });

function reverifiedEpic() {
  const targets = epicVerificationResult().targets;
  const epic = { ...epicRecord(), targets, members: targets.map(({ repositoryDirectory, goalId }) => ({ repositoryDirectory, goalId })) };
  const first = beginEpicVerification(epic, verificationRunId, verificationStartedAt);
  const verified = applyEpicVerificationResult(first.epic, verificationResultFor(first.run));
  return beginEpicVerification(verified, secondGoalId, verificationStartedAt);
}

describe('Epic storage validation boundary', () => {
  it('publishes a validated workspace record through the atomic creation boundary', async () => {
    const epic = epicRecord();
    expect(await new EpicStore('/configuration', epicWorkspaceId).create(epic)).toEqual(epic);
    expect(doubles.create).toHaveBeenCalledOnce();
    expect(JSON.parse(doubles.create.mock.calls[0]![1] as string)).toEqual(epic);
    expect(doubles.create.mock.calls[0]![2]).toBe(0o600);
  });

  it('rejects invalid ownership and completion before any file publication', async () => {
    const store = new EpicStore('/configuration', epicWorkspaceId);
    await expect(store.create({ ...epicRecord(), workspaceId: epicId })).rejects.toThrow();
    await expect(store.create({ ...epicRecord(), status: 'completed' })).rejects.toThrow();
    expect(() => store.save({ ...epicRecord(), status: 'completed' })).toThrow();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.save).not.toHaveBeenCalled();
  });

  it('does not replace missing records or fabricate an existing Epic', async () => {
    const store = new EpicStore('/configuration', epicWorkspaceId);
    await expect(store.get(epicId)).rejects.toThrow();
    expect(() => store.save(epicRecord())).toThrow();
    expect(await store.list()).toEqual({ epics: [], totalCount: 0, errors: [] });
    expect(doubles.save).not.toHaveBeenCalled();
  });

  it('retains only the requested page while validating and counting every record in order', async () => {
    const ids = [epicId, secondGoalId, verificationRunId].sort((a, b) => a.localeCompare(b));
    const records = ids.map((id, index) => ({ ...epicRecord(), id, objective: `Epic ${index}` }));
    doubles.stat.mockReturnValue({});
    vi.mocked(readdirSync).mockReturnValue([...ids, '.DS_Store'].reverse().map((name) => ({ name })) as unknown as ReturnType<typeof readdirSync>);
    doubles.read.mockImplementation((path: string) => ({ content: Buffer.from(JSON.stringify(records.find(({ id }) => path.includes(id)))) }));
    const store = new EpicStore('/configuration', epicWorkspaceId);
    expect(await store.list({ offset: 1, limit: 1 })).toEqual({ epics: [records[1]], totalCount: 3, errors: [] });
    expect(doubles.read.mock.calls.map(([path]) => ids.find((id) => (path as string).includes(id)))).toEqual(ids);
    expect(await store.list({ offset: 3, limit: 1 })).toEqual({ epics: [], totalCount: 3, errors: [] });
    expect((await store.list()).epics).toEqual(records);
  });

  it.each(['json', 'owner'])('reports a page-external %s failure instead of returning a successful partial list', async (failure) => {
    const ids = [epicId, secondGoalId].sort((a, b) => a.localeCompare(b));
    doubles.stat.mockReturnValue({});
    vi.mocked(readdirSync).mockReturnValue(ids.map((name) => ({ name })) as unknown as ReturnType<typeof readdirSync>);
    doubles.read.mockImplementation((path: string) => ({ content: Buffer.from(path.includes(ids[0]!)
      ? JSON.stringify({ ...epicRecord(), id: ids[0] })
      : failure === 'json' ? '{' : JSON.stringify({ ...epicRecord(), id: ids[1], workspaceId: secondGoalId })) }));
    const result = await new EpicStore('/configuration', epicWorkspaceId).list({ offset: 0, limit: 1 });
    expect(result.epics.map(({ id }) => id)).toEqual([ids[0]]);
    expect(result.errors).toEqual([{ epicId: ids[1], error: expect.any(Error) }]);
    expect(doubles.save).not.toHaveBeenCalled();
  });

  it.each(['create', 'save'] as const)('rejects completed records with a current running verification before %s publishes them', async (operation) => {
    const { epic } = reverifiedEpic();
    doubles.stat.mockReturnValue({});
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(epic)) });
    const store = new EpicStore('/configuration', epicWorkspaceId);
    expect(await store.get(epic.id)).toEqual(epic);
    const invalid = { ...epic, status: 'completed' as const };

    if (operation === 'create') await expect(store.create(invalid)).rejects.toThrow();
    else expect(() => store.save(invalid)).toThrow();

    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.save).not.toHaveBeenCalled();
    expect(await store.get(epic.id)).toEqual(epic);
  });

  it('rejects persisted completion with a current running verification without rewriting it', async () => {
    const { epic } = reverifiedEpic();
    doubles.stat.mockReturnValue({});
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify({ ...epic, status: 'completed' })) });
    await expect(new EpicStore('/configuration', epicWorkspaceId).get(epic.id)).rejects.toThrow();
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.save).not.toHaveBeenCalled();
  });

  it('publishes active re-verification and completed records after the running verification finishes', async () => {
    const { epic, run } = reverifiedEpic();
    doubles.stat.mockReturnValue({});
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(epic)) });
    const store = new EpicStore('/configuration', epicWorkspaceId);
    expect(await store.create(epic)).toEqual(epic);
    expect(store.save(epic)).toEqual(epic);
    expect(JSON.parse(doubles.save.mock.calls[0]![1] as string)).toEqual(epic);

    const completed = finishEpic(applyEpicVerificationResult(epic, verificationResultFor(run)));
    expect(await store.create(completed)).toEqual(completed);
    expect(store.save(completed)).toEqual(completed);
    expect(JSON.parse(doubles.create.mock.calls[1]![1] as string)).toEqual(completed);
    expect(JSON.parse(doubles.save.mock.calls[1]![1] as string)).toEqual(completed);
    doubles.read.mockReturnValue({ content: Buffer.from(JSON.stringify(completed)) });
    expect(await store.get(epic.id)).toEqual(completed);
  });
});
