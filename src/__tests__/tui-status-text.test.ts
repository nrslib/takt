import { expect, it } from 'vitest';
import { formatElapsedTime, truncateStatusText } from '../features/tui/statusText.js';
import { measureWidth } from '../shared/utils/grapheme.js';

it.each([[0, '0s'], [12, '12s'], [59, '59s'], [60, '1m00s'], [65, '1m05s']] as const)('formats %s elapsed seconds as %s', (seconds, expected) => {
  expect(formatElapsedTime(seconds)).toBe(expected);
});

it('preserves complete graphemes while truncating a status label to terminal columns', () => {
  const text = '👩‍💻e\u0301作業';
  expect(truncateStatusText(text, 4)).toBe('👩‍💻e\u0301…');
  expect(measureWidth(truncateStatusText(text, 4))).toBe(4);
  expect(truncateStatusText(text, 20)).toBe(text);
  expect(truncateStatusText(text, 0)).toBe('');
});
