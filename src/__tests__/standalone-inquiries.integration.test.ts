import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerToolPermissionHandler } from '../features/manager/toolPermissionDecision.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';

vi.mock('../features/manager/toolPermissionJudge.js', () => ({
  judgeManagerToolPermission: async () => ({ decision: 'ask', reason: '出力先を確認してください' }),
}));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: { custom: false } }),
}));

let configDirectory: string;

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), 'takt-standalone-inquiries-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDirectory, { recursive: true, force: true });
});

function createHandler(owner: InquiryOwner, cwd: string) {
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
    owner,
    instruction: '出力先を確認する',
    abortSignal: new AbortController().signal,
    onDenial: () => {},
  });
}

async function createOwner(kind: InquiryOwner['kind'], name: string): Promise<InquiryOwner> {
  if (kind === 'workspace') {
    return {
      kind,
      workspaceId: name === 'first'
        ? '750e8400-e29b-41d4-a716-446655440001'
        : '750e8400-e29b-41d4-a716-446655440002',
    };
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
