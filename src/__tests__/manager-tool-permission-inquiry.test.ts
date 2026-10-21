import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeManagerPermissionApproval, resolveManagerPermissionContext, saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { answerInquiry, createInquiry } from '../infra/goals/inquiry.js';
import type { GoalQuestionInput } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ approval: vi.fn(), store: vi.fn(), list: vi.fn(), consume: vi.fn(),
  permissions: vi.fn(), workspace: vi.fn(), repository: vi.fn(), goal: vi.fn(), sha: vi.fn(), update: vi.fn() }));
vi.mock('../infra/goals/standalone-inquiries.js', () => ({ StandaloneInquiryStore: class {
  constructor(...args: unknown[]) { doubles.store(...args); }
  getOrCreateApproval = doubles.approval;
  list = doubles.list; consumeApproval = doubles.consume;
} }));
vi.mock('../features/manager/scopedPermissionStorage.js', () => ({ readScopedPermissions: doubles.permissions }));
vi.mock('../infra/config/global/workspaceRegistry.js', () => ({ readWorkspace: doubles.workspace }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.repository }));
vi.mock('../infra/goals/git-command.js', () => ({ resolveGoalBranchSha: doubles.sha }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.goal; update = doubles.update; } }));

const input = {
  request: { toolName: 'Write', toolInput: { token: 'alpha' }, cwd: '/operation' },
  reason: 'token=alpha の送信を確認してください', configDirectory: '/config',
  owner: { kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001' } as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  doubles.approval.mockImplementation(async (inquiry: GoalQuestionInput) => createInquiry(inquiry));
  doubles.list.mockResolvedValue([]);
  doubles.permissions.mockResolvedValue({ ok: true, files: [] });
  doubles.workspace.mockResolvedValue({ repositoryDirectories: [] });
  doubles.goal.mockResolvedValue(goalRecord());
  doubles.sha.mockResolvedValue('a'.repeat(40));
});

describe('resolveManagerPermissionContext', () => {
  const contextInput = { ...input, abortSignal: new AbortController().signal };

  it('distinguishes an empty workspace from a project resolution failure', async () => {
    const empty = await resolveManagerPermissionContext(contextInput);
    expect(empty.readErrors).toEqual([]);
    expect(doubles.repository).not.toHaveBeenCalled();
    expect(doubles.permissions).toHaveBeenCalledWith(expect.objectContaining({ projectDirectory: undefined }));
    doubles.workspace.mockResolvedValue({ repositoryDirectories: ['/project'] });
    doubles.repository.mockRejectedValue(new Error('repository resolution failed'));
    const failed = await resolveManagerPermissionContext(contextInput);
    expect(failed.readErrors).toEqual(['repository resolution failed']);
  });

  it('returns full related records and never selects a different operation', async () => {
    const related = createInquiry({ kind: 'approval', body: '確認', operation: {
      toolName: input.request.toolName, args: JSON.stringify(input.request.toolInput), cwd: input.request.cwd,
    } });
    const other = createInquiry({ kind: 'approval', body: '別操作',
      operation: { toolName: input.request.toolName, args: '{}', cwd: input.request.cwd } });
    doubles.list.mockResolvedValue([related, other]);
    const result = await resolveManagerPermissionContext(contextInput);
    expect(result.relatedInquiries).toEqual([related]);
    expect(result.candidate?.operation?.argsDigest).toBe(related.operation?.argsDigest);
  });

  it('preserves read failure causes as diagnostics without partial source text', async () => {
    doubles.permissions.mockResolvedValue({ ok: false, error: new Error('Cannot read /permissions', { cause: new Error('byte budget exceeded') }) });
    const result = await resolveManagerPermissionContext(contextInput);
    expect(result.readErrors).toEqual(['Cannot read /permissions: byte budget exceeded']);
    expect(result.scopedPermissions).toEqual([]);
  });

  it('does not produce a SHA-less operation when resolving the goal branch fails', async () => {
    doubles.sha.mockRejectedValue(new Error('branch unavailable'));
    const result = await resolveManagerPermissionContext({ ...contextInput,
      goal: { id: goalRecord().id, repositoryDirectory: '/project', constraints: [] } });
    expect(result.candidate).toBeUndefined();
    expect(result.relatedInquiries).toEqual([]);
    expect(result.readErrors).toEqual(['branch unavailable']);
  });
});

