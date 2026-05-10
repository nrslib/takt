import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import type { AgentWorkflowStep } from '../core/models/index.js';

describe('WorkflowStepRawSchema promotion', () => {
  it('accepts promotion entries with at, condition, provider, model, and provider_options', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      provider: 'codex',
      model: 'gpt-5.4',
      promotion: [
        {
          at: 3,
          model: 'gpt-5.5',
        },
        {
          condition: 'ai("environment needs escalation")',
          provider: {
            type: 'codex',
            model: 'gpt-5.5',
            network_access: true,
          },
          provider_options: {
            codex: {
              reasoning_effort: 'high',
            },
          },
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promotion).toHaveLength(2);
    }
  });

  it('rejects promotion entries without at or condition', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          model: 'gpt-5.5',
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0] }),
      ]));
    }
  });

  it('rejects promotion entries without a target override', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          at: 3,
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0] }),
      ]));
    }
  });

  it('rejects promotion entries with empty provider_options as the only target', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          at: 3,
          provider_options: {},
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0, 'provider_options'] }),
      ]));
    }
  });

  it('rejects promotion entries with empty nested provider_options as the only target', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          at: 3,
          provider_options: {
            codex: {},
          },
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0, 'provider_options'] }),
      ]));
    }
  });

  it('rejects promotion entries with non-positive at values', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          at: 0,
          model: 'gpt-5.5',
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0, 'at'] }),
      ]));
    }
  });

  it('rejects promotion condition values that are not ai() expressions', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'implement',
      promotion: [
        {
          condition: 'environment needs escalation',
          model: 'gpt-5.5',
        },
      ],
      instruction: '{task}',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion', 0, 'condition'] }),
      ]));
    }
  });

  it('rejects promotion on system steps', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'collect-context',
      kind: 'system',
      promotion: [
        {
          at: 2,
          model: 'gpt-5.5',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion'] }),
      ]));
    }
  });

  it('rejects promotion on workflow_call steps', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'delegate',
      kind: 'workflow_call',
      call: 'shared/review',
      promotion: [
        {
          at: 2,
          model: 'gpt-5.5',
        },
      ],
      rules: [
        {
          condition: 'COMPLETE',
          next: 'COMPLETE',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion'] }),
      ]));
    }
  });

  it('rejects promotion on parallel sub-steps', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      parallel: [
        {
          name: 'arch-review',
          promotion: [
            {
              at: 2,
              model: 'gpt-5.5',
            },
          ],
          instruction: 'Review architecture',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['parallel', 0, 'promotion'] }),
      ]));
    }
  });

  it('rejects promotion on delegated root agent steps', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'reviewers',
      promotion: [
        {
          at: 2,
          model: 'gpt-5.5',
        },
      ],
      parallel: [
        {
          name: 'arch-review',
          instruction: 'Review architecture',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['promotion'] }),
      ]));
    }
  });
});

describe('normalizeWorkflowConfig promotion', () => {
  it('normalizes provider_options-only promotion entries from raw workflow config', () => {
    const config = normalizeWorkflowConfig({
      name: 'promotion-provider-options-only',
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
          promotion: [
            {
              at: 1,
              provider_options: {
                codex: {
                  reasoning_effort: 'high',
                },
              },
            },
          ],
        },
      ],
    }, process.cwd());

    const step = config.steps[0] as AgentWorkflowStep;

    expect(step.promotion).toHaveLength(1);
    expect(step.promotion?.[0]).toMatchObject({
      at: 1,
      providerOptions: {
        codex: {
          reasoningEffort: 'high',
        },
      },
    });
    expect(step.promotion?.[0]?.provider).toBeUndefined();
    expect(step.promotion?.[0]?.model).toBeUndefined();
  });

  it('normalizes promotion entries with the same provider/model/options rules as a step', () => {
    const config = normalizeWorkflowConfig({
      name: 'promotion-normalize',
      workflow_config: {
        provider: 'codex',
        model: 'gpt-5.4',
        provider_options: {
          codex: {
            reasoning_effort: 'medium',
          },
        },
      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
          promotion: [
            {
              at: 3,
              model: 'gpt-5.5',
              provider_options: {
                codex: {
                  reasoning_effort: 'high',
                },
              },
            },
            {
              condition: 'ai("sandbox or network access is required")',
              provider: {
                type: 'codex',
                model: 'gpt-5.5',
                network_access: true,
              },
            },
          ],
        },
      ],
    }, process.cwd());

    const step = config.steps[0] as AgentWorkflowStep & {
      promotion?: Array<{
        at?: number;
        condition?: string;
        aiConditionText?: string;
        provider?: string;
        model?: string;
        providerOptions?: unknown;
      }>;
    };

    expect(step.promotion).toHaveLength(2);
    expect(step.promotion?.[0]).toMatchObject({
      at: 3,
      model: 'gpt-5.5',
      providerOptions: {
        codex: {
          reasoningEffort: 'high',
        },
      },
    });
    expect(step.promotion?.[1]).toMatchObject({
      condition: 'ai("sandbox or network access is required")',
      aiConditionText: 'sandbox or network access is required',
      provider: 'codex',
      providerSpecified: true,
      model: 'gpt-5.5',
      providerOptions: {
        codex: {
          networkAccess: true,
        },
      },
    });
  });
});
