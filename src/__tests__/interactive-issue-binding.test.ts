import { describe, expect, it } from 'vitest';
import { resolveInstructionIssue } from '../features/interactive/issueBinding.js';

describe('resolveInstructionIssue', () => {
  it.each(['\n', '\r\n'])('reads a binding immediately after the heading with %j endings', (eol) => {
    expect(resolveInstructionIssue(['# Fix login', '', 'Issue: #1465', '', 'Fix authentication'].join(eol), 1465)).toBe(1465);
  });

  it.each([
    '# Fix logs\n\nNo binding\nIssue: #1465',
    '# Fix logs\n\n`Issue: #1465`',
    '# Fix logs\n\n```text\nIssue: #1465',
    '# Fix logs\n\n~~~text\nIssue: #1465\n~~~',
    '# Fix logs\n\n> Issue: #1465',
    '# Fix logs\n\n<!-- Issue: #1465 -->',
    '# Fix logs\n\nIssue: #1466',
    '# Fix logs\n\nIssue: #0',
    '# Fix logs\n\nIssue: #-1',
    '# Fix logs\n\nIssue: #NaN',
    '# Fix logs\n\nIssue: #9007199254740993',
    '# Fix logs\n\nIssue: #1465 extra',
  ])('does not bind an invalid header or body mention: %s', (instruction) => {
    expect(resolveInstructionIssue(instruction, 1465)).toBeUndefined();
  });

  it.each([undefined, 0, -1, NaN, Number.MAX_SAFE_INTEGER + 1])('does not bind without a valid current Issue: %s', (current) => {
    expect(resolveInstructionIssue('# Fix login\n\nIssue: #1465', current)).toBeUndefined();
  });
});
