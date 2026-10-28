import * as crypto from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { GoalQuestionSchema } from '../infra/goals/schema.js';

const io = vi.hoisted(() => ({
  read: vi.fn(), syncRead: vi.fn(), readdir: vi.fn(), opendir: vi.fn(), close: vi.fn(), mkdir: vi.fn(), realpath: vi.fn(), access: vi.fn(), write: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(), readFileSync: io.syncRead,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  readFile: io.read, readdir: io.readdir, opendir: io.opendir, mkdir: io.mkdir, realpath: io.realpath, access: io.access,
}));
vi.mock('../infra/config/project/sessionStore.js', () => ({ writeFileAtomic: io.write }));
vi.mock('../infra/goals/inquiry-lock.js', () => ({ withInquiryLock: (_directory: string, action: () => Promise<unknown>) => action() }));
vi.mock('../infra/fs/file-lock.js', () => ({ withFileLock: (_path: string, action: () => unknown) => action() }));
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
  io.syncRead.mockImplementation((path: string) => {
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

describe('standalone pending inquiry pages', () => {
  it.each([workspace, repository])('pages pending records in ID order for $kind without changing saved data', async (owner) => {
    const store = new StandaloneInquiryStore(config, owner);
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValueOnce(secondId).mockReturnValueOnce(firstId);
    const second = await store.create({ body: '後のID' });
    const first = await store.create({ body: '先のID' });
    const before = new Map(files);
    io.write.mockClear();

    expect(await store.listPendingPage(0, 1)).toEqual({ inquiries: [first], totalCount: 2 });
    expect(await store.listPendingPage(1, 1)).toEqual({ inquiries: [second], totalCount: 2 });
    expect(await store.listPendingPage(10, 1)).toEqual({ inquiries: [], totalCount: 2 });
    expect(files).toEqual(before);
    expect(io.write).not.toHaveBeenCalled();
  });

  it('counts the entire validated history while returning only the selected page', async () => {
    for (const index of [5, 3, 1, 4, 2, 0]) {
      const id = `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`;
      files.set(workspaceFile(id), JSON.stringify(GoalQuestionSchema.parse({
        id, body: '本文'.repeat(1000), status: index === 4 ? 'withdrawn' : 'pending',
      })));
    }
    const page = await new StandaloneInquiryStore(config, workspace).listPendingPage(1, 2);
    expect(page.totalCount).toBe(5);
    expect(page.inquiries.map(({ id }) => id)).toEqual([
      '650e8400-e29b-41d4-a716-000000000001', '650e8400-e29b-41d4-a716-000000000002',
    ]);
    expect(io.close).toHaveBeenCalledOnce();
    expect(io.readdir).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3].flatMap((attempt) =>
    (['none', 'during', 'before'] as const).map((withdrawal) => ({ attempt, withdrawal })),
  ))('keeps page records and counts consistent with $withdrawal withdrawal, attempt $attempt', async ({ withdrawal }) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const pending = await store.create({ body: '確認してください' });
    const events: string[] = [];
    const withdraw = async () => {
      await store.withdraw(pending.id, '不要になりました');
      events.push('withdrawal completed');
    };
    if (withdrawal === 'before') await withdraw();

    let resume!: () => void;
    let scanned!: () => void;
    const paused = new Promise<void>((resolve) => { scanned = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    io.opendir.mockResolvedValueOnce((async function* () {
      try {
        yield { name: `${firstId}.json`, isFile: () => true };
        events.push('record processed');
        scanned();
        await resumed;
      } finally { io.close(); }
    })());

    const listing = store.listPendingPage(0, 1);
    await paused;
    try {
      if (withdrawal === 'during') await withdraw();
    } finally { resume(); }
    const page = await listing;
    events.push('listing completed');
    const nextPage = await store.listPendingPage(0, 1);

    expect(events).toEqual(withdrawal === 'before'
      ? ['withdrawal completed', 'record processed', 'listing completed']
      : withdrawal === 'during'
        ? ['record processed', 'withdrawal completed', 'listing completed']
        : ['record processed', 'listing completed']);
    expect(nextPage).toEqual(withdrawal === 'none'
      ? { inquiries: [pending], totalCount: 1 } : { inquiries: [], totalCount: 0 });
    if (withdrawal === 'during') {
      expect([{ inquiries: [pending], totalCount: 1 }, { inquiries: [], totalCount: 0 }]).toContainEqual(page);
    } else {
      expect(page).toEqual(nextPage);
    }
    expect(JSON.parse(files.get(workspaceFile(firstId))!)).toEqual(withdrawal === 'none' ? pending : {
      ...pending, status: 'withdrawn', withdrawalReason: '不要になりました', withdrawnAt: now,
    });
  });

  it('returns an empty page for an empty or missing directory but propagates other open failures', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    expect(await store.listPendingPage(0, 1)).toEqual({ inquiries: [], totalCount: 0 });
    expect(io.close).toHaveBeenCalledOnce();
    io.opendir.mockRejectedValueOnce(missing());
    expect(await store.listPendingPage(0, 1)).toEqual({ inquiries: [], totalCount: 0 });
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    io.opendir.mockRejectedValueOnce(failure);
    await expect(store.listPendingPage(0, 1)).rejects.toBe(failure);
  });

  it.each([
    { id: secondId, body: '別のID', status: 'pending' },
    { id: firstId, body: '回答欠落', status: 'answered' },
  ])('rejects invalid saved records even outside the selected page: $status', async (record) => {
    files.set(workspaceFile(firstId), JSON.stringify(record));
    await expect(new StandaloneInquiryStore(config, workspace).listPendingPage(10, 1)).rejects.toThrow();
    expect(io.close).toHaveBeenCalledOnce();
    expect(io.write).not.toHaveBeenCalled();
  });

  it('validates records after the page is full instead of returning partial success', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create({ body: '有効な相談' });
    files.set(workspaceFile(secondId), '{');
    await expect(store.listPendingPage(0, 1)).rejects.toThrow();
    expect(io.close).toHaveBeenCalledOnce();
  });

  it('ignores non-record entries but rejects invalid JSON filenames', async () => {
    io.opendir.mockResolvedValueOnce((async function* () {
      yield { name: `${firstId}.json`, isFile: () => false };
      yield { name: 'temporary.tmp', isFile: () => true };
    })());
    const store = new StandaloneInquiryStore(config, workspace);
    expect(await store.listPendingPage(0, 1)).toEqual({ inquiries: [], totalCount: 0 });
    files.set(workspaceFile('invalid'), '{}');
    await expect(store.listPendingPage(0, 1)).rejects.toThrow();
    expect(io.read).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES'])('propagates %s while reading a saved page and closes the directory', async (code) => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create({ body: '相談' });
    const failure = Object.assign(new Error('read failed'), { code });
    io.read.mockRejectedValueOnce(failure);
    await expect(store.listPendingPage(0, 1)).rejects.toBe(failure);
    expect(io.close).toHaveBeenCalledOnce();
  });

  it('propagates iteration failures and closes the directory', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create({ body: '相談' });
    const failure = new Error('iteration failed');
    io.opendir.mockResolvedValueOnce((async function* () {
      try {
        yield { name: `${firstId}.json`, isFile: () => true };
        throw failure;
      } finally { io.close(); }
    })());
    await expect(store.listPendingPage(0, 1)).rejects.toBe(failure);
    expect(io.close).toHaveBeenCalledOnce();
  });
});

