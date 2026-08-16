import { describe, expect, it } from 'vitest';
import {
  parseCompanionReviewOutput,
  parseModeratorOutput,
} from '../core/workflow/companion/contracts.js';

describe('companion structured output contracts', () => {
  it('accepts a valid finding list and normalizes an omitted notes value', () => {
    const finding = { severity: 'must_fix' as const, file: 'src/a.ts', line: 4, finding: 'unsafe write' };

    expect(parseCompanionReviewOutput({ findings: [finding], notes: null })).toEqual({
      findings: [finding],
    });
  });

  it('rejects unknown review fields', () => {
    expect(() => parseCompanionReviewOutput({
      findings: [],
      updates: [{ id: 'reviewer-1', status: 'resolved' }],
      notes: null,
    })).toThrow();
  });

  it('accepts only the supported moderator decisions', () => {
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

    expect(() => parseModeratorOutput({
      findings: [{ action: 'downgrade', sourceIndex: 0 }],
    })).toThrow();
  });

  it('rejects additional moderator decision fields', () => {
    expect(() => parseModeratorOutput({
      findings: [{ action: 'accept', sourceIndex: 0, reason: 'extra field' }],
    })).toThrow();
  });
});
