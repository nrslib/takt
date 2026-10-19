import * as crypto from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { GoalQuestionSchema } from '../infra/goals/schema.js';

const io = vi.hoisted(() => ({
  read: vi.fn(), readdir: vi.fn(), opendir: vi.fn(), close: vi.fn(), mkdir: vi.fn(), realpath: vi.fn(), access: vi.fn(), write: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  readFile: io.read, readdir: io.readdir, opendir: io.opendir, mkdir: io.mkdir, realpath: io.realpath, access: io.access,
}));
vi.mock('../infra/config/project/sessionStore.js', () => ({ writeFileAtomic: io.write }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const config = '/isolated-config';
const workspace = { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' };
const repository = { kind: 'repository' as const, repositoryDirectory: '/repos/a/app' };
const firstId = '650e8400-e29b-41d4-a716-446655440001';
const secondId = '650e8400-e29b-41d4-a716-446655440002';
const now = '2026-10-19T01:00:00.000Z';
let files: Map<string, string>;

function missing() {
  return Object.assign(new Error('missing file'), { code: 'ENOENT' });
}

function workspaceFile(id: string) {
  return join(config, 'workspaces', workspace.workspaceId, 'inquiries', `${id}.json`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  files = new Map();
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstId).mockReturnValue(secondId);
  io.realpath.mockImplementation(async (path: string) => path === '/links/app' ? repository.repositoryDirectory : path);
  io.read.mockImplementation(async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw missing();
    return content;
  });
  io.access.mockImplementation(async (path: string) => { if (!files.has(path)) throw missing(); });
  io.readdir.mockImplementation(async (path: string, options?: { withFileTypes?: boolean }) => {
    const names = [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file));
    if (names.length === 0) throw missing();
    return options?.withFileTypes === true
      ? names.map((name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }))
      : names;
  });
  io.write.mockImplementation((path: string, content: string) => { files.set(path, content); });
  io.opendir.mockImplementation(async (path: string) => (async function* () {
    try {
      for (const file of files.keys()) {
        if (dirname(file) === path) yield { name: basename(file), isFile: () => true };
      }
    } finally {
      io.close();
    }
  })());
});
afterEach(() => vi.useRealTimers());

describe('standalone inquiry ownership and persistence', () => {
  it('stores a workspace inquiry in its config directory and restores the full shared record', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const input = { body: '  相談の本文\n', options: ['CSV', 'JSON'], recommendation: 'JSON', targetSha: 'a'.repeat(40) };
    const created = await store.create(input);
    expect(created).toMatchObject({ ...input, id: firstId, kind: 'question', recipient: 'human', status: 'pending', createdAt: now });
    expect([...files.keys()]).toEqual([workspaceFile(firstId)]);
    expect(GoalQuestionSchema.parse(JSON.parse(files.get(workspaceFile(firstId))!))).toEqual(created);
    expect(await new StandaloneInquiryStore(config, workspace).list()).toEqual([created]);
  });

  it('uses the SHA-256 of the canonical repository directory under project config storage', async () => {
    const store = new StandaloneInquiryStore(config, repository);
    const created = await store.create({ kind: 'operation_request', body: '認証を更新してください' });
    const hash = crypto.createHash('sha256').update(repository.repositoryDirectory).digest('hex');
    const path = join(config, 'projects', hash, 'inquiries', `${created.id}.json`);
    expect([...files.keys()]).toEqual([path]);
    expect(JSON.parse(files.get(path)!)).toEqual(created);
  });

  it('reads the same inquiry collection through aliases of one canonical repository', async () => {
    const created = await new StandaloneInquiryStore(config, repository).create({ body: '既存の相談' });
    const alias = { kind: 'repository' as const, repositoryDirectory: '/links/app' };
    expect(await new StandaloneInquiryStore(config, alias).list()).toEqual([created]);
  });

  it('keeps different repositories with the same basename separate', async () => {
    const other = { kind: 'repository' as const, repositoryDirectory: '/repos/b/app' };
    const first = await new StandaloneInquiryStore(config, repository).create({ body: '最初の相談' });
    const second = await new StandaloneInquiryStore(config, other).create({ body: '別の相談' });
    expect(await new StandaloneInquiryStore(config, repository).list()).toEqual([first]);
    expect(await new StandaloneInquiryStore(config, other).list()).toEqual([second]);
  });

  it('keeps workspace and repository ownership separate', async () => {
    const shared = await new StandaloneInquiryStore(config, workspace).create({ body: 'workspaceの相談' });
    const local = await new StandaloneInquiryStore(config, repository).create({ body: 'repositoryの相談' });
    expect(await new StandaloneInquiryStore(config, workspace).list()).toEqual([shared]);
    expect(await new StandaloneInquiryStore(config, repository).list()).toEqual([local]);
    expect(await new StandaloneInquiryStore(config, { ...workspace, workspaceId: '750e8400-e29b-41d4-a716-446655440002' }).list()).toEqual([]);
  });

  it('appends a fresh inquiry without replacing existing pending records', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const first = await store.create({ body: '既存の相談' });
    const original = files.get(workspaceFile(first.id));
    const second = await store.create({ body: '新しい相談' });
    expect(first.id).toBe(firstId);
    expect(second.id).toBe(secondId);
    expect(files.get(workspaceFile(first.id))).toBe(original);
    expect(await new StandaloneInquiryStore(config, workspace).list()).toEqual(expect.arrayContaining([first, second]));
    expect(files.size).toBe(2);
  });

  it('rejects generated ID collisions without overwriting an existing inquiry', async () => {
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(firstId);
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ body: '既存の相談' });
    const before = new Map(files);
    await expect(store.create({ body: '新しい相談' })).rejects.toThrow();
    expect(files).toEqual(before);
    expect(await store.list()).toEqual([created]);
  });

  it('reads files again instead of retaining a process-local collection', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ body: '既存の相談' });
    expect(await store.list()).toEqual([created]);
    const external = GoalQuestionSchema.parse({ ...created, id: secondId, body: '別の書き込み元からの相談' });
    files.set(workspaceFile(secondId), JSON.stringify(external));
    expect(await store.list()).toEqual(expect.arrayContaining([created, external]));
  });

  it('returns an empty collection when the owner has no saved inquiries', async () => {
    expect(await new StandaloneInquiryStore(config, workspace).list()).toEqual([]);
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each([
    '{',
    JSON.stringify({ id: firstId, body: '不正な保存形式', status: 'answered' }),
    JSON.stringify({ id: firstId, recipient: 'human', body: '認証を更新してください', kind: 'operation_request', status: 'answered',
      answer: { text: '実施しました', source: 'tui', answeredAt: now } }),
  ])('rejects malformed saved data instead of hiding it as an empty list: %s', async (serialized) => {
    files.set(workspaceFile(firstId), serialized);
    await expect(new StandaloneInquiryStore(config, workspace).list()).rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
  });

  it('propagates storage access failures rather than returning an empty list', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    io.readdir.mockRejectedValueOnce(failure);
    await expect(new StandaloneInquiryStore(config, workspace).list()).rejects.toThrow('permission denied');
  });
});

