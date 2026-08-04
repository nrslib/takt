import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
// Import errors here are expected until then.
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C1  runtime.yaml is read with schema validation (version literal, strict keys)
 * - C4  provider.profiles + 4 provider.targets maps parse
 * - C5/C14 each target/defaults assignment is `profile` XOR `pool`
 * - C9  auto_routing candidates/router/fallback reference profiles (no inline provider/model)
 * - C17 first-run *active* file shape parses
 * - C18 first-run *inactive* `version: 1` file parses
 * - req4 no indirect `runtime_file` key (strict schema rejects it)
 *
 * These are the literal shapes from order.md:41-103 / 206-217 / 221-223.
 */

// order.md:41-103 verbatim (as parsed YAML → JS object).
function fullExample(): unknown {
  return {
    version: 1,
    provider: {
      defaults: { pool: 'sol-pool' },
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

  it('Given the inactive `version: 1` file, When parsed, Then it is accepted with no provider (C18)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.provider).toBeUndefined();
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
    const doc: any = fullExample();
    doc.provider.targets.personas.coder = { profile: 'sol-medium', pool: 'sol-pool' };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an assignment with neither profile nor pool, When parsed, Then it is rejected (C5)', () => {
    const doc: any = fullExample();
    doc.provider.targets.personas.coder = {};
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an auto_routing candidate with inline provider/model instead of a profile ref, When parsed, Then it is rejected (C9)', () => {
    const doc: any = fullExample();
    doc.provider.auto_routing.pools['sol-pool'].candidates[0] = {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      tier: 'high',
    };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given an unknown provider.targets map key, When parsed, Then only the four documented maps are allowed (C4)', () => {
    const doc: any = fullExample();
    doc.provider.targets.models = { foo: { profile: 'sol-high' } };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given a profile provider outside the known provider enum, When parsed, Then it is rejected (C10)', () => {
    const doc: any = fullExample();
    doc.provider.profiles['sol-high'].provider = 'not-a-provider';
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

  it('Given an empty candidates array, When parsed, Then the min(1) boundary rejects it (C9)', () => {
    const doc: any = fullExample();
    doc.provider.auto_routing.pools['sol-pool'].candidates = [];
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given a pool without a candidates key, When parsed, Then it is rejected (missing value)', () => {
    const doc: any = fullExample();
    delete doc.provider.auto_routing.pools['sol-pool'].candidates;
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an empty model string, When parsed, Then it is rejected (missing value)', () => {
    const doc: any = fullExample();
    doc.provider.profiles['sol-high'].model = '';
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('Given an empty extends string, When parsed, Then it is rejected (missing value)', () => {
    const doc: any = fullExample();
    doc.provider.profiles['sol-high'].extends = '';
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });
});