describe('standalone approval retrieval and creation', () => {
  const input = { kind: 'approval' as const, body: '出力先を確認してください',
    operation: { toolName: 'Write', args: '{"content":"hello"}', cwd: '/operation' } };

  it.each([workspace, repository])('reuses the saved ID for sequential $kind requests and after reopening', async (owner) => {
    const store = new StandaloneInquiryStore(config, owner);
    const first = await store.getOrCreateApproval(input);
    const second = await store.getOrCreateApproval(input);
    expect(first.id).toBe(firstId);
    expect(first.id).toBe(second.id);
    expect(files.size).toBe(1);
    expect(await new StandaloneInquiryStore(config, owner).getOrCreateApproval({ ...input, body: '再確認してください' })).toEqual(first);
    expect(await store.listPending()).toEqual([first]);
    expect(io.write).toHaveBeenCalledOnce();
  });

  it.each(['toolName', 'args', 'cwd', 'targetSha'] as const)('creates a distinct approval when %s differs', async (field) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const first = await store.getOrCreateApproval(input);
    const changed = field === 'targetSha' ? { ...input, targetSha: 'a'.repeat(40) }
      : { ...input, operation: { ...input.operation, [field]: field === 'toolName' ? 'Edit' : field === 'args' ? '{}' : '/other' } };
    const second = await store.getOrCreateApproval(changed);
    expect(second.id).not.toBe(first.id);
    expect(await store.listPending()).toEqual([first, second]);
  });

  it.each([secondId, firstId] as const)('preserves another operation when the candidate ID is %s', async (candidateId) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const previous = await store.create({ ...input, operation: { ...input.operation, args: '{"content":"previous"}' } });
    const before = new Map(files);
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(candidateId);

    if (candidateId === firstId) {
      await expect(store.getOrCreateApproval(input)).rejects.toThrow();
      expect(files).toEqual(before);
      expect(await store.list()).toEqual([previous]);
    } else {
      const created = await store.getOrCreateApproval(input);
      expect(created).toMatchObject({ id: secondId, kind: 'approval', status: 'pending',
        operation: { ...input.operation, argsDigest: crypto.createHash('sha256').update(input.operation.args).digest('hex') } });
      expect(files.get(workspaceFile(firstId))).toBe(before.get(workspaceFile(firstId)));
      expect(await store.list()).toEqual([previous, created]);
    }
  });

  it.each(['pending', 'answered', 'withdrawn'] as const)('handles a candidate ID matching a %s approval without replacing it', async (status) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const previous = await store.create(input);
    const saved = status === 'answered' ? await store.answer(previous.id, { decision: 'allow' })
      : status === 'withdrawn' ? await store.withdraw(previous.id) : previous;
    const before = new Map(files);
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValue(firstId);

    if (status === 'pending') expect(await store.getOrCreateApproval(input)).toEqual(saved);
    else await expect(store.getOrCreateApproval(input)).rejects.toThrow();

    expect(files).toEqual(before);
    expect(await store.list()).toEqual([saved]);
  });

  it('selects the first matching filename regardless of directory enumeration order and validates all records', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    vi.mocked(crypto.randomUUID).mockReset().mockReturnValueOnce(secondId).mockReturnValue(firstId);
    await store.create(input);
    const first = await store.create({ ...input, body: '以前の確認' });
    expect(await store.getOrCreateApproval(input)).toEqual(first);
    expect(io.read).toHaveBeenCalledTimes(2);
    expect(io.close).toHaveBeenCalledOnce();
    expect(files.size).toBe(2);
    expect(io.write).toHaveBeenCalledTimes(2);
  });

  it.each(['answered', 'withdrawn', 'question', 'operation_request'] as const)('does not reuse a matching %s inquiry', async (state) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const previous = await store.create({ ...input, kind: state === 'question' || state === 'operation_request' ? state : 'approval' });
    if (state === 'answered') await store.answer(previous.id, { decision: 'allow' });
    if (state === 'withdrawn') await store.withdraw(previous.id);
    const created = await store.getOrCreateApproval(input);
    expect(created.id).not.toBe(previous.id);
    expect(files.size).toBe(2);
    expect(created).toMatchObject({ kind: 'approval', status: 'pending' });
  });

  it.each(['{', JSON.stringify({ id: firstId, status: 'answered' }),
    JSON.stringify({ id: secondId, recipient: 'human', body: '別のID', status: 'pending' })])('rejects invalid saved data without saving: %s', async (serialized) => {
    files.set(workspaceFile(firstId), serialized);
    const before = new Map(files);
    await expect(new StandaloneInquiryStore(config, workspace).getOrCreateApproval(input)).rejects.toThrow();
    expect(files).toEqual(before);
    expect(io.write).not.toHaveBeenCalled();
  });

  it('validates history even after finding a matching approval', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.getOrCreateApproval(input);
    files.set(workspaceFile(secondId), '{');
    await expect(store.getOrCreateApproval(input)).rejects.toThrow();
    expect(io.write).toHaveBeenCalledOnce();
  });

  it('rejects invalid filenames before saving a new approval', async () => {
    files.set(workspaceFile('invalid'), '{}');
    await expect(new StandaloneInquiryStore(config, workspace).getOrCreateApproval(input)).rejects.toThrow();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each(['directory creation', 'directory read', 'file read', 'ID access', 'save'] as const)(
    'propagates %s failure and preserves saved records', async (stage) => {
      const store = new StandaloneInquiryStore(config, workspace);
      const previous = await store.create({ body: '既存の相談' });
      const before = new Map(files);
      const failure = Object.assign(new Error('storage failed'), { code: 'EACCES' });
      if (stage === 'directory creation') io.mkdir.mockRejectedValueOnce(failure);
      if (stage === 'directory read') io.opendir.mockRejectedValueOnce(failure);
      if (stage === 'file read') io.read.mockRejectedValueOnce(failure);
      if (stage === 'ID access') io.access.mockRejectedValueOnce(failure);
      if (stage === 'save') io.write.mockImplementationOnce(() => { throw failure; });
      await expect(store.getOrCreateApproval(input)).rejects.toBe(failure);
      expect(files).toEqual(before);
      expect(await store.list()).toEqual([previous]);
    },
  );

  it.each([true, false])('propagates iteration failure after a matching approval is %s and closes without saving', async (matching) => {
    const store = new StandaloneInquiryStore(config, workspace);
    await store.create(matching ? input : { body: '既存の相談' });
    const before = new Map(files);
    const failure = Object.assign(new Error('iteration failed'), { code: 'EACCES' });
    io.opendir.mockResolvedValueOnce((async function* () {
      try {
        yield { name: `${firstId}.json`, isFile: () => true };
        throw failure;
      } finally {
        io.close();
      }
    })());

    await expect(store.getOrCreateApproval(input)).rejects.toBe(failure);
    expect(files).toEqual(before);
    expect(io.write).toHaveBeenCalledOnce();
    expect(io.read).toHaveBeenCalledOnce();
    expect(io.close).toHaveBeenCalledOnce();
  });

  it.each(['answered', 'withdrawn'] as const)('creates a fresh approval after a %s approval', async (status) => {
    const store = new StandaloneInquiryStore(config, workspace);
    const previous = await store.getOrCreateApproval(input);
    const terminal = status === 'answered' ? await store.answer(previous.id, { decision: 'allow' }) : await store.withdraw(previous.id);
    const original = files.get(workspaceFile(previous.id));
    const next = await store.getOrCreateApproval(input);
    expect(next.id).not.toBe(previous.id);
    expect(await store.getOrCreateApproval({ ...input, body: '再確認' })).toEqual(next);
    expect(files.get(workspaceFile(previous.id))).toBe(original);
    expect(await store.list()).toEqual(expect.arrayContaining([terminal, next]));
    expect(await store.listPending()).toEqual([next]);
  });

  it('reuses pending approvals created with random IDs', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const previous = await store.create(input);
    expect(await store.getOrCreateApproval({ ...input, body: '再確認' })).toEqual(previous);
    expect(files.size).toBe(1);
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

describe('standalone approval consumption', () => {
  const operation = { toolName: 'Write', args: '{}', cwd: '/project' };

  it('reloads and consumes an approval once across concurrent store instances', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const pending = await store.create({ kind: 'approval', body: '確認', operation });
    const allowed = await store.answer(pending.id, { decision: 'allow', scope: 'once' });
    const results = await Promise.allSettled([
      store.consumeApproval(allowed, now),
      new StandaloneInquiryStore(config, workspace).consumeApproval(allowed, now),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await store.list()).toEqual([{ ...allowed, consumedAt: now }]);
    expect(allowed.consumedAt).toBeUndefined();
  });

  it('does not consume an approval whose persisted operation changed', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const pending = await store.create({ kind: 'approval', body: '確認', operation });
    const allowed = await store.answer(pending.id, { decision: 'allow' });
    const changed = GoalQuestionSchema.parse({ ...allowed, operation: { ...allowed.operation, cwd: '/other' } });
    files.set(workspaceFile(pending.id), JSON.stringify(changed));
    io.write.mockClear();
    await expect(store.consumeApproval(allowed, now)).rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([changed]);
  });

  it('leaves persisted approval available when publication fails', async () => {
    const store = new StandaloneInquiryStore(config, workspace);
    const pending = await store.create({ kind: 'approval', body: '確認', operation });
    const allowed = await store.answer(pending.id, { decision: 'allow' });
    io.write.mockImplementationOnce(() => { throw new Error('publication failed'); });
    await expect(store.consumeApproval(allowed, now)).rejects.toThrow();
    expect(await store.list()).toEqual([allowed]);
    expect(await store.consumeApproval(allowed, now)).toMatchObject({ consumedAt: now });
  });
});
