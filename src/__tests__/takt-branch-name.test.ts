import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTimestampedTaktBranchName } from '../shared/utils/takt-branch-name.js';

describe('TAKT timestamped branch names', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ['task', 'takt/20261004T1443-task'],
    [undefined, 'takt/20261004T1443'],
  ])('formats the existing naming rule for %s', (slug, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T14:43:00Z'));
    expect(createTimestampedTaktBranchName(slug)).toBe(expected);
  });
});