describe('standalone pending inquiry reads', () => {
  it.each([workspace, repository])('returns only pending inquiries after answers and withdrawals for $kind ownership', async (owner) => {
    const store = new StandaloneInquiryStore(config, owner);
    const pending = await store.create({ body: '形式を選んでください' });
    expect(await store.listPending()).toEqual([pending]);
    const answered = await store.answer(pending.id, 'JSON');
    expect(await store.listPending()).toEqual([]);
    const operation = await store.create({ kind: 'operation_request', body: '認証を更新してください' });
    expect(await store.listPending()).toEqual([operation]);
    const withdrawn = await store.withdraw(operation.id, '不要になりました');
    expect(await store.listPending()).toEqual([]);
    expect(await store.list()).toEqual([answered, withdrawn]);
  });

  it('scans completed history without dropping pending inquiries listed after it', async () => {
    for (let index = 0; index < 128; index++) {
      const id = `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`;
      const record = GoalQuestionSchema.parse({ id, recipient: 'human', body: '完了した相談', status: 'answered',
        answer: { text: 'JSON', source: 'tui', answeredAt: now } });
      files.set(workspaceFile(id), JSON.stringify(record));
    }
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValueOnce('650e8400-e29b-41d4-a716-446655440003').mockReturnValueOnce('650e8400-e29b-41d4-a716-446655440004');
    const store = new StandaloneInquiryStore(config, workspace);
    const first = await store.create({ body: '最初の未回答' });
    const second = await store.create({ body: '次の未回答' });

    expect(await store.listPending()).toEqual([first, second]);
    expect(io.read).toHaveBeenCalledTimes(130);
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list and closes an empty directory', async () => {
    expect(await new StandaloneInquiryStore(config, workspace).listPending()).toEqual([]);
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('reads saved inquiries without kind using the shared schema', async () => {
    files.set(workspaceFile(firstId), JSON.stringify({ id: firstId, recipient: 'human', body: '旧形式の相談', status: 'pending' }));
    expect(await new StandaloneInquiryStore(config, workspace).listPending()).toEqual([
      expect.objectContaining({ id: firstId, kind: 'question', status: 'pending' }),
    ]);
  });

  it('validates completed records before excluding them', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ body: '形式を選んでください' });
    const answered = await store.answer(created.id, 'JSON');
    expect(await store.listPending()).toEqual([]);
    const { answer: _answer, ...invalid } = answered;
    files.set(workspaceFile(created.id), JSON.stringify(invalid));
    await expect(store.listPending()).rejects.toThrow();
    expect(io.close).toHaveBeenCalledTimes(2);
  });

  it.each(['{', JSON.stringify({ id: secondId, recipient: 'human', body: '別のID', status: 'pending' })])(
    'rejects invalid JSON or a saved ID differing from its filename: %s', async (serialized) => {
      files.set(workspaceFile(firstId), serialized);
      await expect(new StandaloneInquiryStore(config, workspace).listPending()).rejects.toThrow();
      expect(io.close).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid inquiry filenames', async () => {
    files.set(workspaceFile('invalid'), '{}');
    await expect(new StandaloneInquiryStore(config, workspace).listPending()).rejects.toThrow();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('ignores non-files and non-JSON entries', async () => {
    io.opendir.mockResolvedValueOnce((async function* () {
      yield { name: `${firstId}.json`, isFile: () => false };
      yield { name: 'temporary.tmp', isFile: () => true };
    })());
    expect(await new StandaloneInquiryStore(config, workspace).listPending()).toEqual([]);
    expect(io.read).not.toHaveBeenCalled();
  });

  it('returns an empty list only for ENOENT while opening the directory', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    io.opendir.mockRejectedValueOnce(missing());
    expect(await store.listPending()).toEqual([]);
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    io.opendir.mockRejectedValueOnce(failure);
    await expect(store.listPending()).rejects.toBe(failure);
  });

  it.each(['ENOENT', 'EACCES'])('propagates a %s file read failure and closes the directory', async (code) => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create({ body: '読み込む相談' });
    const failure = Object.assign(new Error('read failed'), { code });
    io.read.mockRejectedValueOnce(failure);
    await expect(store.listPending()).rejects.toBe(failure);
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('propagates directory iteration failures and closes the directory', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create({ body: '読み込む相談' });
    const failure = missing();
    io.opendir.mockResolvedValueOnce((async function* () {
      try {
        yield { name: `${firstId}.json`, isFile: () => true };
        throw failure;
      } finally {
        io.close();
      }
    })());
    await expect(store.listPending()).rejects.toBe(failure);
    expect(io.read).toHaveBeenCalledTimes(1);
    expect(io.close).toHaveBeenCalledTimes(1);
  });
});

