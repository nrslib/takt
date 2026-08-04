import { describe, expect, it } from 'vitest';
import { createRunFailure } from '../core/workflow/run/run-failure.js';

describe('createRunFailure', () => {
  it('preserves failure metadata while sanitizing sensitive reason and error text', () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');

    expect(createRunFailure({
      kind: 'step_error',
      step: 'review',
      reason: `before\n${privateKey}\nafter`,
      error: privateKey,
    })).toEqual({
      kind: 'step_error',
      step: 'review',
      reason: 'before\n[REDACTED]\nafter',
      error: '[REDACTED]',
    });
  });
});
