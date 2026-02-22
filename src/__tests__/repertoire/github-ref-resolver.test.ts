/**
 * Unit tests for resolveRef in github-ref-resolver.ts.
 *
 * Covers:
 * - Returns specRef directly when provided
 * - Calls execGh with correct API path to retrieve default branch
 * - Returns trimmed branch name from execGh output
 * - Throws when execGh returns empty string
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveRef } from '../../features/repertoire/github-ref-resolver.js';

describe('resolveRef', () => {
  it('should return specRef directly when provided', () => {
    // Given: specRef is specified
    const execGh = vi.fn();

    // When: resolveRef is called with a specRef
    const result = resolveRef('main', 'owner', 'repo', execGh);

    // Then: returns specRef without calling execGh
    expect(result).toBe('main');
    expect(execGh).not.toHaveBeenCalled();
  });

  it('should return specRef even when it is a SHA', () => {
    // Given: specRef is a commit SHA
    const execGh = vi.fn();

    const result = resolveRef('abc1234def', 'owner', 'repo', execGh);

    expect(result).toBe('abc1234def');
    expect(execGh).not.toHaveBeenCalled();
  });

  it('should call execGh with correct API args when specRef is undefined', () => {
    // Given: specRef is undefined (omitted from spec)
    const execGh = vi.fn().mockReturnValue('main\n');

    // When: resolveRef is called without specRef
    resolveRef(undefined, 'nrslib', 'takt-fullstack', execGh);

    // Then: calls gh api with the correct path and jq filter
    expect(execGh).toHaveBeenCalledOnce();
    expect(execGh).toHaveBeenCalledWith([
      'api',
      '/repos/nrslib/takt-fullstack',
      '--jq', '.default_branch',
    ]);
  });

  it('should return trimmed branch name from execGh output', () => {
    // Given: execGh returns branch name with trailing newline
    const execGh = vi.fn().mockReturnValue('develop\n');

    // When: resolveRef is called
    const result = resolveRef(undefined, 'owner', 'repo', execGh);

    // Then: branch name is trimmed
    expect(result).toBe('develop');
  });

  it('should throw when execGh returns an empty string', () => {
    // Given: execGh returns empty output (API error or unexpected response)
    const execGh = vi.fn().mockReturnValue('');

    // When / Then: throws an error with the owner/repo in the message
    expect(() => resolveRef(undefined, 'owner', 'repo', execGh)).toThrow(
      'デフォルトブランチを取得できませんでした: owner/repo',
    );
  });

  it('should throw when execGh returns only whitespace', () => {
    // Given: execGh returns whitespace only
    const execGh = vi.fn().mockReturnValue('   \n');

    // When / Then: throws (whitespace trims to empty string)
    expect(() => resolveRef(undefined, 'myorg', 'myrepo', execGh)).toThrow(
      'デフォルトブランチを取得できませんでした: myorg/myrepo',
    );
  });
});
