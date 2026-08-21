import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
// Import errors here are expected until then.
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C1  runtime.yaml is read with schema validation (version literal, strict keys)
 * - C4  provider.profiles + 4 provider.targets maps parse
 * - C5/C14 target assignments are `profile` XOR `pool`; defaults use `profile` or `ladder`
 * - C9  auto_routing candidates/router/fallback reference profiles (no inline provider/model)
 * - C17 first-run *active* file shape parses
 * - C18 first-run *inactive* `version: 1` file parses
 * - req4 no indirect `runtime_file` key (strict schema rejects it)
 *
 * These fixtures cover the valid and invalid shapes from order.md:41-103 / 206-217 / 221-223.
 */

/**
 * Loose JSON shape for building intentionally-invalid fixtures without `any`: every leaf the
 * tests mutate is typed `unknown` (or optional) so invalid values stay assignable while key
 * names remain checked.
 */
type LooseRuntimeDoc = {
  version?: unknown;
  provider: {
    defaults?: { profile?: unknown; pool?: unknown; ladder?: unknown };
    profiles: Record<string, { provider?: unknown; model?: unknown; options?: unknown; extends?: unknown }>;
    targets: {
      personas: Record<string, unknown>;
      tags: Record<string, unknown>;
      steps: Record<string, unknown>;
      internal_agents: Record<string, unknown>;
      models?: unknown;
    };
    auto_routing: {
      strategy?: unknown;
      router_profile?: unknown;
      pools: Record<string, { candidates?: Array<Record<string, unknown>>; fallback_profile?: unknown }>;
    };
  };
};

// order.md:41-103 verbatim (as parsed YAML → JS object).
function fullExample(): LooseRuntimeDoc {
  return {
    version: 1,
    provider: {
      defaults: { profile: 'sol-medium' },
      profiles: {
        'sol-high': { provider: 'codex', model: 'gpt-5.6-sol', options: { reasoning_effort: 'high' } },
        'sol-medium': { provider: 'codex', model: 'gpt-5.6-sol', options: { reasoning_effort: 'medium' } },
        'sol-low': { provider: 'codex', model: 'gpt-5.6-sol', options: { reasoning_effort: 'low' } },
        router: { provider: 'codex', model: 'gpt-5.6-luna', options: { reasoning_effort: 'high' } },
      },
      targets: {
        personas: { coder: { profile: 'sol-medium' } },
        tags: { 'high-stakes': { profile: 'sol-high' } },
        steps: { 'default/supervise': { profile: 'sol-high' } },
        internal_agents: { selector: { profile: 'router' } },
      },
      auto_routing: {
        strategy: 'balanced',
        router_profile: 'router',
        pools: {
          'sol-pool': {
            candidates: [
              { profile: 'sol-high', tier: 'high' },
              { profile: 'sol-medium', tier: 'medium' },
              { profile: 'sol-low', tier: 'low' },
            ],
            fallback_profile: 'sol-high',
          },
        },
      },
    },
  };
}

