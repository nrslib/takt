import { describe, expect, it } from 'vitest';
import { compileRuntimeProviderEnvironment } from '../infra/config/runtime-provider/environment.js';
import type { RuntimeProviderSection } from '../infra/config/runtime-provider/schema.js';

/**
 * Issue #1208 Stage 1 — a `ladder` assignment is honored at its initial stage when compiling the
 * runtime provider environment, so a ladder target is never silently dropped to defaults.
 *
 * The promotion-driven stage progression (CT-LAD-2/3/4) is the runtime resolution seam deferred to a
 * later cycle; these tests pin the load-time invariant that the ladder's FIRST profile becomes the
 * initial routing assignment on EVERY assignment path the schema/policy accept — defaults,
 * internal_agents.selector, internal_agents.assistant, personas, tags, and steps — not only on the
 * `targets.steps` path the reviewer's excerpt happened to reach.
 */

const PROFILES = {
  base: { provider: 'mock', model: 'base-model' },
  main: { provider: 'opencode', model: 'ollama-cloud/glm-5.2' },
  strong: { provider: 'claude', model: 'opus' },
} as const;

const MAIN_ENTRY = { provider: 'opencode', model: 'ollama-cloud/glm-5.2' };
const STRONG_ENTRY = { provider: 'claude', model: 'opus' };

function section(overrides: Partial<RuntimeProviderSection>): RuntimeProviderSection {
  return {
    profiles: { ...PROFILES },
    ...overrides,
  } as unknown as RuntimeProviderSection;
}

describe('ladder initial-stage honoring across every assignment path', () => {
  it('Given a ladder step assignment, When compiled, Then the step routes to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { steps: { 'development-core/fix': { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.providerRouting?.steps?.['development-core/fix']).toEqual(MAIN_ENTRY);
  });

  it('Given a ladder tag assignment, When compiled, Then the tag routes to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { tags: { heavy: { ladder: ['strong', 'main'] } } } }),
    );
    expect(env.providerRouting?.tags?.heavy).toEqual(STRONG_ENTRY);
  });

  it('Given a ladder persona assignment, When compiled, Then the persona routes to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { personas: { coder: { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.personaProviders?.coder).toEqual(MAIN_ENTRY);
  });

  it('Given a ladder defaults assignment, When compiled, Then provider/model resolve to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(section({ defaults: { ladder: ['main', 'strong'] } }));
    // Regression guard: before the fix, defaults consulted only `.profile`, so a `ladder` silently
    // fell back to the built-in defaults instead of ladder[0].
    expect(env.provider).toBe('opencode');
    expect(env.model).toBe('ollama-cloud/glm-5.2');
  });

  it('Given a ladder internal_agents.selector assignment, When compiled, Then the selector resolves to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { ladder: ['strong', 'main'] } } } }),
    );
    // Regression guard: before the fix, buildInternalAgents `continue`d when `.profile` was
    // undefined, silently skipping ladder selectors.
    expect(env.internalAgents?.selector).toEqual(STRONG_ENTRY);
  });

  it('Given a ladder internal_agents.assistant assignment, When compiled, Then the assistant resolves to the ladder first profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { assistant: { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.internalAgents?.assistant).toEqual(MAIN_ENTRY);
  });

  it('Given a ladder step assignment, When compiled, Then the default profile still resolves independently', () => {
    const env = compileRuntimeProviderEnvironment(
      section({
        defaults: { profile: 'base' },
        targets: { steps: { 'development-core/fix': { ladder: ['main', 'strong'] } } },
      }),
    );
    expect(env.provider).toBe('mock');
    expect(env.model).toBe('base-model');
  });
});

describe('every ladder stage is preserved for the promotion seam (issue #1208)', () => {
  it('Given ladders on defaults/steps/tags/personas, When compiled, Then all stages are kept in order', () => {
    const env = compileRuntimeProviderEnvironment(
      section({
        defaults: { ladder: ['main', 'strong'] },
        targets: {
          steps: { 'development-core/fix': { ladder: ['main', 'strong'] } },
          tags: { heavy: { ladder: ['strong', 'main'] } },
          personas: { coder: { ladder: ['main', 'strong'] } },
        },
      }),
    );
    expect(env.providerLadders?.defaults).toEqual([MAIN_ENTRY, STRONG_ENTRY]);
    expect(env.providerLadders?.steps?.['development-core/fix']).toEqual([MAIN_ENTRY, STRONG_ENTRY]);
    expect(env.providerLadders?.tags?.heavy).toEqual([STRONG_ENTRY, MAIN_ENTRY]);
    expect(env.providerLadders?.personas?.coder).toEqual([MAIN_ENTRY, STRONG_ENTRY]);
  });

  it('Given no ladder assignment anywhere, When compiled, Then providerLadders is undefined', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ defaults: { profile: 'base' }, targets: { steps: { 'a/b': { profile: 'main' } } } }),
    );
    expect(env.providerLadders).toBeUndefined();
  });

  it('Given a profile assignment beside a ladder, When compiled, Then only the ladder key is recorded', () => {
    const env = compileRuntimeProviderEnvironment(
      section({
        targets: {
          steps: {
            'development-core/fix': { ladder: ['main', 'strong'] },
            'development-core/plan': { profile: 'base' },
          },
        },
      }),
    );
    expect(env.providerLadders?.steps).toEqual({ 'development-core/fix': [MAIN_ENTRY, STRONG_ENTRY] });
  });

  it('Given an internal_agents ladder, When compiled, Then it is excluded from providerLadders (not a promotion target)', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { ladder: ['strong', 'main'] } } } }),
    );
    expect(env.providerLadders).toBeUndefined();
  });
});

describe('ladder honoring preserves the `pool` assignment contracts', () => {
  function autoRoutingSection(overrides: Partial<RuntimeProviderSection>): RuntimeProviderSection {
    return section({
      auto_routing: {
        router_profile: 'base',
        pools: { general: { candidates: [{ profile: 'main', tier: 'low' }], fallback_profile: 'main' } },
      },
      ...overrides,
    });
  }

  it('Given a `defaults: { pool }`, When compiled, Then provider/model stay unset and auto_routing is built', () => {
    const env = compileRuntimeProviderEnvironment(autoRoutingSection({ defaults: { pool: 'general' } }));
    expect(env.provider).toBeUndefined();
    expect(env.model).toBeUndefined();
    expect(env.autoRouting?.defaultPool).toBe('general');
  });

  it('Given an `internal_agents.selector: { pool }`, When compiled, Then it throws (pools are not allowed for internal agents)', () => {
    expect(() =>
      compileRuntimeProviderEnvironment(
        autoRoutingSection({
          defaults: { pool: 'general' },
          targets: { internal_agents: { selector: { pool: 'general' } } },
        }),
      ),
    ).toThrow(/internal_agents\.selector` cannot use a `pool`/);
  });

  it('Given an `internal_agents.selector: { profile }`, When compiled, Then the fixed profile is still honored', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { profile: 'strong' } } } }),
    );
    expect(env.internalAgents?.selector).toEqual(STRONG_ENTRY);
  });
});
