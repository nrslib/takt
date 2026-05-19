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
  stripTaktManagedPrMarker,
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
  it('should format legacy PR review data without provider-specific strings', () => {
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

  it('should put active review threads in the Active section', () => {
    const prReview: PrReviewData = {
      number: 11,
      title: 'Threaded PR',
      body: '',
      url: 'https://example.com/pr/11',
      headRefName: 'feature-branch',
      comments: [],
      reviews: [
        {
          author: 'reviewer',
          body: 'Fix this current diff issue',
          path: 'src/app.ts',
          line: 12,
          url: 'https://example.com/pr/11#discussion_r1',
          threadState: 'active',
          isOutdated: false,
        },
      ],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('### Review Policy');
    expect(result).toContain('### Active Review Threads');
    expect(result).toContain('**reviewer**: Fix this current diff issue');
    expect(result).toContain('File: src/app.ts, Line: 12');
    expect(result).toContain('URL: https://example.com/pr/11#discussion_r1');
    expect(result).not.toContain('### Review Comments');
  });

  it('should put unresolved outdated review threads in the outdated section', () => {
    const prReview: PrReviewData = {
      number: 12,
      title: 'Outdated PR',
      body: '',
      url: 'https://example.com/pr/12',
      headRefName: 'feature-branch',
      comments: [],
      reviews: [
        {
          author: 'reviewer',
          body: 'Check whether this stale comment still applies',
          path: 'src/old.ts',
          line: 4,
          threadState: 'outdated-unresolved',
          isOutdated: true,
        },
      ],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('### Outdated But Unresolved Review Threads');
    expect(result).toContain('**reviewer**: Check whether this stale comment still applies');
    expect(result).not.toContain('### Active Review Threads');
    expect(result).not.toContain('### Review Comments');
  });

  it('should put resolved review threads in the reference section with resolution metadata', () => {
    const prReview: PrReviewData = {
      number: 13,
      title: 'Resolved PR',
      body: '',
      url: 'https://example.com/pr/13',
      headRefName: 'feature-branch',
      comments: [],
      reviews: [
        {
          author: 'coderabbitai[bot]',
          body: 'Addressed in commit abc123',
          path: 'src/app.ts',
          line: 8,
          threadState: 'resolved',
          resolvedBy: 'coderabbitai[bot]',
          isOutdated: true,
        },
      ],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('### Resolved / Outdated Review Threads');
    expect(result).toContain('**coderabbitai[bot]**: Addressed in commit abc123');
    expect(result).toContain('Resolved by: coderabbitai[bot]');
    expect(result).toContain('Outdated: yes');
    expect(result).not.toContain('### Active Review Threads');
    expect(result).not.toContain('### Review Comments');
  });

  it('should include policy instructions and preserve existing PR sections when thread states are present', () => {
    const prReview: PrReviewData = {
      number: 14,
      title: 'Mixed PR',
      body: 'PR description',
      url: 'https://example.com/pr/14',
      headRefName: 'feature-branch',
      comments: [{ author: 'dev', body: 'Conversation comment' }],
      reviews: [
        { author: 'summary-reviewer', body: 'Overall review summary' },
        {
          author: 'active-reviewer',
          body: 'Active issue',
          path: 'src/active.ts',
          line: 3,
          threadState: 'active',
          isOutdated: false,
        },
        {
          author: 'outdated-reviewer',
          body: 'Outdated issue',
          path: 'src/outdated.ts',
          line: 5,
          threadState: 'outdated-unresolved',
          isOutdated: true,
        },
        {
          author: 'resolved-reviewer',
          body: 'Resolved issue',
          path: 'src/resolved.ts',
          line: 7,
          threadState: 'resolved',
          resolvedBy: 'maintainer',
          isOutdated: false,
        },
      ],
      files: ['src/active.ts'],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).toContain('以下のレビューコメントは review thread state ごとに分類されています。');
    expect(result).not.toContain('GitHub review thread');
    expect(result).toContain('Active Review Threads を主な修正対象にしてください。');
    expect(result).toContain('Outdated But Unresolved Review Threads は、現在のコードにまだ当てはまるか確認し、当てはまらなければスキップ理由を明記してください。');
    expect(result).toContain('Resolved / Outdated のコメントは原則として修正対象にせず');
    expect(result).toContain('各コメントについて、対応したか、スキップしたか、理由を最後に要約してください。');
    expect(result).toContain('### PR Description');
    expect(result).toContain('PR description');
    expect(result).toContain('### Review Summaries');
    expect(result).toContain('**summary-reviewer**: Overall review summary');
    expect(result).toContain('### Conversation Comments');
    expect(result).toContain('**dev**: Conversation comment');
    expect(result).toContain('### Changed Files');
    expect(result).toContain('- src/active.ts');

    const activeIndex = result.indexOf('### Active Review Threads');
    const outdatedIndex = result.indexOf('### Outdated But Unresolved Review Threads');
    const resolvedIndex = result.indexOf('### Resolved / Outdated Review Threads');
    expect(activeIndex).toBeLessThan(outdatedIndex);
    expect(outdatedIndex).toBeLessThan(resolvedIndex);
  });

  it('should not include review policy when review comments have no thread state', () => {
    const prReview: PrReviewData = {
      number: 15,
      title: 'Legacy PR',
      body: '',
      url: 'https://example.com/pr/15',
      headRefName: 'feature-branch',
      comments: [],
      reviews: [{ author: 'reviewer', body: 'Legacy inline comment', path: 'src/app.ts' }],
      files: [],
    };
    const result = formatPrReviewAsTask(prReview);
    expect(result).not.toContain('### Review Policy');
    expect(result).toContain('### Review Comments');
    expect(result).toContain('**reviewer**: Legacy inline comment');
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

  it('should use order content as summary when issues are absent', () => {
    const orderContent = '## Task\n\nImplement the requested change as written.';

    const result = buildPrBody(undefined, 'Report text', orderContent);

    expect(result).toContain('## Summary');
    expect(result).toContain(orderContent);
    expect(result).toContain('## Execution Report');
    expect(result).toContain('Report text');
    expect(result).not.toContain('Closes');
  });

  it('should prefer issue content over order content when both are provided', () => {
    const issues: Issue[] = [{
      number: 5,
      title: 'Fix bug',
      body: 'Bug description',
      labels: [],
      comments: [],
    }];
    const orderContent = 'Task instructions that should not be used.';

    const result = buildPrBody(issues, 'Report text', orderContent);

    expect(result).toContain('Bug description');
    expect(result).not.toContain(orderContent);
    expect(result).toContain('Closes #5');
  });

  it('should keep summary empty when order content is blank and issues are absent', () => {
    const result = buildPrBody(undefined, 'Report text', '   \n\n');

    expect(result).toContain('## Summary\n\n## Execution Report');
    expect(result).toContain('Report text');
    expect(result).not.toContain('Closes');
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

  it('body 内に混入した marker を除去して末尾 marker だけに正規化する', () => {
    const result = buildTaktManagedPrOptions(`## Summary\n\nReport text\n\n${TAKT_MANAGED_PR_MARKER}\n\n## Execution Report`);

    expect(result).toEqual({
      body: '## Summary\n\nReport text\n\n## Execution Report\n\n<!-- takt:managed -->',
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

  it('本文途中の marker 混入だけでは TAKT 管理 PR と判定しない', () => {
    const body = `## Summary

Issue body

${TAKT_MANAGED_PR_MARKER}

## Execution Report

Workflow \`default\` completed successfully.`;

    expect(isTaktManagedPrBody(body)).toBe(false);
  });
});

describe('stripTaktManagedPrMarker', () => {
  it('本文中の marker を除去して空行を詰める', () => {
    const body = `## Summary

Issue body

${TAKT_MANAGED_PR_MARKER}

## Execution Report

Workflow \`default\` completed successfully.`;

    expect(stripTaktManagedPrMarker(body)).toBe(`## Summary

Issue body

## Execution Report

Workflow \`default\` completed successfully.`);
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
