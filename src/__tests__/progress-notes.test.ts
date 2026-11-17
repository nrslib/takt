import { describe, expect, it } from 'vitest';
import { composeRecoveryInstruction } from '../core/workflow/progress-notes.js';

describe('composeRecoveryInstruction', () => {
  it.each([
    { base: 'P\n\nP', task: 'P\n\nP', expected: 'P\n\nP' },
    { base: 'P\n\nP', task: 'P\n\nF\n\nF\n\nP\n\nR\n\nlive', expected: 'P\n\nP\n\nF\n\nF\n\nR\n\nlive' },
    { base: 'P\n\nF\n\nR\n\nlive\n\nP', task: 'live\n\nR\n\nF\n\nP\n\nretry', expected: 'P\n\nF\n\nR\n\nlive\n\nP\n\nretry' },
    { base: '\n\n  P  \n\n\n\nP\n\n', task: 'P', expected: '\n\n  P  \n\n\n\nP\n\n' },
    { base: '', task: '\n\nR\n\nR', expected: 'R\n\nR' },
    { base: '  P  \n\n\n\nP\n\n', task: ' F \n\nF\n\n P \n\nR\n\n F ', expected: '  P  \n\n\n\nP\n\n\n\n F \n\nF\n\nR\n\n F ' },
    { base: 'P\n\nP', task: '', expected: 'P\n\nP' },
    { base: ' F \n\n F ', task: 'F\n\nF', expected: ' F \n\n F ' },
    { base: 'P', task: '    F\n      nested  \n\n\tR \t', expected: 'P\n\n    F\n      nested  \n\n\tR \t' },
  ])('preserves the base and every task block absent from the base verbatim ($base, $task)', ({ base, task, expected }) => {
    expect(composeRecoveryInstruction(base, task)).toBe(expected);
  });

  it('deduplicates later instructions against previously appended blocks', () => {
    const first = composeRecoveryInstruction('P\n\nP', ' F \n\n F ');

    expect(composeRecoveryInstruction(first, 'F\n\nR\n\nR'))
      .toBe('P\n\nP\n\n F \n\n F \n\nR\n\nR');
  });
});
