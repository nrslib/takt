import { describe, expect, it } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  WorkflowConfigRawSchema,
} from '../core/models/index.js';
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
      tags: { implementation: 'coding' },
      steps: { plan: 'reasoning' },
      personas: { architect: 'reasoning' },
    },
    ...overrides,
  };
}

function createAgentStep(overrides: Record<string, unknown> = {}) {
  return {
    name: 'implement',
    persona: 'coder',
    instruction: 'implement',
    rules: [{ condition: 'done', next: 'COMPLETE' }],
    ...overrides,
  };
}

function createWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'auto-routing-workflow',
    workflow_config: {},
    steps: [createAgentStep()],
    ...overrides,
  };
}

function expectParseFailureMessage(result: { success: false; error: Error }, expected: RegExp): void {
  expect(result.error.message).toMatch(expected);
}

describe('auto_routing config schema', () => {
  it.each([
    ['global', GlobalConfigSchema],
    ['project', ProjectConfigSchema],
  ] as const)(
    'Given provider auto in %s config, When parsing the config, Then concrete-provider validation rejects it',
    (_name, schema) => {
      const result = schema.safeParse({
        provider: 'auto',
        auto_routing: createAutoRoutingConfig(),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expectParseFailureMessage(result, /provider|auto/i);
      }
    },
  );

  it('Given a legacy provider auto config, When schema validation rejects it, Then the error explains the concrete-provider migration', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'auto',
      auto_routing: createAutoRoutingConfig(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expectParseFailureMessage(result, /concrete provider/i);
      expectParseFailureMessage(result, /auto_routing/i);
    }
  });

  it.each([
    ['global', GlobalConfigSchema],
    ['project', ProjectConfigSchema],
  ] as const)(
    'Given default_provider in %s auto_routing, When parsing the config, Then the removed key is rejected',
    (_name, schema) => {
      const result = schema.safeParse({
        provider: 'mock',
        auto_routing: createAutoRoutingConfig({
          default_provider: { provider: 'codex', model: 'gpt-5' },
        }),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expectParseFailureMessage(result, /default_provider|unrecognized/i);
      }
    },
  );

  it('Given legacy default_provider, When schema validation rejects it, Then the error explains the top-level provider and model migration', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        default_provider: { provider: 'codex', model: 'gpt-5' },
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expectParseFailureMessage(result, /default_provider/i);
      expectParseFailureMessage(result, /top-level.*provider.*model|provider.*model.*top-level/is);
    }
  });

  it('Given a concrete provider and auto_routing, When parsing project config, Then both independent contracts are accepted', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      model: 'project-model',
      auto_routing: createAutoRoutingConfig(),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.provider).toBe('mock');
    expect(result.data.model).toBe('project-model');
    expect(result.data.auto_routing).toMatchObject({
      strategy: 'cost',
      router: {
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
      },
    });
  });

  it('Given duplicate candidate names, When parsing config, Then validation rejects the duplicate candidate', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
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
    if (!result.success) {
      expectParseFailureMessage(result, /duplicate|candidate/i);
    }
  });

  it('Given a rule references an unknown candidate, When parsing config, Then validation rejects the rule reference', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        rules: { tags: { review: 'missing-review-candidate' } },
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expectParseFailureMessage(result, /missing-review-candidate|candidate/i);
    }
  });

  it.each([
    ['cost', 'low'],
    ['balanced', 'medium'],
    ['performance', 'high'],
  ] as const)(
    'Given strategy %s without a %s candidate, When parsing config, Then validation rejects the missing fallback tier',
    (strategy, requiredTier) => {
      const result = ProjectConfigSchema.safeParse({
        provider: 'mock',
        auto_routing: createAutoRoutingConfig({
          strategy,
          candidates: [{
            name: 'reasoning',
            description: 'Architecture analysis',
            provider: 'claude-sdk',
            model: 'claude-opus-4-20250514',
            cost_tier: requiredTier === 'high' ? 'medium' : 'high',
          }],
          rules: {},
        }),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expectParseFailureMessage(result, new RegExp(`${requiredTier}|${strategy}|candidate`, 'i'));
      }
    },
  );

  it('Given router or candidate model uses an alias, When parsing config, Then validation requires full model ids', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'opusplan', 'default', 'auto']) {
      const routerResult = ProjectConfigSchema.safeParse({
        provider: 'mock',
        auto_routing: createAutoRoutingConfig({
          router: { provider: 'claude-sdk', model: alias },
        }),
      });
      expect(routerResult.success).toBe(false);

      const candidateResult = ProjectConfigSchema.safeParse({
        provider: 'mock',
        auto_routing: createAutoRoutingConfig({
          candidates: [{
            name: 'coding',
            description: 'Implementation',
            provider: 'codex',
            model: alias,
            cost_tier: 'medium',
          }],
        }),
      });
      expect(candidateResult.success).toBe(false);
    }
  });

  it('Given a candidate cost_tier outside high medium low, When parsing config, Then validation rejects it', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidates: [{
          name: 'cheap',
          description: 'Very cheap tasks',
          provider: 'claude-sdk',
          model: 'claude-haiku-4-5-20251001',
          cost_tier: 'tiny',
        }],
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expectParseFailureMessage(result, /high|medium|low|cost_tier/i);
    }
  });

  it('Given router or candidate model uses a bare arbitrary name, When parsing config, Then validation requires full model ids', () => {
    const routerResult = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        router: { provider: 'claude-sdk', model: 'foo' },
      }),
    });
    expect(routerResult.success).toBe(false);
    if (!routerResult.success) {
      expectParseFailureMessage(routerResult, /full model id/i);
    }

    const candidateResult = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidates: [{
          name: 'coding',
          description: 'Implementation',
          provider: 'claude-sdk',
          model: 'bar',
          cost_tier: 'medium',
        }],
      }),
    });
    expect(candidateResult.success).toBe(false);
    if (!candidateResult.success) {
      expectParseFailureMessage(candidateResult, /full model id/i);
    }
  });

  it('Given an opencode auto-routing router uses a bare model, When normalizing config, Then provider compatibility rejects it', () => {
    expect(() => normalizeAutoRoutingConfig(createAutoRoutingConfig({
      router: { provider: 'opencode', model: 'big-pickle' },
    }))).toThrow(/auto_routing\.router\.model|provider\/model/);
  });

  it('Given an opencode auto-routing candidate uses a bare model, When normalizing config, Then provider compatibility rejects it', () => {
    expect(() => normalizeAutoRoutingConfig(createAutoRoutingConfig({
      candidates: [{
        name: 'coding',
        description: 'Implementation',
        provider: 'opencode',
        model: 'big-pickle',
        cost_tier: 'medium',
      }],
    }))).toThrow(/auto_routing\.candidates\[0\]\.model|provider\/model/);
  });
});