describe('standalone inquiry updates', () => {
  it.each([
    { kind: 'question' as const, answer: 'JSON', expected: { text: 'JSON' } },
    { kind: 'operation_request' as const, answer: { report: 'completed' as const }, expected: { text: '', report: 'completed' } },
    { kind: 'approval' as const, answer: { decision: 'allow' as const, scope: 'project' as const }, expected: { text: '', decision: 'allow', scope: 'project' } },
  ])('saves and restores a $kind answer using the shared answer contract', async ({ kind, answer, expected }) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ kind, body: '確認してください',
      ...(kind === 'approval' ? { operation: { toolName: 'Bash', args: '{}', cwd: repository.repositoryDirectory } } : {}) });
    await store.answer(created.id, answer);
    const [restored] = await new StandaloneInquiryStore(config, workspace).list();
    expect(restored).toMatchObject({ id: created.id, kind, status: 'answered', createdAt: now,
      answer: { ...expected, source: 'tui', answeredAt: now } });
    expect(GoalQuestionSchema.parse(restored)).toEqual(restored);
  });

  it('rejects a free-text operation report without changing the saved inquiry', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ kind: 'operation_request', body: '認証を更新してください' });
    const before = new Map(files);
    await expect(store.answer(created.id, '実施しました')).rejects.toThrow();
    expect(files).toEqual(before);
    expect(await store.list()).toEqual([created]);
  });

  it.each([undefined, '  不要になりました\n'])('persists withdrawal with optional reason %j', async (reason) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const created = await store.create({ body: '確認してください' });
    await store.withdraw(created.id, reason);
    const [restored] = await new StandaloneInquiryStore(config, workspace).list();
    expect(restored).toMatchObject({ id: created.id, status: 'withdrawn', withdrawnAt: now, createdAt: now });
    expect(restored?.withdrawalReason).toBe(reason);
    const before = new Map(files);
    await expect(store.answer(created.id, 'JSON')).rejects.toThrow();
    expect(files).toEqual(before);
    await store.withdraw(created.id, '別の理由');
    expect(await store.list()).toEqual([restored]);
  });

  it('rejects invalid creation before publishing any record', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    await expect(store.create({ kind: 'approval', body: '操作を許可しますか' })).rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it('keeps previously saved inquiries readable after publication failure', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const first = await store.create({ body: '既存の相談' });
    io.write.mockImplementationOnce(() => { throw new Error('publication failed'); });
    await expect(store.create({ body: '新しい相談' })).rejects.toThrow('publication failed');
    expect(await store.list()).toEqual([first]);
  });
});
