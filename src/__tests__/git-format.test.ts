/**
 * Tests for git/format module
 *
 * Regression tests ensuring provider-neutral formatting.
 * Covers: ARCH-001 (no "GitHub" hardcode), QA-R001 (GitLab output correctness),
 * TEST-003 (format.ts location and neutrality).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  formatIssueAsTask,
  parseIssueNumbers,
  isIssueReference,
  formatPrReviewAsTask,
  buildPrBody,
  resolveIssueTask,
} from '../infra/git/format.js';
import type { Issue, PrReviewData } from '../infra/git/types.js';

describe('formatIssueAsTask', () => {
  it('should not contain provider-specific strings like "GitHub"', () => {
    const issue: Issue = {
      number: 42,
      title: 'Test Issue',
      body: 'Body text',
      labels: ['bug'],
      comments: [{ author: 'user1', body: 'comment' }],
    };

    const result = formatIssueAsTask(issue);

    expect(result).not.toContain('GitHub');
    expect(result).not.toContain('GitLab');
    expect(result).toContain('## Issue #42: Test Issue');
    expect(result).toContain('Body text');
    expect(result).toContain('bug');
    expect(result).toContain('**user1**: comment');
  });

  it('should format issue with no body, labels, or comments', () => {
    const issue: Issue = {
      number: 1,
      title: 'Minimal',
      body: '',
      labels: [],
      comments: [],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toBe('## Issue #1: Minimal');
  });
});

describe('formatPrReviewAsTask', () => {
  it('should format PR review data without provider-specific strings', () => {
    const prReview: PrReviewData = {
      number: 10,
      title: 'Feature PR',
      body: 'PR description',
      url: 'https://example.com/pr/10',
      headRefName: 'feature-branch',
      baseRefName: 'main',
      comments: [{ author: 'dev', body: 'LGTM' }],
      reviews: [{ author: 'reviewer', body: 'Approved', path: 'src/app.ts', line: 5 }],
      files: ['src/app.ts'],
    };

    const result = formatPrReviewAsTask(prReview);

    expect(result).not.toContain('GitHub');
    expect(result).not.toContain('GitLab');
    expect(result).toContain('## PR #10 Review Comments: Feature PR');
    expect(result).toContain('PR description');
    expect(result).toContain('**reviewer**: Approved');
    expect(result).toContain('File: src/app.ts, Line: 5');
    expect(result).toContain('**dev**: LGTM');
    expect(result).toContain('- src/app.ts');
  });
});

describe('buildPrBody', () => {
  it('should build PR body with Closes #N for issues', () => {
    const issues: Issue[] = [{
      number: 5,
      title: 'Fix bug',
      body: 'Bug description',
      labels: [],
      comments: [],
    }];

    const result = buildPrBody(issues, 'Report text');

    expect(result).toContain('## Summary');
    expect(result).toContain('Bug description');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Report text');
    expect(result).toContain('Closes #5');
  });

  it('should build PR body without issues', () => {
    const result = buildPrBody(undefined, 'Report text');

    expect(result).toContain('## Summary');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Report text');
    expect(result).not.toContain('Closes');
  });
});

describe('resolveIssueTask', () => {
  it('should return task as-is when no issue references found', () => {
    const mockProvider = vi.fn();

    const result = resolveIssueTask('Fix the bug', mockProvider);

    expect(result).toBe('Fix the bug');
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('should resolve issue references via provider callback', () => {
    const mockProvider = vi.fn().mockReturnValue({
      checkCliStatus: () => ({ available: true }),
      fetchIssue: (n: number) => ({
        number: n,
        title: `Issue ${n}`,
        body: `Body ${n}`,
        labels: [],
        comments: [],
      }),
    });

    const result = resolveIssueTask('#7', mockProvider);

    expect(mockProvider).toHaveBeenCalled();
    expect(result).toContain('## Issue #7: Issue 7');
    expect(result).not.toContain('GitHub');
  });

  it('should throw when CLI is unavailable', () => {
    const mockProvider = vi.fn().mockReturnValue({
      checkCliStatus: () => ({ available: false, error: 'CLI not installed' }),
      fetchIssue: vi.fn(),
    });

    expect(() => resolveIssueTask('#1', mockProvider)).toThrow('CLI not installed');
  });
});

describe('parseIssueNumbers', () => {
  it('should parse valid issue references', () => {
    expect(parseIssueNumbers(['#6'])).toEqual([6]);
    expect(parseIssueNumbers(['#6', '#7'])).toEqual([6, 7]);
  });

  it('should return empty for non-issue args', () => {
    expect(parseIssueNumbers(['Fix'])).toEqual([]);
    expect(parseIssueNumbers([])).toEqual([]);
  });
});

describe('isIssueReference', () => {
  it('should return true for valid references', () => {
    expect(isIssueReference('#6')).toBe(true);
  });

  it('should return false for non-references', () => {
    expect(isIssueReference('Fix bug')).toBe(false);
  });
});
