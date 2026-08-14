import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function workflow(step: Record<string, unknown>) {
  return {
    name: 'custom-review',
    instructions: { retry: 'Close only the supplied gaps.' },
    initial_step: 'reviewer',
    steps: [{
      name: 'reviewer',
      edit: false,
      persona: 'reviewer',
      instruction: 'Review the task.',
      rules: [{ condition: 'approved', next: 'COMPLETE' }],
      ...step,
    }],
  };
}

describe('completion retry workflow contract', () => {
  it('normalizes the required retry instruction and retry defaults', () => {
    const config = normalizeWorkflowConfig(
      workflow({ completion_retry: { retry_instruction: 'retry' } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toEqual({
      minRetry: 0,
      maxRetry: 4,
      retryInstruction: 'Close only the supplied gaps.',
    });
  });

  it('normalizes the deprecated review_completion alias', () => {
    const config = normalizeWorkflowConfig(
      workflow({ review_completion: { retry_instruction: 'retry' } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toEqual({
      minRetry: 0,
      maxRetry: 4,
      retryInstruction: 'Close only the supplied gaps.',
    });
  });

  it('rejects completion_retry together with the deprecated review_completion alias', () => {
    expect(() => normalizeWorkflowConfig(
      workflow({
        completion_retry: { retry_instruction: 'retry' },
        review_completion: { retry_instruction: 'retry' },
      }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    )).toThrow(/cannot specify both "completion_retry" and deprecated alias "review_completion"/);
  });

  it('uses the internal ceiling when min_retry is set without max_retry', () => {
    const config = normalizeWorkflowConfig(
      workflow({ completion_retry: { retry_instruction: 'retry', min_retry: 2 } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toMatchObject({
      minRetry: 2,
      maxRetry: 4,
    });
  });

  it('preserves an explicitly configured zero retry bound', () => {
    const config = normalizeWorkflowConfig(
      workflow({ completion_retry: { retry_instruction: 'retry', max_retry: 0 } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toMatchObject({
      minRetry: 0,
      maxRetry: 0,
    });
  });

  it('leaves completion retry disabled when the field is omitted', () => {
    const config = normalizeWorkflowConfig(
      workflow({ tags: ['review'] }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toBeUndefined();
  });

  it.each([true, false, 'yes', {}])(
    'rejects unsupported completion_retry value %j',
    (completionRetry) => {
      expect(() => normalizeWorkflowConfig(
        workflow({ completion_retry: completionRetry }),
        '/tmp/custom-review.yaml',
        { lang: 'en' },
      )).toThrow();
    },
  );

  it('rejects the removed mode field', () => {
    expect(() => normalizeWorkflowConfig(
      workflow({ completion_retry: { retry_instruction: 'retry', mode: 'follow_up' } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    )).toThrow(/mode|Unrecognized key/);
  });

  it('normalizes explicit retry bounds beyond the internal ceiling', () => {
    const config = normalizeWorkflowConfig(
      workflow({
        completion_retry: { retry_instruction: 'retry', min_retry: 1, max_retry: 8 },
      }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.completionRetry).toMatchObject({
      minRetry: 1,
      maxRetry: 8,
    });
  });
});
