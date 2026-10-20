import * as fsSync from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerToolPermissionHandler } from '../features/manager/toolPermissionDecision.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';

const doubles = vi.hoisted(() => ({ judge: vi.fn() }));
vi.mock('../features/manager/toolPermissionJudge.js', () => ({
  judgeManagerToolPermission: doubles.judge,
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof fsSync>() }));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: { custom: false } }),
}));

let configDirectory: string;

beforeEach(async () => {
  configDirectory = process.env.TAKT_CONFIG_DIR!;
  doubles.judge.mockReset().mockResolvedValue({ decision: 'ask', reason: '出力先を確認してください' });
});

afterEach(async () => {
  vi.restoreAllMocks();
});

function createHandler(owner: InquiryOwner | (() => InquiryOwner), cwd: string) {
  return createManagerToolPermissionHandler({
    plan: {
      resolution: { provider: 'claude-sdk', model: undefined, providerOptions: {} },
      language: 'ja',
      systemPrompt: 'judge',
      managerPersona: 'manager',
      managerPolicy: 'policy',
    },
    provider: 'claude-sdk',
    cwd,
    configDirectory,
    get owner() { return typeof owner === 'function' ? owner() : owner; },
    instruction: '出力先を確認する',
    abortSignal: new AbortController().signal,
    onDenial: () => {},
  });
}

async function createOwner(kind: InquiryOwner['kind'], name: string): Promise<InquiryOwner> {
  if (kind === 'workspace') {
    const owner = {
      kind,
      workspaceId: name === 'first'
        ? '750e8400-e29b-41d4-a716-446655440001'
        : '750e8400-e29b-41d4-a716-446655440002',
    };
    const directory = join(configDirectory, 'workspaces', owner.workspaceId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'workspace.json'), JSON.stringify({ id: owner.workspaceId, name, repositoryDirectories: [] }));
    return owner;
  }
  const repositoryDirectory = join(configDirectory, name);
  await mkdir(repositoryDirectory, { recursive: true });
  return { kind, repositoryDirectory };
}

describe('standalone inquiry persistence', () => {
  it.each(['workspace', 'repository'] as const)('reuses the pending approval for sequential %s requests', async (kind) => {
    const cwd = join(configDirectory, 'operation');
    await mkdir(cwd, { recursive: true });
    const owner = await createOwner(kind, 'first');
    const handler = createHandler(owner, cwd);
    const request = { toolName: 'Write', toolInput: { content: 'hello' }, cwd };

    const first = await handler(request);
    const second = await handler(request);
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const records = await store.listPending();
    const pending = await listPendingInquiries(configDirectory, { ...owner, repositoryDirectories: [] });

    expect(records).toHaveLength(1);
    expect(pending.errors).toEqual([]);
    expect(pending.inquiries.map(({ question }) => question.id)).toEqual([records[0]!.id]);
    expect(first).toMatchObject({ decision: 'deny', reason: expect.stringContaining(records[0]!.id) });
    expect(second).toMatchObject({ decision: 'deny', reason: expect.stringContaining(records[0]!.id) });
    expect(first).toHaveProperty('reason', expect.stringContaining('出力先を確認してください'));
    expect(second).toHaveProperty('reason', expect.stringContaining('出力先を確認してください'));
  });

  it.each(['workspace', 'repository'] as const)('keeps different operations separate for %s ownership', async (kind) => {
    const cwd = join(configDirectory, 'operation');
    await mkdir(cwd, { recursive: true });
    const owner = await createOwner(kind, 'first');
    const handler = createHandler(owner, cwd);
    const first = await handler({ toolName: 'Write', toolInput: { content: 'hello' }, cwd });
    const second = await handler({ toolName: 'Write', toolInput: { content: 'different output' }, cwd });
    const records = await new StandaloneInquiryStore(configDirectory, owner).listPending();

    expect(records).toHaveLength(2);
    expect(new Set(records.map(({ id }) => id)).size).toBe(2);
    expect(first.decision).toBe('deny');
    expect(second.decision).toBe('deny');
    const firstId = first.decision === 'deny' ? records.find(({ id }) => first.reason.includes(id))?.id : undefined;
    const secondId = second.decision === 'deny' ? records.find(({ id }) => second.reason.includes(id))?.id : undefined;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(firstId).not.toBe(secondId);
  });

  it.each(['workspace', 'repository'] as const)('separates %s owners in the shared config directory', async (kind) => {
    const owner = await createOwner(kind, 'first');
    const otherOwner = await createOwner(kind, 'second');
    const input = {
      kind: 'approval' as const,
      body: '出力先を確認してください',
      operation: { toolName: 'Write', args: '{"content":"hello"}', cwd: join(configDirectory, 'operation') },
    };

    const first = await new StandaloneInquiryStore(configDirectory, owner).getOrCreateApproval(input);
    const second = await new StandaloneInquiryStore(configDirectory, otherOwner).getOrCreateApproval(input);

    expect(first.id).not.toBe(second.id);
    expect(await new StandaloneInquiryStore(configDirectory, owner).list()).toEqual([first]);
    expect(await new StandaloneInquiryStore(configDirectory, otherOwner).list()).toEqual([second]);
    const firstPending = await listPendingInquiries(configDirectory, { ...owner, repositoryDirectories: [] });
    const secondPending = await listPendingInquiries(configDirectory, { ...otherOwner, repositoryDirectories: [] });
    expect(firstPending.inquiries.map(({ question }) => question.id)).toEqual([first.id]);
    expect(secondPending.inquiries.map(({ question }) => question.id)).toEqual([second.id]);
  });
});

