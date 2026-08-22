import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import type { AgentWorkflowStep } from '../core/models/index.js';

describe('WorkflowStepRawSchema promotion', () => {
  it('accepts only runtime ladder promotion entries', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [{ at: 3 }, { at: 6 }],
      instruction: '{task}',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promotion).toEqual([{ at: 3 }, { at: 6 }]);
    }
  });

  it('rejects a bare promotion entry', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [{}],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0] }),
      ]));
    }
  });

  it('rejects provider execution fields with runtime.yaml guidance', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      provider: 'codex',
      model: 'gpt-5.5',
      provider_options: { codex: { reasoning_effort: 'high' } },
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['provider'],
          message: expect.stringContaining('runtime.yaml'),
        }),
        expect.objectContaining({
          path: ['model'],
          message: expect.stringContaining('runtime.yaml'),
        }),
        expect.objectContaining({
          path: ['provider_options'],
          message: expect.stringContaining('runtime.yaml'),
        }),
      ]));
    }
  });

  it('rejects a promotion target or condition', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [{ at: 3, provider: 'codex' }, { condition: 'ai("escalate")' }],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ['promotion', 0, 'provider'],
          message: expect.stringContaining('runtime.yaml'),
        }),
        expect.objectContaining({
          path: ['promotion', 1, 'condition'],
          message: expect.stringContaining('runtime.yaml'),
        }),
      ]));
    }
  });

  it('normalizes promotion entries without introducing provider fields', () => {
    const config = normalizeWorkflowConfig({
      name: 'promotion-normalize',
      steps: [{ name: 'implement', instruction: '{task}', promotion: [{ at: 3 }] }],
    }, process.cwd());

    const step = config.steps[0] as AgentWorkflowStep;
    expect(step.promotion).toEqual([{ at: 3 }]);
    expect(step.provider).toBeUndefined();
    expect(step.model).toBeUndefined();
    expect(step.providerOptions).toBeUndefined();
  });

});
