import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => {
  throw new Error('ACP task context validation must not spawn child processes');
});

import {
  assertValidAcpTaskContext,
  extractAcpTaskContextFromText,
  mergeAcpTaskContext,
} from '../app/acp/taskContext.js';

describe('ACP task context', () => {
  it('should extract explicit branch, base branch, and PR number from prompt text', () => {
    const result = extractAcpTaskContextFromText(
      'この内容をタスクに積んで branch: takt/123/fix-acp base_branch: main PR #123',
    );

    expect(result).toEqual({
      branch: 'takt/123/fix-acp',
      baseBranch: 'main',
      prNumber: 123,
    });
  });

  it('should extract camelCase and snake_case key forms from prompt text', () => {
    const result = extractAcpTaskContextFromText(
      'pending task にして branch=feature/acp baseBranch=develop pr_number=456',
    );

    expect(result).toEqual({
      branch: 'feature/acp',
      baseBranch: 'develop',
      prNumber: 456,
    });
  });

  it('should preserve dotted branch and base branch names', () => {
    const result = extractAcpTaskContextFromText(
      'タスクに積んで branch=release/1.2 baseBranch=release/2026.07.',
    );

    expect(result).toEqual({
      branch: 'release/1.2',
      baseBranch: 'release/2026.07',
    });
  });

  it('should not infer a PR number from a bare issue-style number', () => {
    const result = extractAcpTaskContextFromText('この内容をタスクに積んで #123');

    expect(result).toBeUndefined();
  });

  it.each([
    'PR #0 をタスクに積んで',
    'prNumber: -1 をタスクに積んで',
    'pr_number=1.5 をタスクに積んで',
    'prNumber: abc をタスクに積んで',
  ])('should reject invalid explicit PR numbers from prompt text: %s', (text) => {
    expect(() => extractAcpTaskContextFromText(text)).toThrow(
      'ACP prNumber must be a positive integer.',
    );
  });

  it.each([
    'HEAD:refs/heads/takt/injected',
    '@{-1}',
    '@',
    '-bad',
    '--upload-pack=echo',
    'refs/heads/feature/acp',
    'origin/improve',
    'refs/remotes/origin/improve',
    'invalid..name',
    'invalid name',
    'feature/.hidden',
    'feature/name.lock',
    'feature/name/',
  ])('should reject branch values that are not plain local branch names: %s', (branch) => {
    expect(() => assertValidAcpTaskContext({ branch })).toThrow(/ACP branch|Invalid ACP branch/);
  });

  it.each([
    'HEAD:refs/heads/takt/injected',
    '@{-1}',
    '-bad',
    '--upload-pack=echo',
    'refs/heads/feature/acp',
    'origin/main',
    'refs/remotes/origin/main',
    'invalid..name',
  ])('should reject baseBranch values that are not plain local branch names: %s', (baseBranch) => {
    expect(() => assertValidAcpTaskContext({ baseBranch })).toThrow(/ACP branch|Invalid ACP branch/);
  });

  it('should let prompt context override session context while preserving unspecified fields', () => {
    const result = mergeAcpTaskContext(
      {
        branch: 'takt/old/session-context',
        baseBranch: 'main',
        prNumber: 100,
      },
      {
        branch: 'takt/new/prompt-context',
      },
    );

    expect(result).toEqual({
      branch: 'takt/new/prompt-context',
      baseBranch: 'main',
      prNumber: 100,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('should reject invalid session taskContext PR numbers: %s', (prNumber) => {
    expect(() => assertValidAcpTaskContext({ prNumber })).toThrow(
      'ACP prNumber must be a positive integer.',
    );
  });
});
