import { describe, expect, it } from 'vitest';
import { createRunFailure } from '../core/workflow/run/run-failure.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';

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
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    })).toEqual({
      kind: 'step_error',
      step: 'review',
      reason: 'before\n[REDACTED]\nafter',
      error: '[REDACTED]',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    });
  });
});
