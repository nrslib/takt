import { describe, expect, it } from 'vitest';
import {
  buildTaskPullRequestBody,
} from '../features/tasks/list/taskPullRequestActions.js';
import {
  formatRunReportSummary,
  summarizeRunReports,
} from '../features/tasks/list/runReportSummary.js';

const summary = summarizeRunReports([{
  filename: 'review-resolution.md',
  content: [
    '## Requirement Decision Grounds',
    '| Subject | Status | Grounds |',
    '|---|---|---|',
    '| failed instruct が worktree で実行できる | Fulfilled | review-1: APPROVE |',
    '## Finding Dispositions',
    '| Finding ID / Source | Disposition | Basis |',
    '|---|---|---|',
    '| FINDING-1 | Unresolved | review-1: APPROVE |',
    '## Re-evaluation of Prior Findings',
    '- review-1: APPROVE',
    '## Reason the Decision Cannot Be Made (when BLOCKED)',
    '- npm run test:e2e:mock',
  ].join('\n'),
}]);

if (summary === null) {
  throw new Error('The PR body fixture must contain a report summary');
}

describe('task pull request body', () => {
  it('failed run の裁定サマリーと後続ゲートを本文へ転記する', () => {
    const body = buildTaskPullRequestBody({
      taskKind: 'failed',
      reportSummary: summary,
      worktreeSummary: ' M src/app.ts\n?? evidence.md',
    });

    expect(body).toContain('failed instruct が worktree で実行できる');
    expect(body).toContain('review-1: APPROVE');
    expect(body).toContain('npm run test:e2e:mock');
    expect(body).toContain('後続ゲートは PR CI');
  });

  it('completed task は最終レポート要約を本文へ転記する', () => {
    const body = buildTaskPullRequestBody({
      taskKind: 'completed',
      reportSummary: summary,
      worktreeSummary: '',
    });

    expect(body).toContain(formatRunReportSummary(summary));
    expect(body).not.toContain('後続ゲートは PR CI');
  });

  it('最終レポートがない場合は作業ツリー差分の概要だけを本文にする', () => {
    const body = buildTaskPullRequestBody({
      taskKind: 'failed',
      reportSummary: null,
      worktreeSummary: ' M src/app.ts\n?? evidence.md',
    });

    expect(body).toContain(' M src/app.ts');
    expect(body).toContain('?? evidence.md');
    expect(body).not.toContain('後続ゲートは PR CI');
    expect(body).not.toContain('failed instruct が worktree で実行できる');
  });
});