describe('auto_routing workflow schema', () => {
  it('Given a concrete workflow provider and auto_routing, When parsing workflow YAML, Then the workflow contract is accepted', () => {
    const result = WorkflowConfigRawSchema.safeParse(createWorkflow({
      workflow_config: { provider: 'mock', model: 'workflow-model' },
      auto_routing: createAutoRoutingConfig({ strategy: 'performance' }),
    }));

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.workflow_config.provider).toBe('mock');
    expect(result.data.auto_routing?.strategy).toBe('performance');
  });

  it.each([
    ['workflow_config', createWorkflow({ workflow_config: { provider: 'auto' } })],
    ['agent step', createWorkflow({ steps: [createAgentStep({ provider: 'auto' })] })],
    ['parallel sub-step', createWorkflow({
      steps: [{
        name: 'reviews',
        parallel: [createAgentStep({ name: 'security', provider: 'auto' })],
        rules: [{ condition: 'all("done")', next: 'COMPLETE' }],
      }],
    })],
    ['loop monitor judge', createWorkflow({
      loop_monitors: [{
        cycle: ['implement', 'implement'],
        judge: {
          provider: 'auto',
          rules: [{ condition: 'stop', next: 'ABORT' }],
        },
      }],
    })],
    ['workflow_call override', createWorkflow({
      steps: [{
        name: 'call-child',
        kind: 'workflow_call',
        call: 'child',
        overrides: { provider: 'auto' },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    })],
  ])(
    'Given provider auto at the %s boundary, When parsing workflow YAML, Then validation rejects it',
    (_boundary, workflow) => {
      const result = WorkflowConfigRawSchema.safeParse(workflow);

      expect(result.success).toBe(false);
      if (!result.success) {
        expectParseFailureMessage(result, /provider|auto/i);
      }
    },
  );

  it('Given default_provider in workflow auto_routing, When parsing workflow YAML, Then strict validation rejects the removed key', () => {
    const result = WorkflowConfigRawSchema.safeParse(createWorkflow({
      workflow_config: { provider: 'mock' },
      auto_routing: createAutoRoutingConfig({
        default_provider: { provider: 'mock', model: 'unused-model' },
      }),
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expectParseFailureMessage(result, /default_provider|unrecognized/i);
    }
  });

});
