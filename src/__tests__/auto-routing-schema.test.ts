import { describe, expect, it, vi } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  WorkflowConfigRawSchema,
} from '../core/models/index.js';
import type { AutoRoutingConfig, WorkflowConfig } from '../core/models/index.js';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { normalizeAutoRoutingConfig } from '../infra/config/configNormalizers.js';

function createAutoRoutingConfig(overrides: Record<string, unknown> = {}) {
  return {
    strategy: 'cost',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'reasoning',
        description: 'Architecture and ambiguous requirement analysis',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        cost_tier: 'high',
        provider_options: {
          claude: { effort: 'high' },
        },
      },
      {
        name: 'coding',
        description: 'Implementation, tests, debugging, and refactoring',
        provider: 'codex',
        model: 'gpt-5',
        cost_tier: 'medium',
        provider_options: {
          codex: { reasoning_effort: 'high' },
        },
      },
      {
        name: 'lightweight',
        description: 'Formatting and small mechanical edits',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        cost_tier: 'low',
      },
    ],
    rules: {
      tags: {
        implementation: 'coding',
        format: 'lightweight',
      },
      steps: {
        plan: 'reasoning',
      },
      personas: {
        architect: 'reasoning',
      },
    },
    ...overrides,
  };
}

function createRuntimeAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'cost',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'lightweight',
        description: 'Formatting and small mechanical edits',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        costTier: 'low',
      },
    ],
  };
}

function expectParseFailureMessage(result: { success: false; error: Error }, expected: RegExp): void {
  expect(result.error.message).toMatch(expected);
}

describe('auto_routing config schema', () => {
  it('Given provider auto and a valid auto_routing block, When parsing project config, Then the input contract is accepted', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig(),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.provider).toBe('auto');
    expect(result.data.auto_routing).toMatchObject({
      strategy: 'cost',
      router: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
    });
  });

  it('Given provider auto in global config, When auto_routing is valid, Then the global provider remains auto', () => {
    const result = GlobalConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({ strategy: 'balanced' }),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.provider).toBe('auto');
    expect(result.data.auto_routing.strategy).toBe('balanced');
  });

  it('Given provider auto without auto_routing, When parsing project config, Then raw schema accepts layer composition', () => {
    const result = ProjectConfigSchema.safeParse({ provider: 'auto' });

    expect(result.success).toBe(true);
  });

  it('Given duplicate candidate names, When parsing config, Then validation rejects the duplicate candidate', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({
        candidates: [
          {
            name: 'coding',
            description: 'Implementation',
            provider: 'codex',
            model: 'gpt-5',
            cost_tier: 'medium',
          },
          {
            name: 'coding',
            description: 'Review',
            provider: 'claude-sdk',
            model: 'claude-sonnet-4-20250514',
            cost_tier: 'medium',
          },
        ],
      }),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expectParseFailureMessage(result, /duplicate|candidate/i);
  });

  it('Given a rule references an unknown candidate, When parsing config, Then validation rejects the rule reference', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({
        rules: {
          tags: {
            review: 'missing-review-candidate',
          },
        },
      }),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expectParseFailureMessage(result, /missing-review-candidate|candidate/i);
  });

  it('Given a candidate cost_tier outside high medium low, When parsing config, Then validation rejects it', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({
        candidates: [
          {
            name: 'cheap',
            description: 'Very cheap tasks',
            provider: 'claude-sdk',
            model: 'claude-haiku-4-5-20251001',
            cost_tier: 'tiny',
          },
        ],
      }),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expectParseFailureMessage(result, /high|medium|low|cost_tier/i);
  });

  it.each([
    ['cost', 'low'],
    ['balanced', 'medium'],
    ['performance', 'high'],
  ] as const)(
    'Given strategy %s without a %s candidate, When parsing config, Then validation rejects the missing fallback tier',
    (strategy, requiredTier) => {
      const result = ProjectConfigSchema.safeParse({
        provider: 'auto',
        auto_routing: createAutoRoutingConfig({
          strategy,
          candidates: [
            {
              name: 'reasoning',
              description: 'Architecture and ambiguous requirement analysis',
              provider: 'claude-sdk',
              model: 'claude-opus-4-20250514',
              cost_tier: requiredTier === 'high' ? 'medium' : 'high',
            },
          ],
          rules: {},
        }),
      });

      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      expectParseFailureMessage(result, new RegExp(`${requiredTier}|${strategy}|candidate`, 'i'));
    },
  );

  it('Given router or candidate model uses an alias, When parsing config, Then validation requires full model ids', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'opusplan', 'default', 'auto']) {
      const routerResult = ProjectConfigSchema.safeParse({
        provider: 'auto',
        auto_routing: createAutoRoutingConfig({
          router: {
            provider: 'claude-sdk',
            model: alias,
          },
        }),
      });
      expect(routerResult.success).toBe(false);

      const candidateResult = ProjectConfigSchema.safeParse({
        provider: 'auto',
        auto_routing: createAutoRoutingConfig({
          candidates: [
            {
              name: 'coding',
              description: 'Implementation',
              provider: 'codex',
              model: alias,
              cost_tier: 'medium',
            },
          ],
        }),
      });
      expect(candidateResult.success).toBe(false);
    }
  });

  it('Given router or candidate model uses a bare arbitrary name, When parsing config, Then validation requires full model ids', () => {
    const routerResult = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({
        router: {
          provider: 'claude-sdk',
          model: 'foo',
        },
      }),
    });

    expect(routerResult.success).toBe(false);
    if (!routerResult.success) {
      expectParseFailureMessage(routerResult, /full model id/i);
    }

    const candidateResult = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig({
        candidates: [
          {
            name: 'coding',
            description: 'Implementation',
            provider: 'claude-sdk',
            model: 'bar',
            cost_tier: 'medium',
          },
        ],
      }),
    });

    expect(candidateResult.success).toBe(false);
    if (!candidateResult.success) {
      expectParseFailureMessage(candidateResult, /full model id/i);
    }
  });

  it('Given an opencode auto-routing router uses a bare model, When normalizing config, Then provider/model compatibility rejects it', () => {
    expect(() => normalizeAutoRoutingConfig(createAutoRoutingConfig({
      router: {
        provider: 'opencode',
        model: 'big-pickle',
      },
    }))).toThrow(/auto_routing\.router\.model|provider\/model/);
  });

  it('Given an opencode auto-routing candidate uses a bare model, When normalizing config, Then provider/model compatibility rejects it', () => {
    expect(() => normalizeAutoRoutingConfig(createAutoRoutingConfig({
      candidates: [
        {
          name: 'coding',
          description: 'Implementation',
          provider: 'opencode',
          model: 'big-pickle',
          cost_tier: 'medium',
        },
      ],
    }))).toThrow(/auto_routing\.candidates\[0\]\.model|provider\/model/);
  });
});

