import { describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function workflow(step: Record<string, unknown>) {
  return {
    name: 'custom-review',
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
  it.each(['en', 'ja'] as const)(
    'loads the %s builtin default retry instruction for a tag-only custom workflow',
    (lang) => {
      const config = normalizeWorkflowConfig(
        workflow({ tags: ['review-completion'] }),
        '/tmp/custom-review.yaml',
        { lang },
      );

      expect(config.steps[0]?.reviewCompletion).toMatchObject({
        mode: 'initial',
        minRetry: 0,
        maxRetry: 1,
      });
      expect(config.steps[0]?.reviewCompletion?.retryInstruction.trim().length).toBeGreaterThan(0);
    },
  );

  it('rejects review_completion options without the opt-in tag', () => {
    expect(() => normalizeWorkflowConfig(
      workflow({ review_completion: { max_retry: 2 } }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    )).toThrow(/review_completion requires/);
  });

  it('normalizes an explicit follow_up mode', () => {
    const config = normalizeWorkflowConfig(
      workflow({
        tags: ['review-completion'],
        review_completion: { mode: 'follow_up', min_retry: 1, max_retry: 2 },
      }),
      '/tmp/custom-review.yaml',
      { lang: 'en' },
    );

    expect(config.steps[0]?.reviewCompletion).toMatchObject({
      mode: 'follow_up',
      minRetry: 1,
      maxRetry: 2,
    });
  });
});
