/**
 * Tests for postExecution.ts
 *
 * Verifies branching logic: existing PR → comment, no PR → create.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAutoCommitAndPush, mockPushBranch, mockFindExistingPr, mockCommentOnPr, mockCreatePullRequest, mockBuildPrBody } =
  vi.hoisted(() => ({
    mockAutoCommitAndPush: vi.fn(),
    mockPushBranch: vi.fn(),
    mockFindExistingPr: vi.fn(),
    mockCommentOnPr: vi.fn(),
    mockCreatePullRequest: vi.fn(),
    mockBuildPrBody: vi.fn(() => 'pr-body'),
  }));

vi.mock('../infra/task/index.js', () => ({
  autoCommitAndPush: (...args: unknown[]) => mockAutoCommitAndPush(...args),
}));

vi.mock('../infra/github/index.js', () => ({
  pushBranch: (...args: unknown[]) => mockPushBranch(...args),
  findExistingPr: (...args: unknown[]) => mockFindExistingPr(...args),
  commentOnPr: (...args: unknown[]) => mockCommentOnPr(...args),
  createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  buildPrBody: (...args: unknown[]) => mockBuildPrBody(...args),
}));

vi.mock('../infra/config/index.js', () => ({
  resolvePieceConfigValue: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { postExecutionFlow, resolveDraftPr } from '../features/tasks/execute/postExecution.js';
import { resolvePieceConfigValue } from '../infra/config/index.js';
import { confirm } from '../shared/prompt/index.js';

const mockResolvePieceConfigValue = vi.mocked(resolvePieceConfigValue);
const mockConfirm = vi.mocked(confirm);

const baseOptions = {
  execCwd: '/clone',
  projectCwd: '/project',
  task: 'Fix the bug',
  branch: 'task/fix-the-bug',
  baseBranch: 'main',
  shouldCreatePr: true,
  draftPr: false,
  pieceIdentifier: 'default',
};

describe('postExecutionFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: 'abc123' });
    mockPushBranch.mockReturnValue(undefined);
    mockCommentOnPr.mockReturnValue({ success: true });
    mockCreatePullRequest.mockReturnValue({ success: true, url: 'https://github.com/org/repo/pull/1' });
  });

  it('既存PRがない場合は createPullRequest を呼ぶ', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow(baseOptions);

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockCommentOnPr).not.toHaveBeenCalled();
  });

  it('既存PRがある場合は commentOnPr を呼び createPullRequest は呼ばない', async () => {
    mockFindExistingPr.mockReturnValue({ number: 42, url: 'https://github.com/org/repo/pull/42' });

    await postExecutionFlow(baseOptions);

    expect(mockCommentOnPr).toHaveBeenCalledWith('/project', 42, 'pr-body');
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('shouldCreatePr が false の場合は PR 関連処理をスキップする', async () => {
    await postExecutionFlow({ ...baseOptions, shouldCreatePr: false });

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCommentOnPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('commit がない場合は PR 関連処理をスキップする', async () => {
    mockAutoCommitAndPush.mockReturnValue({ success: true, commitHash: undefined });

    await postExecutionFlow(baseOptions);

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('branch がない場合は PR 関連処理をスキップする', async () => {
    await postExecutionFlow({ ...baseOptions, branch: undefined });

    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('draftPr: true の場合、createPullRequest に draft: true が渡される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({ ...baseOptions, draftPr: true });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ draft: true }),
    );
  });

  it('draftPr: false の場合、createPullRequest に draft: false が渡される', async () => {
    mockFindExistingPr.mockReturnValue(undefined);

    await postExecutionFlow({ ...baseOptions, draftPr: false });

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ draft: false }),
    );
  });
});

describe('resolveDraftPr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CLI オプション true が渡された場合は true を返す', async () => {
    const result = await resolveDraftPr(true, '/project');
    expect(result).toBe(true);
  });

  it('CLI オプション false が渡された場合は false を返す', async () => {
    const result = await resolveDraftPr(false, '/project');
    expect(result).toBe(false);
  });

  it('CLI オプションが未指定で config が true の場合は true を返す', async () => {
    mockResolvePieceConfigValue.mockReturnValue(true);

    const result = await resolveDraftPr(undefined, '/project');

    expect(result).toBe(true);
  });

  it('CLI オプション・config ともに未指定の場合はプロンプトを表示する', async () => {
    mockResolvePieceConfigValue.mockReturnValue(undefined);
    mockConfirm.mockResolvedValue(false);

    const result = await resolveDraftPr(undefined, '/project');

    expect(mockConfirm).toHaveBeenCalledWith('Create as draft?', true);
    expect(result).toBe(false);
  });
});
