import { describe, expect, it } from 'vitest';
import {
  formatRunReportSummary,
  summarizeRunReports,
} from '../features/tasks/list/runReportSummary.js';

function supervisorValidation(
  requirement: string,
  status = 'Fulfilled',
  findingStatus = 'Unresolved',
  gate?: string,
): string {
  return [
    '## Requirements Fulfillment Check',
    '| # | Requirement | Source | Status | Evidence |',
    '|---|---|---|---|---|',
    `| 1 | ${requirement} | order.md | ${status} | executed |`,
    '## Re-evaluation of Prior Findings',
    '| Finding | Resolution Status | Evidence |',
    '|---|---|---|',
    `| finding-for-${requirement} | ${findingStatus} | observed |`,
    '## Reason the Decision Cannot Be Made (when BLOCKED)',
    ...(gate ? [`- ${gate}`] : []),
  ].join('\n');
}

describe('run report summary', () => {
  it('extracts requirement, finding, and gate data from a report table', () => {
    const requirement = 'dynamic requirement';
    const gate = 'npm run verify-dynamic';
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: supervisorValidation(requirement, 'Fulfilled', 'Unresolved', gate),
    }]);

    expect(summary).toEqual({
      fulfilledRequirements: [requirement],
      unresolvedFindingCount: 1,
      reviewHistory: [],
      unverifiedGates: [`- ${gate}`],
    });
  });

  it('extracts review-decision requirement status and history', () => {
    const requirement = 'reviewed requirement';
    const history = 'review-run-7';
    const summary = summarizeRunReports([{
      filename: 'subworkflows/iteration-7--step-peer-review/review-resolution.md',
      content: [
        '## Requirement Decision Grounds',
        '| Subject | Status | Grounds |',
        '|---|---|---|',
        `| ${requirement} | satisfied | verified |`,
        '## Finding Dispositions',
        '| Finding ID / Source | Disposition | Basis |',
        '|---|---|---|',
        '| finding-1 | actionable | direct criterion |',
        '## Re-evaluation of Prior Findings',
        `- ${history}`,
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual([requirement]);
    expect(summary?.unresolvedFindingCount).toBe(1);
    expect(summary?.reviewHistory).toEqual([`- ${history}`]);
  });

  it('selects the latest report occurrence instead of an older report', () => {
    const summary = summarizeRunReports([
      {
        filename: 'subworkflows/iteration-2--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('old requirement'),
      },
      {
        filename: 'subworkflows/iteration-10--step-final-gate/supervisor-validation.md',
        content: supervisorValidation('latest requirement'),
      },
    ]);

    expect(summary?.fulfilledRequirements).toEqual(['latest requirement']);
  });

  it('does not interpret headings or gates inside Markdown fences as report sections', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: [
        '## Requirements Fulfillment Check',
        '| # | Requirement | Source | Status | Evidence |',
        '|---|---|---|---|---|',
        '| 1 | visible requirement | order.md | Fulfilled | executed |',
        '```markdown',
        '## Reason the Decision Cannot Be Made (when BLOCKED)',
        '- hidden gate',
        '```',
      ].join('\n'),
    }]);

    expect(summary?.fulfilledRequirements).toEqual(['visible requirement']);
    expect(summary?.unverifiedGates).toEqual([]);
  });

  it('does not create a summary from an unknown report shape', () => {
    expect(summarizeRunReports([{
      filename: 'review-resolution.md',
      content: '# unrelated report\n\n## Notes\n- arbitrary text',
    }])).toBeNull();
    expect(summarizeRunReports([])).toBeNull();
  });

  it('formats extracted values for downstream consumers', () => {
    const summary = summarizeRunReports([{
      filename: 'supervisor-validation.md',
      content: supervisorValidation('formatted requirement', 'Fulfilled', 'none', 'gate-for-output'),
    }]);
    expect(summary).not.toBeNull();

    const formatted = formatRunReportSummary(summary!);
    expect(formatted).toContain('formatted requirement');
    expect(formatted).toContain('gate-for-output');
    expect(formatted).toBeTypeOf('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
