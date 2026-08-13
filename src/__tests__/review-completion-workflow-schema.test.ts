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

describe('review completion workflow contract', () => {
  it('normalizes the required retry instruction and retry defaults', () => {
    const config = normalizeWorkflowConfig(
      workflow({ review_completion: { retry_instruction: 'retry' } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.reviewCompletion).toEqual({
      minRetry: 0,
      maxRetry: 1,
      retryInstruction: 'Close only the supplied gaps.',
    });
  });

  it('leaves review completion disabled when the field is omitted', () => {
    const config = normalizeWorkflowConfig(
      workflow({ tags: ['review'] }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.reviewCompletion).toBeUndefined();
  });

  it.each([true, false, 'yes', {}])(
    'rejects unsupported review_completion value %j',
    (reviewCompletion) => {
      expect(() => normalizeWorkflowConfig(
        workflow({ review_completion: reviewCompletion }),
        '/tmp/custom-review.yaml',
        { lang: 'en' },
      )).toThrow();
    },
  );

  it('rejects the removed mode field', () => {
    expect(() => normalizeWorkflowConfig(
      workflow({ review_completion: { retry_instruction: 'retry', mode: 'follow_up' } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    )).toThrow(/mode|Unrecognized key/);
  });

  it('normalizes explicit retry bounds', () => {
    const config = normalizeWorkflowConfig(
      workflow({
        review_completion: { retry_instruction: 'retry', min_retry: 1, max_retry: 2 },
      }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.reviewCompletion).toMatchObject({
      minRetry: 1,
      maxRetry: 2,
    });
  });
});
