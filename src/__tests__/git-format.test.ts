/**
 * Tests for git/format module
 *
 * Regression tests ensuring provider-neutral formatting.
 * Covers: ARCH-001 (no "GitHub" hardcode), QA-R001 (GitLab output correctness),
 * TEST-003 (format.ts location and neutrality).
 *
 * ARCH-003: resolveIssueTask was moved from format.ts to git/index.ts.
 * Tests for resolveIssueTask are in resolveIssueTask-provider.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  formatIssueAsTask,
  parseIssueNumbers,
  isIssueReference,
  formatPrReviewAsTask,
  buildPrBody,
  buildTaktManagedPrOptions,
  isTaktManagedPrBody,
  TAKT_MANAGED_PR_MARKER,
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
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });

  it('should build PR body without issues', () => {
    const result = buildPrBody(undefined, 'Report text');

    expect(result).toContain('## Summary');
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Report text');
    expect(result).not.toContain('Closes');
    expect(result).not.toContain(TAKT_MANAGED_PR_MARKER);
  });
});

describe('buildTaktManagedPrOptions', () => {
  it('managed PR 契約を body marker だけで返す', () => {
    const result = buildTaktManagedPrOptions('## Summary\n\nReport text');

    expect(result).toEqual({
      body: '## Summary\n\nReport text\n\n<!-- takt:managed -->',
    });
  });

  it('body に marker が含まれていても重複させない', () => {
    const body = `## Summary\n\nReport text\n\n${TAKT_MANAGED_PR_MARKER}`;

    const result = buildTaktManagedPrOptions(body);

    expect(result).toEqual({
      body,
    });
  });
});

describe('isTaktManagedPrBody', () => {
  it('marker がある本文だけを TAKT 管理 PR と判定する', () => {
    const body = `## Summary

Task summary

## Execution Report

Workflow \`default\` completed successfully.

${TAKT_MANAGED_PR_MARKER}`;

    expect(isTaktManagedPrBody(body)).toBe(true);
  });

  it('legacy な本文テンプレート流用だけでは TAKT 管理 PR と判定しない', () => {
    const body = `## Summary

Task summary

## Execution Report

Workflow \`default\` completed successfully.`;

    expect(isTaktManagedPrBody(body)).toBe(false);
  });

  it('same-repo の手動 takt PR を模した本文でも marker なしなら false を返す', () => {
    const body = `## Summary

Manual follow-up

## Execution Report

Task completed successfully.`;

    expect(isTaktManagedPrBody(body)).toBe(false);
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
