import { describe, expect, it } from 'vitest';
import type { RuleMatchMethod } from '../core/models/status.js';
import { toJudgmentMatchMethod } from '../core/logging/contracts.js';
import { buildStepCompleteRecord } from '../features/tasks/execute/sessionLoggerRecordFactory.js';
import { makeStep } from './test-helpers.js';

describe('judgment match method observability contract', () => {
  it.each([
    ['structured_output', 'structured_output'],
    ['ai_judge', 'ai_judge'],
    ['phase3_tag', 'tag_fallback'],
    ['aggregate', undefined],
    ['auto_select', undefined],
  ] as const)('maps %s to %s', (method, expected) => {
    expect(toJudgmentMatchMethod(method)).toBe(expected);
  });

  it('maps the session step-complete record through the shared contract', () => {
    const matchedRuleMethod: RuleMatchMethod = 'phase3_tag';

    const record = buildStepCompleteRecord(
      makeStep({ name: 'review' }),
      {
        persona: 'reviewer',
        status: 'done',
        content: 'approved',
        timestamp: new Date('2026-07-22T00:00:00.000Z'),
        matchedRuleMethod,
      },
      'Review',
      1,
      undefined,
      (text) => text,
    );

    expect(record.matchMethod).toBe('tag_fallback');
  });
});
