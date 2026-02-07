/**
 * Tests for confirmAndCreateWorktree (CLI clone confirmation flow)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
  selectOptionWithDefault: vi.fn(),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'main'),
}));

vi.mock('../infra/task/clone.js', () => ({
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
}));

vi.mock('../infra/task/autoCommit.js', () => ({
  autoCommitAndPush: vi.fn(),
}));

vi.mock('../infra/task/summarize.js', () => ({
  summarizeTaskName: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  header: vi.fn(),
  status: vi.fn(),
  setLogLevel: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
  initDebugLogger: vi.fn(),
  setVerboseConsole: vi.fn(),
  getDebugLogFile: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  initGlobalDirs: vi.fn(),
  initProjectDirs: vi.fn(),
  loadGlobalConfig: vi.fn(() => ({ logLevel: 'info' })),
  getEffectiveDebugConfig: vi.fn(),
}));

vi.mock('../infra/config/paths.js', () => ({
  clearPersonaSessions: vi.fn(),
  getCurrentPiece: vi.fn(() => 'default'),
  isVerboseMode: vi.fn(() => false),
}));

vi.mock('../infra/config/loaders/pieceLoader.js', () => ({
  listPieces: vi.fn(() => []),
}));

vi.mock('../shared/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/constants.js')>();
  return {
    ...actual,
    DEFAULT_PIECE_NAME: 'default',
  };
});

vi.mock('../infra/github/issue.js', () => ({
  isIssueReference: vi.fn((s: string) => /^#\d+$/.test(s)),
  resolveIssueTask: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForUpdates: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import { createSharedClone } from '../infra/task/clone.js';
import { summarizeTaskName } from '../infra/task/summarize.js';
import { info } from '../shared/ui/index.js';
import { confirmAndCreateWorktree } from '../features/tasks/index.js';

const mockConfirm = vi.mocked(confirm);
const mockCreateSharedClone = vi.mocked(createSharedClone);
const mockSummarizeTaskName = vi.mocked(summarizeTaskName);
const mockInfo = vi.mocked(info);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confirmAndCreateWorktree', () => {
  it('should return original cwd when user declines clone creation', async () => {
    // Given: user says "no" to clone creation
    mockConfirm.mockResolvedValue(false);

    // When
    const result = await confirmAndCreateWorktree('/project', 'fix-auth');

    // Then
    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockCreateSharedClone).not.toHaveBeenCalled();
    expect(mockSummarizeTaskName).not.toHaveBeenCalled();
  });

  it('should create shared clone and return clone path when user confirms', async () => {
    // Given: user says "yes" to clone creation
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('fix-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-fix-auth',
      branch: 'takt/20260128T0504-fix-auth',
    });

    // When
    const result = await confirmAndCreateWorktree('/project', 'fix-auth');

    // Then
    expect(result.execCwd).toBe('/project/../20260128T0504-fix-auth');
    expect(result.isWorktree).toBe(true);
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('fix-auth', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'fix-auth',
    });
  });

  it('should display clone info when created', async () => {
    // Given
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('my-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-my-task',
      branch: 'takt/20260128T0504-my-task',
    });

    // When
    await confirmAndCreateWorktree('/project', 'my-task');

    // Then
    expect(mockInfo).toHaveBeenCalledWith(
      'Clone created: /project/../20260128T0504-my-task (branch: takt/20260128T0504-my-task)'
    );
  });

  it('should call confirm with default=true', async () => {
    // Given
    mockConfirm.mockResolvedValue(false);

    // When
    await confirmAndCreateWorktree('/project', 'task');

    // Then
    expect(mockConfirm).toHaveBeenCalledWith('Create worktree?', true);
  });

  it('should summarize Japanese task name to English slug', async () => {
    // Given: Japanese task name, AI summarizes to English
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('add-auth');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-add-auth',
      branch: 'takt/20260128T0504-add-auth',
    });

    // When
    await confirmAndCreateWorktree('/project', '認証機能を追加する');

    // Then
    expect(mockSummarizeTaskName).toHaveBeenCalledWith('認証機能を追加する', { cwd: '/project' });
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      worktree: true,
      taskSlug: 'add-auth',
    });
  });

  it('should show generating message when creating clone', async () => {
    // Given
    mockConfirm.mockResolvedValue(true);
    mockSummarizeTaskName.mockResolvedValue('test-task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-test-task',
      branch: 'takt/20260128T0504-test-task',
    });

    // When
    await confirmAndCreateWorktree('/project', 'テストタスク');

    // Then
    expect(mockInfo).toHaveBeenCalledWith('Generating branch name...');
  });

  it('should skip prompt when override is false', async () => {
    const result = await confirmAndCreateWorktree('/project', 'task', false);

    expect(result.execCwd).toBe('/project');
    expect(result.isWorktree).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('should skip prompt when override is true and still create clone', async () => {
    mockSummarizeTaskName.mockResolvedValue('task');
    mockCreateSharedClone.mockReturnValue({
      path: '/project/../20260128T0504-task',
      branch: 'takt/20260128T0504-task',
    });

    const result = await confirmAndCreateWorktree('/project', 'task', true);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(result.isWorktree).toBe(true);
  });
});
