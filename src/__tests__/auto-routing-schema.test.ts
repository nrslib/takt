import { describe, expect, it } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
  WorkflowConfigRawSchema,
} from '../core/models/index.js';
import {
  denormalizeAutoRoutingConfig,
  normalizeAutoRoutingConfig,
} from '../infra/config/configNormalizers.js';

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
        routing_tier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation, tests, debugging, and refactoring',
        provider: 'codex',
        model: 'gpt-5',
        routing_tier: 'medium',
        provider_options: {
          codex: { reasoning_effort: 'high' },
        },
      },
      {
        name: 'lightweight',
        description: 'Formatting and small mechanical edits',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        routing_tier: 'low',
      },
    ],
    default_pool: 'general',
    candidate_pools: {
      general: { candidates: ['lightweight', 'coding', 'reasoning'], fallback: 'reasoning' },
      implementation: { candidates: ['coding', 'reasoning'], fallback: 'reasoning' },
    },
    pool_rules: { tags: { implementation: 'implementation' } },
    rules: {
      tags: { review: 'reasoning', format: 'lightweight' },
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
      const result = schema.safeParse({ provider: 'auto', auto_routing: createAutoRoutingConfig() });

      expect(result.success).toBe(false);
      if (!result.success) expectParseFailureMessage(result, /provider|auto/i);
    },
  );

  it('Given a concrete provider and complete routing pools, When parsing project config, Then both independent contracts are accepted', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      model: 'project-model',
      auto_routing: createAutoRoutingConfig(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.auto_routing).toMatchObject({
      strategy: 'cost',
      default_pool: 'general',
      candidate_pools: { implementation: { fallback: 'reasoning' } },
    });
  });

  it('Given candidates with and without description, When parsing and round-tripping auto_routing, Then optional metadata is preserved only when present', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidates: [
          {
            name: 'undocumented',
            provider: 'codex',
            model: 'gpt-5',
            routing_tier: 'medium',
          },
          {
            name: 'documented',
            description: 'Human-readable candidate metadata',
            provider: 'claude-sdk',
            model: 'claude-opus-4-20250514',
            routing_tier: 'high',
          },
        ],
        candidate_pools: {
          general: { candidates: ['undocumented', 'documented'], fallback: 'documented' },
          implementation: { candidates: ['undocumented', 'documented'], fallback: 'documented' },
        },
        rules: {},
      }),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const normalized = normalizeAutoRoutingConfig(result.data.auto_routing);
    expect(normalized?.candidates).toEqual([
      expect.objectContaining({ name: 'undocumented' }),
      expect.objectContaining({ name: 'documented', description: 'Human-readable candidate metadata' }),
    ]);
    expect(normalized?.candidates[0]).not.toHaveProperty('description');

    const denormalized = denormalizeAutoRoutingConfig(normalized);
    expect(denormalized?.candidates).toEqual([
      expect.objectContaining({ name: 'undocumented' }),
      expect.objectContaining({ name: 'documented', description: 'Human-readable candidate metadata' }),
    ]);
    expect(denormalized?.candidates[0]).not.toHaveProperty('description');
  });

  it('Given a legacy cost_tier candidate, When parsing config, Then strict validation rejects the removed field', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidates: [{
          name: 'coding', description: 'Implementation', provider: 'codex', model: 'gpt-5', cost_tier: 'medium',
        }],
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) expectParseFailureMessage(result, /cost_tier|unrecognized/i);
  });

  it('Given a candidate routing_tier outside high medium low, When parsing config, Then validation rejects it', () => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidates: [{
          name: 'cheap', description: 'Very cheap tasks', provider: 'claude-sdk',
          model: 'claude-haiku-4-5-20251001', routing_tier: 'tiny',
        }],
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) expectParseFailureMessage(result, /high|medium|low|routing_tier/i);
  });

  it.each([
    ['unknown default pool', { default_pool: 'missing' }, /default.*pool|missing/i],
    ['unknown pool candidate', {
      candidate_pools: { general: { candidates: ['missing'], fallback: 'missing' } },
    }, /candidate|missing/i],
    ['fallback outside pool', {
      candidate_pools: { general: { candidates: ['coding'], fallback: 'reasoning' } },
    }, /fallback|pool/i],
  ])('Given %s, When parsing config, Then pool references fail fast', (_name, overrides, expected) => {
    const result = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig(overrides),
    });

    expect(result.success).toBe(false);
    if (!result.success) expectParseFailureMessage(result, expected);
  });

  it('Given an opencode auto-routing candidate uses a bare model, When normalizing config, Then provider compatibility rejects it', () => {
    expect(() => normalizeAutoRoutingConfig(createAutoRoutingConfig({
      candidates: [{
        name: 'coding', description: 'Implementation', provider: 'opencode',
        model: 'big-pickle', routing_tier: 'medium',
      }],
    }))).toThrow(/auto_routing\.candidates\[0\]\.model|provider\/model/);
  });
});

describe('auto_routing workflow schema', () => {
  it('Given a concrete workflow provider and complete routing pools, When parsing workflow YAML, Then the workflow contract is accepted', () => {
    const result = WorkflowConfigRawSchema.safeParse(createWorkflow({
      workflow_config: { provider: 'mock', model: 'workflow-model' },
      auto_routing: createAutoRoutingConfig({ strategy: 'performance' }),
    }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.auto_routing?.strategy).toBe('performance');
  });

  it('Given default_provider in workflow auto_routing, When parsing workflow YAML, Then strict validation rejects the removed key', () => {
    const result = WorkflowConfigRawSchema.safeParse(createWorkflow({
      workflow_config: { provider: 'mock' },
      auto_routing: createAutoRoutingConfig({
        default_provider: { provider: 'mock', model: 'unused-model' },
      }),
    }));

    expect(result.success).toBe(false);
    if (!result.success) expectParseFailureMessage(result, /default_provider|unrecognized/i);
  });
});
