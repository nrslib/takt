import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import type { GoalQuestionInput } from '../infra/goals/schema.js';

const doubles = vi.hoisted(() => ({ approval: vi.fn(), store: vi.fn() }));
vi.mock('../infra/goals/standalone-inquiries.js', () => ({ StandaloneInquiryStore: class {
  constructor(...args: unknown[]) { doubles.store(...args); }
  getOrCreateApproval = doubles.approval;
} }));

const input = {
  request: { toolName: 'Write', toolInput: { token: 'alpha' }, cwd: '/operation' },
  reason: 'token=alpha の送信を確認してください', configDirectory: '/config',
  owner: { kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440001' } as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  doubles.approval.mockImplementation(async (inquiry: GoalQuestionInput) => createInquiry(inquiry));
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
