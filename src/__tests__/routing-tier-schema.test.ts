import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '../core/models/index.js';
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
        name: 'terra',
        description: 'Local implementation and focused fixes',
        provider: 'codex',
        model: 'gpt-5',
        routing_tier: 'medium',
      },
      {
        name: 'sol',
        description: 'Complex implementation and review work',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        routing_tier: 'high',
      },
    ],
    default_pool: 'general',
    candidate_pools: {
      general: {
        candidates: ['terra', 'sol'],
        fallback: 'sol',
      },
      implementation: {
        candidates: ['terra', 'sol'],
        fallback: 'sol',
      },
    },
    pool_rules: {
      tags: { implementation: 'implementation' },
    },
    ...overrides,
  };
}

describe('routing_tier と candidate pool の設定契約', () => {
  it('Given routing_tier と参照整合した candidate pool, When parsing and normalizing config, Then the normalized candidate and pool are preserved', () => {
    const rawAutoRouting = createAutoRoutingConfig();
    const parsed = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: rawAutoRouting,
    });

    expect(parsed.success).toBe(true);
    expect(normalizeAutoRoutingConfig(rawAutoRouting)).toMatchObject({
      candidates: [
        { name: 'terra', routingTier: 'medium' },
        { name: 'sol', routingTier: 'high' },
      ],
      defaultPool: 'general',
      candidatePools: {
        implementation: {
          candidates: ['terra', 'sol'],
          fallback: 'sol',
        },
      },
    });
  });

  it('Given a pool fallback outside its candidate list, When parsing config, Then validation rejects the configuration', () => {
    const parsed = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        candidate_pools: {
          general: {
            candidates: ['terra'],
            fallback: 'sol',
          },
        },
      }),
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toMatch(/fallback.*pool|pool.*fallback/i);
    }
  });

  it('Given a pool rule references an unknown pool, When parsing config, Then validation rejects the configuration before execution', () => {
    const parsed = ProjectConfigSchema.safeParse({
      provider: 'mock',
      auto_routing: createAutoRoutingConfig({
        pool_rules: {
          steps: { implement: 'missing-pool' },
        },
      }),
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toMatch(/missing-pool|pool/i);
    }
  });
});
