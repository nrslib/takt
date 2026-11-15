import { describe, expect, it } from 'vitest';
import { composeReviewRecoveryInstruction } from '../core/workflow/review-checkpoint.js';

describe('composeReviewRecoveryInstruction', () => {
  it.each([
    { base: 'P\n\nP', task: 'P\n\nP', expected: 'P\n\nP' },
    { base: 'P\n\nP', task: 'P\n\nF\n\nF\n\nP\n\nR\n\nlive', expected: 'P\n\nP\n\nF\n\nR\n\nlive' },
    { base: 'P\n\nF\n\nR\n\nlive\n\nP', task: 'live\n\nR\n\nF\n\nP\n\nretry', expected: 'P\n\nF\n\nR\n\nlive\n\nP\n\nretry' },
    { base: '\n\n  P  \n\n\n\nP\n\n', task: 'P', expected: '\n\n  P  \n\n\n\nP\n\n' },
    { base: '', task: '\n\nR\n\nR', expected: 'R' },
    { base: '  P  \n\n\n\nP\n\n', task: ' F \n\nF\n\n P \n\nR\n\n F ', expected: '  P  \n\n\n\nP\n\n\n\nF\n\nR' },
    { base: 'P\n\nP', task: '', expected: 'P\n\nP' },
  ])('preserves the base verbatim and appends each new task block once ($base, $task)', ({ base, task, expected }) => {
    expect(composeReviewRecoveryInstruction(base, task)).toBe(expected);
  });
});