describe('consumeManagerPermissionApproval', () => {
  it('delegates standalone consumption to the current owner store', async () => {
    const approval = answerInquiry(createInquiry({ kind: 'approval', body: '確認', operation: {
      toolName: input.request.toolName, args: JSON.stringify(input.request.toolInput), cwd: input.request.cwd,
    } }), { decision: 'allow', scope: 'once' });
    await consumeManagerPermissionApproval({ ...input, approval });
    expect(doubles.store).toHaveBeenCalledWith(input.configDirectory, input.owner);
    expect(doubles.consume).toHaveBeenCalledWith(approval, expect.any(String));
  });

  it('consumes the matching goal record inside the store update', async () => {
    const approval = answerInquiry(createInquiry({ kind: 'approval', body: '確認',
      operation: { toolName: 'Write', args: '{}', cwd: '/project' }, targetSha: 'a'.repeat(40),
    }), { decision: 'allow' });
    const goal = { ...goalRecord(), questions: [approval] };
    doubles.update.mockImplementation(async (_id, transform) => transform(goal));
    await consumeManagerPermissionApproval({ ...input, approval,
      goal: { id: goal.id, repositoryDirectory: '/project', constraints: [] } });
    const transformed = doubles.update.mock.results[0]!.value;
    expect((await transformed).questions).toEqual([{ ...approval, consumedAt: expect.any(String) }]);
    expect(goal.questions).toEqual([approval]);
    doubles.update.mockImplementation(async (_id, transform) => transform({
      ...goal, questions: [{ ...approval, targetSha: 'b'.repeat(40) }],
    }));
    await expect(consumeManagerPermissionApproval({ ...input, approval,
      goal: { id: goal.id, repositoryDirectory: '/project', constraints: [] } })).rejects.toThrow();
  });
});

describe('saveManagerToolPermissionInquiry', () => {
  it('sanitizes the confirmation and gives the store raw arguments for digest generation', async () => {
    const saved = await saveManagerToolPermissionInquiry(input);
    expect(doubles.store).toHaveBeenCalledWith(input.configDirectory, input.owner);
    expect(doubles.approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval',
      body: 'token=[REDACTED] の送信を確認してください',
      operation: { toolName: 'Write', args: '{"token":"alpha"}', cwd: '/operation' },
    }));
    expect(saved).toMatchObject({ kind: 'approval', status: 'pending',
      body: expect.stringContaining('[REDACTED]'), operation: { args: expect.stringContaining('[REDACTED]') } });
    expect(saved.body).not.toContain('alpha');
    expect(saved.operation!.args).not.toContain('alpha');
  });

  it('saves a permission proposal describing the tool, target and execution directory without reintroducing secrets', async () => {
    const request = { ...input.request, toolInput: { file_path: 'out/result.txt', token: 'alpha' } };

    const saved = await saveManagerToolPermissionInquiry({ ...input, request });

    for (const value of ['Write', 'out/result.txt', '/operation']) {
      expect(saved).toHaveProperty('permissionProposal', expect.stringContaining(value));
    }
    expect(saved).toHaveProperty('permissionProposal', expect.not.stringContaining('alpha'));
    expect(saved).toHaveProperty('permissionProposal', expect.not.stringMatching(/[\r\n]/u));
    expect(saved.body).toBe('token=[REDACTED] の送信を確認してください');
  });

  it('returns the existing approval selected by the store', async () => {
    const previous = createInquiry({ kind: 'approval', body: '以前の確認',
      operation: { toolName: 'Write', args: JSON.stringify(input.request.toolInput), cwd: input.request.cwd } });
    doubles.approval.mockResolvedValue(previous);
    expect(await saveManagerToolPermissionInquiry(input)).toEqual(previous);
  });

  it('propagates serialization failure before reading or writing the store', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.value = cyclic;
    await expect(saveManagerToolPermissionInquiry({ ...input, request: { ...input.request, toolInput: cyclic } })).rejects.toThrow(TypeError);
    expect(doubles.approval).not.toHaveBeenCalled();
  });
});
