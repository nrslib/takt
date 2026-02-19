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

import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';

const baseOptions = {
  execCwd: '/clone',
  projectCwd: '/project',
  task: 'Fix the bug',
  branch: 'task/fix-the-bug',
  baseBranch: 'main',
  shouldCreatePr: true,
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
});
