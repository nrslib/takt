import { describe, expect, it } from 'vitest';
import {
  parseCompanionReviewOutput,
  parseModeratorOutput,
} from '../core/workflow/companion/contracts.js';

describe('companion structured output contracts', () => {
  it('accepts a fresh finding list without lifecycle state', () => {
    expect(parseCompanionReviewOutput({
      findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 4, finding: 'unsafe write' }],
      notes: null,
    })).toEqual({
      findings: [{ severity: 'must_fix', file: 'src/a.ts', line: 4, finding: 'unsafe write' }],
    });
  });

  it('rejects removed finding updates', () => {
    expect(() => parseCompanionReviewOutput({
      findings: [],
      updates: [{ id: 'reviewer-1', status: 'resolved' }],
      notes: null,
    })).toThrow();
  });

  it('accepts round-local accept and reject moderator decisions', () => {
    expect(parseModeratorOutput({
      findings: [
        { action: 'accept', sourceIndex: 0 },
        { action: 'reject', sourceIndex: 1 },
      ],
    })).toEqual({
      findings: [
        { action: 'accept', sourceIndex: 0 },
        { action: 'reject', sourceIndex: 1 },
      ],
    });
  });

  it.each([
    {
      caseName: 'an unsupported action',
      output: { findings: [{ action: 'downgrade', sourceIndex: 0 }] },
    },
    {
      caseName: 'an additional decision field',
      output: { findings: [{ action: 'accept', sourceIndex: 0, reason: 'extra field' }] },
    },
  ])('rejects $caseName', ({ output }) => {
    expect(() => parseModeratorOutput(output)).toThrow();
  });
});
