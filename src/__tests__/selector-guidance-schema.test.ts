import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/workflow-schemas.js';

describe('selector guidance schema', () => {
  it('accepts guidance on both dynamic facet and dynamic parallel selectors', () => {
    const dynamicFacets = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'Implement the task',
      dynamic_facets: {
        pool: 'implementation-facets',
        selector: {
          instruction: 'select-implementation-facets',
        },
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });
    const dynamicParallel = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      parallel: {
        pool: [{
          name: 'frontend',
          description: 'Review frontend changes',
          instruction: 'Review frontend changes',
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        }],
          selection: {
            mode: 'replace',
            selector: {
              persona: 'reviewer-selector',
              instruction: 'select-reviewers',
            },
        },
      },
      rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
    });

    expect(dynamicFacets.success).toBe(true);
    expect(dynamicParallel.success).toBe(true);
  });

  it.each([
    ['empty selector', {}],
    ['persona-only selector', { persona: 'facet-selector' }],
  ])('rejects %s because instruction is required', (_label, selector) => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      instruction: 'Implement the task',
      dynamic_facets: {
        pool: 'implementation-facets',
        selector,
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['dynamic facet selector', {
      name: 'implement',
      instruction: 'Implement the task',
      dynamic_facets: {
        pool: 'implementation-facets',
        selector: {
          instruction: 'select-implementation-facets',
          policy: 'choose-by-policy',
        },
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    }],
    ['dynamic parallel selector', {
      name: 'reviewers',
      parallel: {
        pool: [{
          name: 'frontend',
          description: 'Review frontend changes',
          instruction: 'Review frontend changes',
          rules: [{ condition: 'approved', next: 'COMPLETE' }],
        }],
        selection: {
          mode: 'replace',
          selector: {
            instruction: 'select-reviewers',
            policy: 'choose-by-policy',
          },
        },
      },
      rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
    }],
  ])('rejects unsupported selector fields for %s', (_label, step) => {
    expect(WorkflowStepRawSchema.safeParse(step).success).toBe(false);
  });
});
