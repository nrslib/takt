import { describe, expect, it } from 'vitest';
import {
  measureWidth,
  nextGraphemeEnd,
  previousGraphemeStart,
  segmentGraphemes,
} from '../shared/utils/grapheme.js';

/** A ZWJ family: three emoji joined into one user-perceived character. */
const FAMILY = '👨‍👩‍👧';
/** 'e' plus a combining acute accent. */
const COMBINED = 'é';

describe('grapheme segmentation', () => {
  it('should keep a ZWJ sequence and a combining pair whole', () => {
    expect(segmentGraphemes(`a${FAMILY}${COMBINED}`)).toEqual(['a', FAMILY, COMBINED]);
  });

  it('should report the end of the grapheme the offset falls in', () => {
    const text = `a${FAMILY}b`;
    expect(nextGraphemeEnd(text, 0)).toBe(1);
    expect(nextGraphemeEnd(text, 1)).toBe(1 + FAMILY.length);
    // An offset inside the cluster still resolves to the cluster's end.
    expect(nextGraphemeEnd(text, 3)).toBe(1 + FAMILY.length);
    expect(nextGraphemeEnd(text, text.length)).toBe(text.length);
  });

  it('should report the start of the grapheme that ends at the offset', () => {
    const text = `a${FAMILY}b`;
    expect(previousGraphemeStart(text, text.length)).toBe(1 + FAMILY.length);
    expect(previousGraphemeStart(text, 1 + FAMILY.length)).toBe(1);
    expect(previousGraphemeStart(text, 1)).toBe(0);
    expect(previousGraphemeStart(text, 0)).toBe(0);
  });
});

describe('display width', () => {
  it('should count a plain character as one column', () => {
    expect(measureWidth('abc')).toBe(3);
  });

  it('should count an East Asian character as two columns', () => {
    expect(measureWidth('あい')).toBe(4);
  });

  it('should count an emoji cluster as two columns, not its code points', () => {
    expect(measureWidth(FAMILY)).toBe(2);
    expect(measureWidth('👍🏽')).toBe(2);
    expect(measureWidth('🇯🇵')).toBe(2);
    expect(measureWidth('❤️')).toBe(2);
  });

  it('should not give a combining mark a column of its own', () => {
    expect(measureWidth(COMBINED)).toBe(1);
  });
});
