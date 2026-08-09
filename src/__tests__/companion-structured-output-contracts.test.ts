import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  LOOP_JUDGE_OUTPUT_JSON_SCHEMA,
  MODERATOR_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_JSON_SCHEMA,
  parseCompanionReviewOutput,
  parseLoopJudgeOutput,
  parseModeratorOutput,
} from '../core/workflow/companion/contracts.js';
import {
  assertCompanionOutputEnvelope,
  COMPANION_OUTPUT_LIMITS,
} from '../core/workflow/companion/output-envelope.js';
import { assertStrictStructuredOutputSchema } from '../core/workflow/engine/structured-output-schema-validator.js';

describe('companion structured output contracts', () => {
  it.each([
    ['reviewer', REVIEW_OUTPUT_JSON_SCHEMA],
    ['moderator', MODERATOR_OUTPUT_JSON_SCHEMA],
    ['judge', LOOP_JUDGE_OUTPUT_JSON_SCHEMA],
  ])('should project the %s wire schema to the strict provider subset', (_name, schema) => {
    expect(() => assertStrictStructuredOutputSchema(schema)).not.toThrow();
    expect(JSON.stringify(schema)).not.toContain('minimum');
  });

  it('should require nullable wire properties while normalizing null after receipt', () => {
    const moderatorItem = MODERATOR_OUTPUT_JSON_SCHEMA.properties.findings.items;

    expect(REVIEW_OUTPUT_JSON_SCHEMA.required).toContain('notes');
    expect(moderatorItem.required).toEqual([
      'action',
      'sourceIndex',
      'severity',
      'finding',
      'targetId',
    ]);
    expect(parseCompanionReviewOutput({ findings: [], updates: [], notes: null })).toEqual({
      findings: [],
      updates: [],
    });
    expect(parseModeratorOutput({
      findings: [{
        action: 'reject',
        sourceIndex: 0,
        severity: null,
        finding: null,
        targetId: null,
      }],
      updates: [],
    })).toEqual({ findings: [{ action: 'reject', sourceIndex: 0 }], updates: [] });
  });

  it('should enforce numeric meaning after provider receipt', () => {
    expect(() => parseCompanionReviewOutput({
      findings: [{ severity: 'nit', file: 'src/a.ts', line: 1, finding: 'valid' }],
      updates: [],
      notes: null,
    })).not.toThrow();
    expect(() => parseCompanionReviewOutput({
      findings: [{ severity: 'nit', file: 'src/a.ts', line: 0, finding: 'invalid' }],
      updates: [],
      notes: null,
    })).toThrow();
    expect(() => parseModeratorOutput({
      findings: [{ action: 'reject', sourceIndex: -1 }],
      updates: [],
    })).toThrow();
  });

  it('should accept the array item boundary and reject boundary plus one', () => {
    expect(() => assertCompanionOutputEnvelope(
      Array.from({ length: COMPANION_OUTPUT_LIMITS.maxArrayItems }, () => null),
    )).not.toThrow();
    expect(() => assertCompanionOutputEnvelope(
      Array.from({ length: COMPANION_OUTPUT_LIMITS.maxArrayItems + 1 }, () => null),
    )).toThrow(/item limit/);
  });

  it('should enforce UTF-8 string bytes for ASCII and multibyte text', () => {
    expect(() => parseLoopJudgeOutput({
      decision: 'continue',
      reason: 'x'.repeat(COMPANION_OUTPUT_LIMITS.maxStringBytes),
    })).not.toThrow();
    expect(() => parseLoopJudgeOutput({
      decision: 'continue',
      reason: 'x'.repeat(COMPANION_OUTPUT_LIMITS.maxStringBytes + 1),
    })).toThrow(/string.*byte limit/);
    expect(() => parseLoopJudgeOutput({
      decision: 'continue',
      reason: 'あ'.repeat(Math.floor(COMPANION_OUTPUT_LIMITS.maxStringBytes / 3)),
    })).not.toThrow();
    expect(() => parseLoopJudgeOutput({
      decision: 'continue',
      reason: 'あ'.repeat(Math.floor(COMPANION_OUTPUT_LIMITS.maxStringBytes / 3) + 1),
    })).toThrow(/string.*byte limit/);
  });

  it('should accept the serialized byte boundary and reject boundary plus one', () => {
    const values = ['', '', '', '', ''];
    const overhead = Buffer.byteLength(JSON.stringify({ values }), 'utf8');
    let remaining = COMPANION_OUTPUT_LIMITS.maxSerializedBytes - overhead;
    for (let index = 0; index < values.length; index += 1) {
      const length = Math.min(remaining, COMPANION_OUTPUT_LIMITS.maxStringBytes);
      values[index] = 'x'.repeat(length);
      remaining -= length;
    }
    const exact = { values };

    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8'))
      .toBe(COMPANION_OUTPUT_LIMITS.maxSerializedBytes);
    expect(() => assertCompanionOutputEnvelope(exact)).not.toThrow();
    expect(() => assertCompanionOutputEnvelope({
      values: [...values.slice(0, -1), `${values.at(-1)}x`],
    })).toThrow(/serialized byte limit/);
  });
});
