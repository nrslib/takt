import { describe, expect, it } from 'vitest';
import { formatProcessExitCause } from '../shared/utils/process-exit.js';

describe('formatProcessExitCause', () => {
  it.each([
    [7, null, 'code 7'],
    [null, 'SIGTERM', 'signal SIGTERM'],
    [null, null, 'no exit code or signal'],
  ] as const)('should format code %s and signal %s without an unknown fallback', (code, signal, expected) => {
    expect(formatProcessExitCause(code, signal)).toBe(expected);
  });
});
