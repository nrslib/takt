/**
 * Unit tests for health evaluator
 *
 * Tests health verdict evaluation based on finding records.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateHealth,
  runHealthCheck,
  createDefaultThresholds,
  buildConversationAnalysisPrompt,
  parseAlignmentResponse,
  applyMisalignedVerdict,
} from '../core/piece/health-monitor/health-evaluator.js';
import { FindingTracker } from '../core/piece/health-monitor/finding-tracker.js';
import type { FindingRecord, RawFinding, HealthSnapshot } from '../core/piece/health-monitor/types.js';

function makeRecord(overrides: Partial<FindingRecord> & { findingId: string }): FindingRecord {
  return {
    status: 'new',
    consecutivePersists: 0,
    recurrenceCount: 0,
    trend: 'new',
    ...overrides,
  };
}

function makeFinding(id: string, status: 'new' | 'persists' | 'resolved'): RawFinding {
  return { id, status, category: 'test', location: 'test.ts:1' };
}

describe('evaluateHealth', () => {
  it('should return converging when no findings exist and no phase error', () => {
    const result = evaluateHealth([], 0, false);

    expect(result.verdict).toBe('converging');
    expect(result.relatedFindings).toEqual([]);
  });

  it('should return converging when all findings are resolved', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'resolved', trend: 'improving' }),
      makeRecord({ findingId: 'b', status: 'resolved', trend: 'improving' }),
    ];

    const result = evaluateHealth(findings, 2, false);

    expect(result.verdict).toBe('converging');
    expect(result.summary).toContain('2 findings resolved');
  });

  it('should return looping when any finding has looping trend', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 5, trend: 'looping' }),
      makeRecord({ findingId: 'b', status: 'resolved', trend: 'improving' }),
    ];

    const result = evaluateHealth(findings, 2, false);

    expect(result.verdict).toBe('looping');
    expect(result.relatedFindings).toContain('a');
  });

  it('should return stagnating when any finding has stagnating trend', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 3, trend: 'stagnating' }),
      makeRecord({ findingId: 'b', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 1, false);

    expect(result.verdict).toBe('stagnating');
    expect(result.relatedFindings).toContain('a');
  });

  it('should return needs_attention when active findings increase', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'new', trend: 'new' }),
      makeRecord({ findingId: 'b', status: 'new', trend: 'new' }),
      makeRecord({ findingId: 'c', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 2, false);

    expect(result.verdict).toBe('needs_attention');
    expect(result.summary).toContain('increased from 2 to 3');
  });

  it('should return needs_attention when phase error occurs', () => {
    const result = evaluateHealth([], 0, true);

    expect(result.verdict).toBe('needs_attention');
    expect(result.summary).toContain('phase_error');
  });

  it('should return needs_attention for phase error even with active findings', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 1, true);

    expect(result.verdict).toBe('needs_attention');
    expect(result.summary).toContain('phase_error');
  });

  it('should prioritize looping over phase error', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 5, trend: 'looping' }),
    ];

    const result = evaluateHealth(findings, 1, true);

    expect(result.verdict).toBe('looping');
  });

  it('should prioritize stagnating over phase error', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 3, trend: 'stagnating' }),
    ];

    const result = evaluateHealth(findings, 1, true);

    expect(result.verdict).toBe('stagnating');
  });

  it('should return improving when mix of resolved and active findings', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'resolved', trend: 'improving' }),
      makeRecord({ findingId: 'b', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 2, false);

    expect(result.verdict).toBe('improving');
    expect(result.summary).toContain('1 resolved');
    expect(result.summary).toContain('1 active');
  });

  it('should prioritize looping over stagnating', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 5, trend: 'looping' }),
      makeRecord({ findingId: 'b', status: 'persists', consecutivePersists: 3, trend: 'stagnating' }),
    ];

    const result = evaluateHealth(findings, 2, false);

    expect(result.verdict).toBe('looping');
  });

  it('should prioritize stagnating over needs_attention', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'persists', consecutivePersists: 3, trend: 'stagnating' }),
      makeRecord({ findingId: 'b', status: 'new', trend: 'new' }),
      makeRecord({ findingId: 'c', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 1, false);

    expect(result.verdict).toBe('stagnating');
  });

  it('should include recurrence info in looping summary', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'new', recurrenceCount: 2, trend: 'looping' }),
    ];

    const result = evaluateHealth(findings, 1, false);

    expect(result.verdict).toBe('looping');
    expect(result.summary).toContain('recurred 2 time(s)');
  });

  it('should not report needs_attention when previousFindingCount is 0', () => {
    const findings = [
      makeRecord({ findingId: 'a', status: 'new', trend: 'new' }),
      makeRecord({ findingId: 'b', status: 'new', trend: 'new' }),
    ];

    const result = evaluateHealth(findings, 0, false);

    expect(result.verdict).toBe('improving');
  });
});

describe('runHealthCheck', () => {
  it('should produce a complete health snapshot', () => {
    const thresholds = createDefaultThresholds();
    const tracker = new FindingTracker(thresholds);
    const rawFindings: RawFinding[] = [
      makeFinding('issue-a', 'new'),
      makeFinding('issue-b', 'new'),
    ];

    const snapshot = runHealthCheck(tracker, rawFindings, 0, false, 'ai_review', 3, 30);

    expect(snapshot.movementName).toBe('ai_review');
    expect(snapshot.iteration).toBe(3);
    expect(snapshot.maxMovements).toBe(30);
    expect(snapshot.findings).toHaveLength(2);
    expect(snapshot.verdict.verdict).toBeDefined();
  });

  it('should track findings across multiple calls', () => {
    const thresholds = createDefaultThresholds();
    const tracker = new FindingTracker(thresholds);

    // First check: new findings
    runHealthCheck(tracker, [makeFinding('issue-a', 'new')], 0, false, 'ai_review', 1, 30);

    // Second check: finding persists
    const snapshot = runHealthCheck(tracker, [makeFinding('issue-a', 'persists')], 1, false, 'fix', 2, 30);

    expect(snapshot.findings[0].status).toBe('persists');
    expect(snapshot.findings[0].consecutivePersists).toBe(1);
  });

  it('should report needs_attention when hasPhaseError is true', () => {
    const thresholds = createDefaultThresholds();
    const tracker = new FindingTracker(thresholds);

    const snapshot = runHealthCheck(tracker, [], 0, true, 'ai_fix', 2, 30);

    expect(snapshot.verdict.verdict).toBe('needs_attention');
    expect(snapshot.verdict.summary).toContain('phase_error');
  });
});

describe('createDefaultThresholds', () => {
  it('should return expected default values', () => {
    const thresholds = createDefaultThresholds();

    expect(thresholds.stagnationThreshold).toBe(3);
    expect(thresholds.loopThreshold).toBe(5);
    expect(thresholds.recurrenceThreshold).toBe(2);
  });
});

describe('buildConversationAnalysisPrompt', () => {
  it('should include conversation entries and finding IDs', () => {
    const conversations = [
      { step: 'ai_review', instruction: 'Review the code', content: 'Found issues with auth' },
      { step: 'ai_fix', instruction: 'Fix auth issues', content: 'Changed error message text' },
    ];

    const prompt = buildConversationAnalysisPrompt(conversations, ['auth-null-check']);

    expect(prompt).toContain('ai_review');
    expect(prompt).toContain('Review the code');
    expect(prompt).toContain('Found issues with auth');
    expect(prompt).toContain('ai_fix');
    expect(prompt).toContain('auth-null-check');
    expect(prompt).toContain('ALIGNED');
    expect(prompt).toContain('MISALIGNED');
  });

  it('should include error info when present in conversation', () => {
    const conversations = [
      { step: 'ai_review', instruction: 'Review', content: 'Issues found', error: 'timeout' },
    ];

    const prompt = buildConversationAnalysisPrompt(conversations, ['issue-a']);

    expect(prompt).toContain('ai_review');
    expect(prompt).toContain('Issues found');
  });
});

describe('parseAlignmentResponse', () => {
  it('should detect ALIGNED response', () => {
    const result = parseAlignmentResponse('ALIGNED: The fixes address the concerns');

    expect(result.misaligned).toBe(false);
    expect(result.reason).toBe('');
  });

  it('should detect MISALIGNED response with reason', () => {
    const result = parseAlignmentResponse('MISALIGNED: Fixes change error messages but not error types');

    expect(result.misaligned).toBe(true);
    expect(result.reason).toBe('Fixes change error messages but not error types');
  });

  it('should detect MISALIGNED response without reason', () => {
    const result = parseAlignmentResponse('MISALIGNED');

    expect(result.misaligned).toBe(true);
    expect(result.reason).toBe('Fix does not address reviewer concerns');
  });

  it('should treat non-matching response as aligned', () => {
    const result = parseAlignmentResponse('Some other response text');

    expect(result.misaligned).toBe(false);
  });
});

describe('applyMisalignedVerdict', () => {
  it('should upgrade verdict to misaligned', () => {
    const snapshot: HealthSnapshot = {
      movementName: 'ai_fix',
      iteration: 5,
      maxMovements: 30,
      findings: [makeRecord({ findingId: 'issue-a', status: 'persists', trend: 'stagnating' })],
      verdict: {
        verdict: 'stagnating',
        summary: 'issue-a persists for 3 consecutive iterations',
        relatedFindings: ['issue-a'],
      },
    };

    const result = applyMisalignedVerdict(snapshot, 'Fix changes error messages but not error types');

    expect(result.verdict.verdict).toBe('misaligned');
    expect(result.verdict.summary).toContain('会話分析');
    expect(result.verdict.summary).toContain('Fix changes error messages but not error types');
    expect(result.verdict.relatedFindings).toEqual(['issue-a']);
    // Original snapshot should not be mutated
    expect(snapshot.verdict.verdict).toBe('stagnating');
  });
});