describe('standalone approval reuse on a live handler', () => {
  it.each(['workspace', 'repository'] as const)('keeps a %s approval with its owner when the assignment changes', async (kind) => {
    const cwd = join(configDirectory, 'operation');
    await mkdir(cwd, { recursive: true });
    const firstOwner = await createOwner(kind, 'first');
    const secondOwner = await createOwner(kind, 'second');
    const firstStore = new StandaloneInquiryStore(configDirectory, firstOwner);
    const secondStore = new StandaloneInquiryStore(configDirectory, secondOwner);
    const request = { toolName: 'Write', toolInput: { content: 'hello' }, cwd };
    let owner = firstOwner;
    const handler = createHandler(() => owner, cwd);
    await handler(request);
    const [pending] = await firstStore.list();
    await firstStore.answer(pending!.id, { decision: 'allow', scope: kind === 'workspace' ? 'workspace' : 'project' });
    doubles.judge.mockClear();
    expect(await handler(request)).toEqual({ decision: 'allow' });
    expect(doubles.judge).not.toHaveBeenCalled();

    owner = secondOwner;
    expect(await handler(request)).toMatchObject({ decision: 'deny' });
    expect(await secondStore.listPending()).toHaveLength(1);
    expect((await firstStore.list())[0]!.consumedAt).toBeUndefined();
    owner = firstOwner;
    doubles.judge.mockClear();
    expect(await handler(request)).toEqual({ decision: 'allow' });
    expect(doubles.judge).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'repository'] as const)('does not allow a %s operation when consumption cannot be saved and retries from persisted state', async (kind) => {
    const cwd = join(configDirectory, 'operation');
    await mkdir(cwd, { recursive: true });
    const owner = await createOwner(kind, 'first');
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const request = { toolName: 'Write', toolInput: { content: 'hello' }, cwd };
    const previous = await store.create({ kind: 'approval', body: '許可しますか',
      operation: { toolName: request.toolName, args: JSON.stringify(request.toolInput), cwd } });
    await store.answer(previous.id, { decision: 'allow', scope: 'once' });
    const handler = createHandler(owner, cwd);
    doubles.judge.mockResolvedValue({ decision: 'allow' });
    const publication = vi.spyOn(fsSync, 'renameSync').mockImplementationOnce(() => { throw new Error('consumption save failed'); });
    expect(await handler(request)).toMatchObject({ decision: 'deny' });
    publication.mockRestore();
    expect((await store.list()).find(({ id }) => id === previous.id)?.consumedAt).toBeUndefined();
    expect(await handler(request)).toEqual({ decision: 'allow' });
    expect((await store.list()).find(({ id }) => id === previous.id)?.consumedAt).toEqual(expect.any(String));
  });

  it.each(['workspace', 'repository'] as const)('allows only one of two concurrent uses of the same %s once approval', async (kind) => {
    const cwd = join(configDirectory, 'operation');
    await mkdir(cwd, { recursive: true });
    const owner = await createOwner(kind, 'first');
    const store = new StandaloneInquiryStore(configDirectory, owner);
    const request = { toolName: 'Write', toolInput: { content: 'hello' }, cwd };
    const previous = await store.create({ kind: 'approval', body: '許可しますか',
      operation: { toolName: request.toolName, args: JSON.stringify(request.toolInput), cwd } });
    await store.answer(previous.id, { decision: 'allow', scope: 'once' });
    doubles.judge.mockResolvedValue({ decision: 'allow' });
    const handler = createHandler(owner, cwd);
    const results = await Promise.all([handler(request), handler(request)]);
    expect(results.filter(({ decision }) => decision === 'allow')).toHaveLength(1);
    expect(results.filter(({ decision }) => decision === 'deny')).toHaveLength(1);
    expect((await store.list()).find(({ id }) => id === previous.id)?.consumedAt).toEqual(expect.any(String));
  });
});