describe('RuntimeProviderFileSchema', () => {
  it('Given the full order.md example, When parsed, Then it is accepted (C4/C5/C9)', () => {
    const result = RuntimeProviderFileSchema.safeParse(fullExample());
    expect(result.success).toBe(true);
  });

  it('Given the first-run active file, When parsed, Then it is accepted (C17)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        defaults: { profile: 'default' },
        profiles: { default: { provider: 'codex', model: 'gpt-5.6-sol' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given defaults.ladder, When parsed, Then it is accepted as a runtime default', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        defaults: { ladder: ['default', 'strong'] },
        profiles: {
          default: { provider: 'mock', model: 'runtime-model' },
          strong: { provider: 'mock', model: 'runtime-strong-model' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['without auto_routing', { profiles: { default: { provider: 'mock', model: 'runtime-model' } } }],
    ['with auto_routing', {
      profiles: { default: { provider: 'mock', model: 'runtime-model' }, router: { provider: 'mock', model: 'router-model' } },
      auto_routing: {
        router_profile: 'router',
        pools: { main: { candidates: [{ profile: 'default', tier: 'low' }], fallback_profile: 'default' } },
      },
    }],
  ])('Given an active provider section %s without defaults, When parsed, Then it is rejected', (_label, provider) => {
    const result = RuntimeProviderFileSchema.safeParse({ version: 1, provider });
    expect(result.success).toBe(false);
  });

  it('Given disabled companion-only targets without defaults, When parsed, Then it remains inactive', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: false },
      provider: {
        profiles: {
          security: { provider: 'mock', model: 'mock-security' },
        },
        targets: { companions: { security: { profile: 'security' } } },
      },
    });

    expect(result.success).toBe(true);
  });

  it('Given enabled companion-only targets without defaults, When parsed, Then it is rejected for missing defaults', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: true },
      provider: {
        targets: { companions: { security: { profile: 'security' } } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('provider.defaults'))).toBe(true);
    }
  });

  it('Given companion-only targets without a companion policy or defaults, When parsed, Then it remains inactive by default', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        targets: { companions: { security: { profile: 'security' } } },
      },
    });

    expect(result.success).toBe(true);
  });

  it('Given defaults.pool with a defined pool and fallback profile, When parsed, Then it is rejected with a pool-specific error', () => {
    const doc = fullExample();
    doc.provider.defaults = { pool: 'sol-pool' };
    const result = RuntimeProviderFileSchema.safeParse(doc);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: ['provider', 'defaults'],
          keys: ['pool'],
        }),
      ]));
    }
  });

  it('Given defaults.pool without auto_routing, When parsed, Then it is rejected at the defaults boundary', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: {
        defaults: { pool: 'pool-a' },
        profiles: { real: { provider: 'mock', model: 'model-real' } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.path.includes('pool')
        || issue.message.includes('pool')
        || issue.message.includes('provider.defaults'))).toBe(true);
    }
  });

  it('Given defaults with profile and ladder together, When parsed, Then the defaults assignment is rejected', () => {
    const doc = fullExample();
    doc.provider.defaults = { profile: 'sol-medium', ladder: ['sol-high'] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given the inactive `version: 1` file, When parsed, Then it is accepted with no provider (C18)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provider).toBeUndefined();
  });

  it('Given a companion policy, When parsed, Then at least one policy field is required and keys stay strict', () => {
    expect(RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: false },
    }).success).toBe(true);
    expect(RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: {},
    }).success).toBe(false);
    expect(RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: false, extra: true },
    }).success).toBe(false);
  });

  it.each(['completion', 'live'] as const)('accepts companion.review_mode %s without enabled', (reviewMode) => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { review_mode: reviewMode },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.companion?.enabled).toBeUndefined();
      expect(result.data.companion?.review_mode).toBe(reviewMode);
    }
  });

  it.each(['completion', 'live'] as const)('accepts companion.review_mode %s and preserves the value', (reviewMode) => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: false, review_mode: reviewMode },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.companion as unknown as { review_mode?: string } | undefined)?.review_mode)
        .toBe(reviewMode);
    }
  });

  it.each([
    ['automatic', 'unknown string'],
    [true, 'boolean'],
  ])('rejects companion.review_mode %j (%s) at the field boundary', (reviewMode, _label) => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      companion: { enabled: false, review_mode: reviewMode },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['companion', 'review_mode'] }),
      ]));
    }
  });

  it('Given a missing version, When parsed, Then it is rejected (C1)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ provider: {} });
    expect(result.success).toBe(false);
  });

  it('Given a version other than 1, When parsed, Then it is rejected (C1)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ version: 2 });
    expect(result.success).toBe(false);
  });

  it('Given an assignment with both profile and pool, When parsed, Then XOR is enforced (C5/C14)', () => {
    const doc = fullExample();
    doc.provider.targets.personas.coder = { profile: 'sol-medium', pool: 'sol-pool' };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an assignment with neither profile nor pool, When parsed, Then it is rejected (C5)', () => {
    const doc = fullExample();
    doc.provider.targets.personas.coder = {};
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an auto_routing candidate with inline provider/model instead of a profile ref, When parsed, Then it is rejected (C9)', () => {
    const doc = fullExample();
    doc.provider.auto_routing.pools['sol-pool']!.candidates![0] = {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      tier: 'high',
    };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an unknown provider.targets map key, When parsed, Then only the four documented maps are allowed (C4)', () => {
    const doc = fullExample();
    doc.provider.targets.models = { foo: { profile: 'sol-high' } };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given a profile provider outside the known provider enum, When parsed, Then it is rejected (C10)', () => {
    const doc = fullExample();
    doc.provider.profiles['sol-high']!.provider = 'not-a-provider';
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given a top-level `runtime_file` indirection key, When parsed, Then the strict schema rejects it (req4)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ version: 1, runtime_file: '~/other.yaml' });
    expect(result.success).toBe(false);
  });

  it('Given a null provider section, When parsed, Then it is rejected (invalid shape)', () => {
    expect(RuntimeProviderFileSchema.safeParse({ version: 1, provider: null }).success).toBe(false);
  });

  it('Given an array provider section, When parsed, Then it is rejected (invalid shape)', () => {
    expect(RuntimeProviderFileSchema.safeParse({ version: 1, provider: [] }).success).toBe(false);
  });

  it('Given profiles as an array, When parsed, Then it is rejected (invalid shape)', () => {
    expect(
      RuntimeProviderFileSchema.safeParse({ version: 1, provider: { profiles: [] } }).success,
    ).toBe(false);
  });

  it('Given profiles as a scalar, When parsed, Then it is rejected (invalid shape)', () => {
    expect(
      RuntimeProviderFileSchema.safeParse({ version: 1, provider: { profiles: 'default' } }).success,
    ).toBe(false);
  });

  it('Given an unknown auto_routing strategy, When parsed, Then the enum rejects it (C9)', () => {
    const doc = fullExample();
    doc.provider.auto_routing.strategy = 'cheapest';
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an unknown candidate tier, When parsed, Then the enum rejects it (C9)', () => {
    const doc = fullExample();
    doc.provider.auto_routing.pools['sol-pool']!.candidates![0] = { profile: 'sol-high', tier: 'ultra' };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an empty candidates array, When parsed, Then the min(1) boundary rejects it (C9)', () => {
    const doc = fullExample();
    doc.provider.auto_routing.pools['sol-pool']!.candidates = [];
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given a pool without a candidates key, When parsed, Then it is rejected (missing value)', () => {
    const doc = fullExample();
    delete doc.provider.auto_routing.pools['sol-pool']!.candidates;
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an empty model string, When parsed, Then it is rejected (missing value)', () => {
    const doc = fullExample();
    doc.provider.profiles['sol-high']!.model = '';
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an empty extends string, When parsed, Then it is rejected (missing value)', () => {
    const doc = fullExample();
    doc.provider.profiles['sol-high']!.extends = '';
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });
});
