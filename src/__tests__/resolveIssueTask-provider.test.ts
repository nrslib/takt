/**
 * Regression test for ARCH-001: resolveIssueTask must use getGitProvider()
 *
 * Tests the generic resolveIssueTask from git/format.ts which accepts
 * a getProvider callback, ensuring provider abstraction is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { resolveIssueTask } from '../infra/git/format.js';

describe('resolveIssueTask provider delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('イシュー参照を解決する際に getProvider コールバックを経由する', () => {
    // Given
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({ available: true }),
      fetchIssue: vi.fn().mockReturnValue({
        number: 42,
        title: 'Test Issue',
        body: 'Body text',
        labels: [],
        comments: [],
      }),
    };
    const getProvider = vi.fn().mockReturnValue(mockProvider);

    // When
    const result = resolveIssueTask('#42', getProvider);

    // Then
    expect(getProvider).toHaveBeenCalledOnce();
    expect(mockProvider.checkCliStatus).toHaveBeenCalledOnce();
    expect(mockProvider.fetchIssue).toHaveBeenCalledWith(42);
    expect(result).toContain('#42');
    expect(result).toContain('Test Issue');
  });

  it('CLI が利用不可の場合にプロバイダーのエラーメッセージをスローする', () => {
    // Given
    const mockProvider = {
      checkCliStatus: vi.fn().mockReturnValue({
        available: false,
        error: 'glab CLI is not authenticated',
      }),
      fetchIssue: vi.fn(),
    };
    const getProvider = vi.fn().mockReturnValue(mockProvider);

    // When / Then
    expect(() => resolveIssueTask('#10', getProvider)).toThrow('glab CLI is not authenticated');
    expect(mockProvider.fetchIssue).not.toHaveBeenCalled();
  });

  it('イシュー参照でない文字列はプロバイダーを呼び出さずそのまま返す', () => {
    // Given
    const getProvider = vi.fn();

    // When
    const result = resolveIssueTask('Fix the bug', getProvider);

    // Then
    expect(result).toBe('Fix the bug');
    expect(getProvider).not.toHaveBeenCalled();
  });
});
