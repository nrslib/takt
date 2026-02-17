/**
 * Unit tests for report formatter
 *
 * Tests health report output formatting.
 */

import { describe, it, expect } from 'vitest';
import { formatHealthReport } from '../core/piece/health-monitor/report-formatter.js';
import type { HealthSnapshot, FindingRecord } from '../core/piece/health-monitor/types.js';

function makeSnapshot(overrides: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    movementName: 'supervise',
    iteration: 4,
    maxMovements: 10,
    findings: [],
    verdict: { verdict: 'converging', summary: 'All clear', relatedFindings: [] },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<FindingRecord> & { findingId: string }): FindingRecord {
  return {
    status: 'new',
    consecutivePersists: 0,
    recurrenceCount: 0,
    trend: 'new',
    ...overrides,
  };
}

describe('formatHealthReport', () => {
  it('should include header and movement info', () => {
    const report = formatHealthReport(makeSnapshot({}));

    expect(report).toContain('═══ Loop Health Monitor ═══');
    expect(report).toContain('Movement: supervise (iteration 4/10)');
  });

  it('should show no findings message when empty', () => {
    const report = formatHealthReport(makeSnapshot({ findings: [] }));

    expect(report).toContain('(no findings)');
  });

  it('should format findings table rows', () => {
    const findings: FindingRecord[] = [
      makeRecord({ findingId: 'auth-null-check', status: 'resolved', trend: 'improving' }),
      makeRecord({ findingId: 'api-error-handler', status: 'persists', consecutivePersists: 3, trend: 'stagnating' }),
      makeRecord({ findingId: 'input-validation', status: 'new', trend: 'new' }),
    ];
    const report = formatHealthReport(makeSnapshot({ findings }));

    expect(report).toContain('auth-null-check');
    expect(report).toContain('resolved');
    expect(report).toContain('✓ 改善');
    expect(report).toContain('api-error-handler');
    expect(report).toContain('persists');
    expect(report).toContain('▲ 停滞');
    expect(report).toContain('input-validation');
    expect(report).toContain('→ 新規');
  });

  it('should show verdict and reason', () => {
    const report = formatHealthReport(makeSnapshot({
      verdict: {
        verdict: 'stagnating',
        summary: 'api-error-handler persists for 3 consecutive iterations',
        relatedFindings: ['api-error-handler'],
      },
    }));

    expect(report).toContain('健全性: ▲ 停滞');
    expect(report).toContain('理由: api-error-handler persists for 3 consecutive iterations');
  });

  it('should show dash for consecutive persists of resolved findings', () => {
    const findings: FindingRecord[] = [
      makeRecord({ findingId: 'issue-a', status: 'resolved', consecutivePersists: 0, trend: 'improving' }),
    ];
    const report = formatHealthReport(makeSnapshot({ findings }));

    expect(report).toContain('-');
  });

  it('should render all verdict types correctly', () => {
    const verdicts = ['converging', 'improving', 'stagnating', 'looping', 'needs_attention', 'misaligned'] as const;
    const labels = ['✓ 収束', '→ 改善動作', '▲ 停滞', '✗ ループ', '⚠ 要注意', '✗ 噛み合い不全'];

    for (let i = 0; i < verdicts.length; i++) {
      const report = formatHealthReport(makeSnapshot({
        verdict: { verdict: verdicts[i], summary: 'test', relatedFindings: [] },
      }));
      expect(report).toContain(labels[i]);
    }
  });
});