describe('auto_routing workflow schema', () => {
  it('Given workflow_config provider auto and workflow-level auto_routing, When parsing workflow YAML shape, Then it is accepted', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'auto-routing-workflow',
      workflow_config: {
        provider: 'auto',
      },
      auto_routing: createAutoRoutingConfig({ strategy: 'performance' }),
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          tags: ['implementation'],
          instruction: 'implement',
          rules: [
            { condition: 'done', next: 'COMPLETE' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.workflow_config?.provider).toBe('auto');
    expect(result.data.auto_routing.strategy).toBe('performance');
  });

  it('Given step and parallel sub-step provider auto, When parsing workflow YAML shape, Then both agent entrypoints accept auto', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'auto-routing-step-workflow',
      auto_routing: createAutoRoutingConfig(),
      steps: [
        {
          name: 'reviewers',
          persona: 'reviewer',
          instruction: 'review',
          provider: 'auto',
          parallel: [
            {
              name: 'security-review',
              persona: 'security-reviewer',
              tags: ['review', 'security'],
              provider: 'auto',
              instruction: 'review security',
              rules: [
                { condition: 'approved', next: 'COMPLETE' },
              ],
            },
          ],
          rules: [
            { condition: 'all("approved")', next: 'COMPLETE' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.steps[0]?.provider).toBe('auto');
    expect(result.data.steps[0]?.parallel?.[0]?.provider).toBe('auto');
  });

  it('Given a workflow step provider auto without workflow auto_routing, When parsing workflow YAML shape, Then raw schema accepts config-level auto_routing', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'missing-auto-routing',
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          provider: 'auto',
          instruction: 'implement',
          rules: [
            { condition: 'done', next: 'COMPLETE' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('Given effective config has provider auto without autoRouting, When validating workflow config, Then validation fails fast', () => {
    const workflow: WorkflowConfig = {
      name: 'missing-effective-auto-routing',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          personaDisplayName: 'coder',
          provider: 'auto',
          instruction: 'implement',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(/auto_routing/);
  });

  it('Given workflow-level provider auto without autoRouting, When validating workflow config, Then validation fails fast', () => {
    const workflow: WorkflowConfig = {
      name: 'missing-workflow-auto-routing',
      provider: 'auto',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          personaDisplayName: 'coder',
          instruction: 'implement',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(/auto_routing/);
  });

  it('Given CLI concrete provider overrides workflow-level provider auto, When validating without autoRouting, Then validation accepts the effective provider', () => {
    const workflow: WorkflowConfig = {
      name: 'workflow-auto-overridden-by-cli',
      provider: 'auto',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          personaDisplayName: 'coder',
          provider: 'auto',
          providerSpecified: false,
          instruction: 'implement',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'mock',
      providerSource: 'cli',
    })).not.toThrow();
  });

  it('Given CLI concrete provider overrides inherited parallel provider auto, When validating without autoRouting, Then validation accepts the effective provider', () => {
    const workflow: WorkflowConfig = {
      name: 'parallel-workflow-auto-overridden-by-cli',
      provider: 'auto',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'coding-review',
              persona: 'reviewer',
              provider: 'auto',
              providerSpecified: false,
              instruction: 'review code',
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'mock',
      providerSource: 'cli',
    })).not.toThrow();
  });

  it('Given explicit step-level provider auto and CLI concrete provider, When validating without autoRouting, Then validation fails fast', () => {
    const workflow: WorkflowConfig = {
      name: 'explicit-step-auto-with-cli-provider',
      provider: 'auto',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          personaDisplayName: 'coder',
          provider: 'auto',
          providerSpecified: true,
          instruction: 'implement',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      provider: 'mock',
      providerSource: 'cli',
    })).toThrow(/auto_routing/);
  });

  it('Given parallel sub-step provider auto without autoRouting, When validating workflow config, Then validation fails fast', () => {
    const workflow: WorkflowConfig = {
      name: 'missing-parallel-auto-routing',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'coding-review',
              persona: 'reviewer',
              provider: 'auto',
              instruction: 'review code',
            },
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, { projectCwd: process.cwd() })).toThrow(/auto_routing/);
    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createRuntimeAutoRoutingConfig(),
    })).not.toThrow();
  });

  it('Given workflow_call override provider auto without autoRouting, When validating workflow config, Then validation fails fast', () => {
    const workflow: WorkflowConfig = {
      name: 'missing-workflow-call-auto-routing',
      initialStep: 'call-child',
      maxSteps: 1,
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child',
          overrides: { provider: 'auto' },
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      workflowCallResolver: () => workflow,
    })).toThrow(/auto_routing/);
    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createRuntimeAutoRoutingConfig(),
      workflowCallResolver: () => workflow,
    })).not.toThrow();
  });

  it('Given parallel workflow_call child workflow top-level provider auto without parent override, When validating workflow config, Then validation fails fast', () => {
    const childWorkflow: WorkflowConfig = {
      name: 'parallel-child-auto-provider',
      provider: 'auto',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'review',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    const parentWorkflow: WorkflowConfig = {
      name: 'parent-with-parallel-child-auto-provider',
      initialStep: 'reviewers',
      maxSteps: 1,
      steps: [
        {
          name: 'reviewers',
          personaDisplayName: 'reviewers',
          instruction: 'review',
          parallel: [
            {
              name: 'call-child',
              kind: 'workflow_call',
              call: 'parallel-child-auto-provider',
              personaDisplayName: 'call-child',
              instruction: '',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
        },
      ],
    };
    const resolver = vi.fn(() => childWorkflow);

    expect(() => validateWorkflowConfig(parentWorkflow, {
      projectCwd: process.cwd(),
      workflowCallResolver: resolver,
    })).toThrow(/auto_routing/);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      parentWorkflow,
      step: parentWorkflow.steps[0]!.parallel![0],
    }));
    expect(() => validateWorkflowConfig(parentWorkflow, {
      projectCwd: process.cwd(),
      autoRouting: createRuntimeAutoRoutingConfig(),
      workflowCallResolver: resolver,
    })).not.toThrow();
  });

  it('Given workflow_call resolver throws during auto provider validation, When validating workflow config, Then the resolver error propagates', () => {
    const parentWorkflow: WorkflowConfig = {
      name: 'parent-with-broken-child',
      initialStep: 'call-child',
      maxSteps: 1,
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'missing-child',
          personaDisplayName: 'call-child',
          instruction: '',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    };

    expect(() => validateWorkflowConfig(parentWorkflow, {
      projectCwd: process.cwd(),
      workflowCallResolver: () => {
        throw new Error('resolver boom');
      },
    })).toThrow('resolver boom');
  });

  it('Given workflow_call child workflow top-level provider auto without parent override, When validating workflow config, Then validation fails fast', () => {
    const childWorkflow: WorkflowConfig = {
      name: 'child-auto-provider',
      provider: 'auto',
      initialStep: 'review',
      maxSteps: 1,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          personaDisplayName: 'reviewer',
          instruction: 'review',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    const parentWorkflow: WorkflowConfig = {
      name: 'parent-with-child-auto-provider',
      initialStep: 'call-child',
      maxSteps: 1,
      steps: [
        {
          name: 'call-child',
          kind: 'workflow_call',
          call: 'child-auto-provider',
          personaDisplayName: 'call-child',
          instruction: '',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    };
    const resolver = vi.fn(() => childWorkflow);

    expect(() => validateWorkflowConfig(parentWorkflow, {
      projectCwd: process.cwd(),
      workflowCallResolver: resolver,
    })).toThrow(/auto_routing/);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      parentWorkflow,
      step: parentWorkflow.steps[0],
    }));
    expect(() => validateWorkflowConfig(parentWorkflow, {
      projectCwd: process.cwd(),
      autoRouting: createRuntimeAutoRoutingConfig(),
      workflowCallResolver: resolver,
    })).not.toThrow();
  });

  it('Given effective config has provider auto with config-level autoRouting, When validating workflow config, Then it is accepted', () => {
    const workflow: WorkflowConfig = {
      name: 'effective-auto-routing',
      initialStep: 'implement',
      maxSteps: 1,
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          personaDisplayName: 'coder',
          provider: 'auto',
          instruction: 'implement',
          passPreviousResponse: true,
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    expect(() => validateWorkflowConfig(workflow, {
      projectCwd: process.cwd(),
      autoRouting: createRuntimeAutoRoutingConfig(),
    })).not.toThrow();
  });
});
