import { describe, expect, it } from 'vitest';
import { parseLastJsonBlock, parseStructuredOutputObject } from '../agents/structured-caller/shared.js';

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

  // kiro-cli renders markdown before printing: fence chars are consumed and only `json\n{...}` survives.
  it.each([
    ['bare rendered fence', 'json\n{"step":1,"reason":"ok"}', { step: 1, reason: 'ok' }],
    ['rendered fence after prose', 'explanation\njson\n{"step":1,"reason":"ok"}', { step: 1, reason: 'ok' }],
    ['rendered fence with trailing prose', 'json\n{"step":1}\ntrailing note', { step: 1 }],
    ['last rendered fence', 'json\n{"step":1}\nmore\njson\n{"step":2}', { step: 2 }],
    ['nested braces and quoted braces', 'json\n{"step":1,"reason":"has { and } and \\"quotes\\"","inner":{"a":1}}', { step: 1, reason: 'has { and } and "quotes"', inner: { a: 1 } }],
  ])('accepts markdown-rendered fence: $0', (_name, content, expected) => {
    expect(parseStructuredOutputObject(content)).toEqual(expected);
  });

  it.each([
    ['broken JSON after marker', 'json\n{broken'],
    ['unterminated object after marker', 'json\n{"step":1'],
    ['marker without object', 'json\nnot an object'],
  ])('still rejects rendered-fence candidates that are not valid JSON: $0', (_name, content) => {
    expect(() => parseStructuredOutputObject(content)).toThrow('Response must include a ```json ... ``` block');
  });

  it('keeps object-only enforcement for rendered fences, matching fenced arrays', () => {
    expect(() => parseStructuredOutputObject('json\n[{"id":1}]')).toThrow('Structured output JSON must be an object');
    expect(() => parseStructuredOutputObject('```json\n[{"id":1}]\n```')).toThrow('Structured output JSON must be an object');
  });
});

describe('parseLastJsonBlock rendered fences', () => {
  it.each([
    ['array', 'json\n[{"id":1},{"id":2}]', [{ id: 1 }, { id: 2 }]],
    ['object with nested arrays and bracket in string', 'json\n{"a":[1,{"b":"]"}]}', { a: [1, { b: ']' }] }],
  ])('accepts markdown-rendered %s', (_name, content, expected) => {
    expect(parseLastJsonBlock(content)).toEqual(expected);
  });
});
