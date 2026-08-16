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
  it('preserves issue fields for workflow input', () => {
    const issue: Issue = {
      number: 42,
      title: 'dynamic issue title',
      body: 'dynamic issue body',
      labels: ['dynamic-label'],
      comments: [{ author: 'dynamic-author', body: 'dynamic comment' }],
    };

    const result = formatIssueAsTask(issue);

    expect(result).toContain(issue.title);
    expect(result).toContain(issue.body);
    expect(result).toContain(issue.labels[0]!);
    expect(result).toContain(issue.comments[0]!.body);
    expect(result).toContain(issue.comments[0]!.author);
  });

  it('omits optional sections when issue data is empty', () => {
    const result = formatIssueAsTask({
      number: 1,
      title: 'minimal issue',
      body: '',
      labels: [],
      comments: [],
    });

    expect(result).toContain('minimal issue');
    expect(result).not.toContain('dynamic-label');
  });
});

describe('formatPrReviewAsTask', () => {
  it('preserves review bodies and thread metadata across classifications', () => {
    const review: PrReviewData = {
      number: 10,
      title: 'dynamic pull request',
      body: 'dynamic PR description',
      url: 'https://example.com/pr/10',
      headRefName: 'feature-branch',
      comments: [{ author: 'conversation-author', body: 'conversation body' }],
      reviews: [
        {
          author: 'active-author',
          body: 'active body',
          path: 'src/active.ts',
          line: 12,
          threadState: 'active',
        },
        {
          author: 'resolved-author',
          body: 'resolved body',
          path: 'src/resolved.ts',
          resolvedBy: 'resolver',
          threadState: 'resolved',
        },
      ],
      files: ['src/changed.ts'],
    };

    const result = formatPrReviewAsTask(review);

    for (const value of [
      review.title,
      review.body,
      review.reviews[0]!.body,
      review.reviews[1]!.body,
      review.reviews[1]!.resolvedBy!,
      review.comments[0]!.body,
      review.files[0]!,
    ]) {
      expect(result).toContain(value);
    }
  });
});

describe('buildPrBody', () => {
  it('uses issue data as the summary and preserves the execution report', () => {
    const issue: Issue = {
      number: 5,
      title: 'issue title for PR',
      body: 'issue body for PR',
      labels: [],
      comments: [],
    };
    const report = 'execution report payload';

    const result = buildPrBody([issue], report, 'fallback order payload');

    expect(result).toContain(issue.body);
    expect(result).toContain(report);
    expect(result).toContain(String(issue.number));
    expect(result).not.toContain('fallback order payload');
  });

  it('falls back to order content when no issue is available', () => {
    const orderContent = 'order payload for PR';
    const report = 'execution payload for PR';

    const result = buildPrBody(undefined, report, orderContent);

    expect(result).toContain(orderContent);
    expect(result).toContain(report);
  });
});

describe('buildTaktManagedPrOptions', () => {
  it('managed PR 契約を body marker だけで返す', () => {
    const result = buildTaktManagedPrOptions('Report text');

    expect(result.body.endsWith(TAKT_MANAGED_PR_MARKER)).toBe(true);
    expect(result.body.match(/<!-- takt:managed -->/g)).toHaveLength(1);
    expect(result.body).toContain('Report text');
  });

  it('body に marker が含まれていても重複させない', () => {
    const body = `Report text\n\n${TAKT_MANAGED_PR_MARKER}`;

    const result = buildTaktManagedPrOptions(body);

    expect(result).toEqual({
      body,
    });
  });

  it('body 内に混入した marker を除去して末尾 marker だけに正規化する', () => {
    const beforeMarker = 'first report section';
    const afterMarker = 'second report section';
    const result = buildTaktManagedPrOptions(`${beforeMarker}\n\n${TAKT_MANAGED_PR_MARKER}\n\n${afterMarker}`);

    expect(result.body.endsWith(TAKT_MANAGED_PR_MARKER)).toBe(true);
    expect(result.body.match(/<!-- takt:managed -->/g)).toHaveLength(1);
    expect(result.body).toContain(beforeMarker);
    expect(result.body).toContain(afterMarker);
  });
});

describe('isTaktManagedPrBody', () => {
  it('marker がある本文だけを TAKT 管理 PR と判定する', () => {
    const body = `task payload\n\nreport payload\n\n${TAKT_MANAGED_PR_MARKER}`;

    expect(isTaktManagedPrBody(body)).toBe(true);
  });

  it('legacy な本文テンプレート流用だけでは TAKT 管理 PR と判定しない', () => {
    const body = 'task payload\n\nreport payload';

    expect(isTaktManagedPrBody(body)).toBe(false);
  });

  it('same-repo の手動 takt PR を模した本文でも marker なしなら false を返す', () => {
    const body = 'Manual follow-up\n\nTask completed successfully.';

    expect(isTaktManagedPrBody(body)).toBe(false);
  });

  it('本文途中の marker 混入だけでは TAKT 管理 PR と判定しない', () => {
    const body = `issue payload\n\n${TAKT_MANAGED_PR_MARKER}\n\nreport payload`;

    expect(isTaktManagedPrBody(body)).toBe(false);
  });
});

describe('stripTaktManagedPrMarker', () => {
  it('本文中の marker を除去して空行を詰める', () => {
    const beforeMarker = 'issue payload';
    const afterMarker = 'report payload';
    const body = `${beforeMarker}\n\n${TAKT_MANAGED_PR_MARKER}\n\n${afterMarker}`;

    const stripped = stripTaktManagedPrMarker(body);
    expect(stripped).not.toContain(TAKT_MANAGED_PR_MARKER);
    expect(stripped).toContain(beforeMarker);
    expect(stripped).toContain(afterMarker);
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
