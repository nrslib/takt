import { describe, expect, it } from 'vitest';
import { parseStructuredOutputObject } from '../agents/structured-caller/shared.js';

describe('parseStructuredOutputObject', () => {
  it.each([
    ['whole object', '{"step":1,"reason":"ok"}', { step: 1, reason: 'ok' }],
    ['BOM and whitespace', '\uFEFF \n {"step":1,"reason":"ok"}\n ', { step: 1, reason: 'ok' }],
    ['fenced JSON', 'explanation\n```json\n{"step":1,"reason":"ok"}\n```', { step: 1, reason: 'ok' }],
    ['last fenced JSON', '```json\n{"step":1}\n```\n```json\n{"step":2}\n```', { step: 2 }],
    ['JSON string containing a fence', '"```json not a response fence```"', undefined],
  ])('accepts $0 only when it is an object', (_name, content, expected) => {
    if (expected === undefined) {
      expect(() => parseStructuredOutputObject(content)).toThrow('Structured output JSON must be an object');
      return;
    }
    expect(parseStructuredOutputObject(content)).toEqual(expected);
  });

  it.each([
    '[1]',
    'null',
    'true',
    '1',
    '"text"',
    'explanation\n{"step":1}',
    '{"step":1};',
    '{"step":1}// comment',
    '{"step":1}{"reason":"next"}',
  ])('rejects unsafe non-whole response: %s', (content) => {
    expect(() => parseStructuredOutputObject(content)).toThrow();
  });
});
