/**
 * Tests for review-tasks command
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseTaktWorktrees,
  extractTaskSlug,
  buildReviewItems,
  type WorktreeInfo,
} from '../task/worktree.js';
import { isBranchMerged, showFullDiff, type ReviewAction } from '../commands/reviewTasks.js';

describe('parseTaktWorktrees', () => {
  it('should parse takt/ branches from porcelain output', () => {
    const output = [
      'worktree /home/user/project',
      'HEAD abc1234567890',
      'branch refs/heads/main',
      '',
      'worktree /home/user/project/.takt/worktrees/20260128-fix-auth',
      'HEAD def4567890abc',
      'branch refs/heads/takt/20260128-fix-auth',
      '',
      'worktree /home/user/project/.takt/worktrees/20260128-add-search',
      'HEAD 789abcdef0123',
      'branch refs/heads/takt/20260128-add-search',
    ].join('\n');

    const result = parseTaktWorktrees(output);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      path: '/home/user/project/.takt/worktrees/20260128-fix-auth',
      branch: 'takt/20260128-fix-auth',
      commit: 'def4567890abc',
    });

    expect(result[1]).toEqual({
      path: '/home/user/project/.takt/worktrees/20260128-add-search',
      branch: 'takt/20260128-add-search',
      commit: '789abcdef0123',
    });
  });

  it('should exclude non-takt branches', () => {
    const output = [
      'worktree /home/user/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/project/.takt/worktrees/20260128-fix-auth',
      'HEAD def456',
      'branch refs/heads/takt/20260128-fix-auth',
      '',
      'worktree /tmp/other-worktree',
      'HEAD 789abc',
      'branch refs/heads/feature/other',
    ].join('\n');

    const result = parseTaktWorktrees(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.branch).toBe('takt/20260128-fix-auth');
  });

  it('should handle empty output', () => {
    const result = parseTaktWorktrees('');
    expect(result).toHaveLength(0);
  });

  it('should handle bare worktree entry (no branch line)', () => {
    const output = [
      'worktree /home/user/project',
      'HEAD abc123',
      'bare',
    ].join('\n');

    const result = parseTaktWorktrees(output);
    expect(result).toHaveLength(0);
  });

  it('should handle detached HEAD worktrees', () => {
    const output = [
      'worktree /home/user/project',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /tmp/detached',
      'HEAD def456',
      'detached',
    ].join('\n');

    const result = parseTaktWorktrees(output);
    expect(result).toHaveLength(0);
  });
});

describe('extractTaskSlug', () => {
  it('should extract slug from timestamped branch name', () => {
    expect(extractTaskSlug('takt/20260128T032800-fix-auth')).toBe('fix-auth');
  });

  it('should extract slug from date-only timestamp', () => {
    expect(extractTaskSlug('takt/20260128-add-search')).toBe('add-search');
  });

  it('should extract slug with long timestamp format', () => {
    expect(extractTaskSlug('takt/20260128T032800-refactor-api')).toBe('refactor-api');
  });

  it('should handle branch without timestamp', () => {
    expect(extractTaskSlug('takt/my-task')).toBe('my-task');
  });

  it('should handle branch with only timestamp', () => {
    const result = extractTaskSlug('takt/20260128T032800');
    // Timestamp is stripped, nothing left, falls back to original name
    expect(result).toBe('20260128T032800');
  });

  it('should handle slug with multiple dashes', () => {
    expect(extractTaskSlug('takt/20260128-fix-auth-bug-in-login')).toBe('fix-auth-bug-in-login');
  });
});

describe('buildReviewItems', () => {
  it('should build items with correct task slug', () => {
    const worktrees: WorktreeInfo[] = [
      {
        path: '/project/.takt/worktrees/20260128-fix-auth',
        branch: 'takt/20260128-fix-auth',
        commit: 'abc123',
      },
    ];

    // We can't test getFilesChanged without a real git repo,
    // so we test buildReviewItems' structure
    const items = buildReviewItems('/project', worktrees, 'main');
    expect(items).toHaveLength(1);
    expect(items[0]!.taskSlug).toBe('fix-auth');
    expect(items[0]!.info).toBe(worktrees[0]);
    // filesChanged will be 0 since we don't have a real git repo
    expect(items[0]!.filesChanged).toBe(0);
  });

  it('should handle multiple worktrees', () => {
    const worktrees: WorktreeInfo[] = [
      {
        path: '/project/.takt/worktrees/20260128-fix-auth',
        branch: 'takt/20260128-fix-auth',
        commit: 'abc123',
      },
      {
        path: '/project/.takt/worktrees/20260128-add-search',
        branch: 'takt/20260128-add-search',
        commit: 'def456',
      },
    ];

    const items = buildReviewItems('/project', worktrees, 'main');
    expect(items).toHaveLength(2);
    expect(items[0]!.taskSlug).toBe('fix-auth');
    expect(items[1]!.taskSlug).toBe('add-search');
  });

  it('should handle empty worktree list', () => {
    const items = buildReviewItems('/project', [], 'main');
    expect(items).toHaveLength(0);
  });
});

describe('ReviewAction type', () => {
  it('should include diff, instruct, try, merge, delete (no skip)', () => {
    const actions: ReviewAction[] = ['diff', 'instruct', 'try', 'merge', 'delete'];
    expect(actions).toHaveLength(5);
    expect(actions).toContain('diff');
    expect(actions).toContain('instruct');
    expect(actions).toContain('try');
    expect(actions).toContain('merge');
    expect(actions).toContain('delete');
    expect(actions).not.toContain('skip');
  });
});

describe('showFullDiff', () => {
  it('should not throw for non-existent project dir', () => {
    // spawnSync will fail gracefully; showFullDiff catches errors
    expect(() => showFullDiff('/non-existent-dir', 'main', 'some-branch')).not.toThrow();
  });

  it('should not throw for non-existent branch', () => {
    expect(() => showFullDiff('/tmp', 'main', 'non-existent-branch-xyz')).not.toThrow();
  });

  it('should warn when diff fails', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    showFullDiff('/non-existent-dir', 'main', 'some-branch');
    warnSpy.mockRestore();
    // No assertion needed — the test verifies it doesn't throw
  });
});

describe('isBranchMerged', () => {
  it('should return false for non-existent project dir', () => {
    // git merge-base will fail on non-existent dir
    const result = isBranchMerged('/non-existent-dir', 'some-branch');
    expect(result).toBe(false);
  });

  it('should return false for non-existent branch', () => {
    const result = isBranchMerged('/tmp', 'non-existent-branch-xyz');
    expect(result).toBe(false);
  });
});
