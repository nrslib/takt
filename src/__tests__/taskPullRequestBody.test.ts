import { describe, expect, it } from 'vitest';
import { buildTaskPullRequestBody } from '../features/tasks/list/taskPullRequestActions.js';
import type { RunReportSummary } from '../features/tasks/list/runReportSummary.js';

const reportSummary: RunReportSummary = {
  fulfilledRequirements: ['requirement forwarded to PR'],
  unresolvedFindingCount: 1,
  reviewHistory: ['review history forwarded to PR'],
  unverifiedGates: ['- gate forwarded to PR'],
};

describe('task pull request body', () => {
  it('forwards a failed run report and worktree data into the PR body', () => {
    const worktree = ' M src/changed.ts\n?? evidence-for-pr.md';
    const body = buildTaskPullRequestBody({
      taskKind: 'failed',
      reportSummary,
      worktreeSummary: worktree,
    });

    expect(body).toContain('requirement forwarded to PR');
    expect(body).toContain('review history forwarded to PR');
    expect(body).toContain('gate forwarded to PR');
    expect(body).toContain(worktree);
  });

  it('includes a completed run report without inventing worktree data', () => {
    const body = buildTaskPullRequestBody({
      taskKind: 'completed',
      reportSummary,
      worktreeSummary: '',
    });

    expect(body).toContain('requirement forwarded to PR');
    expect(body).not.toContain('evidence-for-pr.md');
  });

  it('uses only the worktree summary when the report is unavailable', () => {
    const worktree = ' M src/changed.ts\n?? evidence-for-pr.md';
    const body = buildTaskPullRequestBody({
      taskKind: 'failed',
      reportSummary: null,
      worktreeSummary: worktree,
    });

    expect(body).toContain(worktree);
    expect(body).not.toContain('requirement forwarded to PR');
  });
});
