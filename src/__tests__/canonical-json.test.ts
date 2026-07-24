import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../shared/utils/canonical-json.js';

describe('hashCanonicalJson', () => {
  it('plain objectはキー順に依存せず同じhashになる', () => {
    expect(hashCanonicalJson({ alpha: 1, beta: [true, null] }))
      .toBe(hashCanonicalJson({ beta: [true, null], alpha: 1 }));
  });

  it.each([
    ['Date', new Date('2026-07-24T00:00:00.000Z')],
    ['Map', new Map([['key', 'value']])],
    ['Set', new Set(['value'])],
    ['RegExp', /value/u],
  ])('%sは空objectへ潰さず拒否する', (_name, value) => {
    expect(() => hashCanonicalJson(value)).toThrow(TypeError);
    expect(() => hashCanonicalJson(value)).toThrow(/unsupported object/);
  });
});
