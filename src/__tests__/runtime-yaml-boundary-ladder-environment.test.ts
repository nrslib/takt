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
    defaults: { profile: 'base' },
    profiles: { ...PROFILES },
    ...overrides,
  } as unknown as RuntimeProviderSection;
}

describe('ladder initial-stage honoring across every assignment path', () => {
  it('should route the step to the ladder first profile when a step assignment declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { steps: { 'development-core/fix': { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.providerRouting?.steps?.['development-core/fix']).toEqual(MAIN_ENTRY);
  });

  it('should route the tag to the ladder first profile when a tag assignment declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { tags: { heavy: { ladder: ['strong', 'main'] } } } }),
    );
    expect(env.providerRouting?.tags?.heavy).toEqual(STRONG_ENTRY);
  });

  it('should route the persona to the ladder first profile when a persona assignment declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { personas: { coder: { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.personaProviders?.coder).toEqual(MAIN_ENTRY);
  });

  it('should resolve provider/model to the ladder first profile when `defaults` declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(section({ defaults: { ladder: ['main', 'strong'] } }));
    // Regression guard: before the fix, defaults consulted only `.profile`, so a `ladder` silently
    // fell back to the built-in defaults instead of ladder[0].
    expect(env.provider).toBe('opencode');
    expect(env.model).toBe('ollama-cloud/glm-5.2');
  });

  it('should resolve the selector to the ladder first profile when `internal_agents.selector` declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { ladder: ['strong', 'main'] } } } }),
    );
    // Regression guard: before the fix, buildInternalAgents `continue`d when `.profile` was
    // undefined, silently skipping ladder selectors.
    expect(env.internalAgents?.selector).toEqual(STRONG_ENTRY);
  });

  it('should resolve the assistant to the ladder first profile when `internal_agents.assistant` declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { assistant: { ladder: ['main', 'strong'] } } } }),
    );
    expect(env.internalAgents?.assistant).toEqual(MAIN_ENTRY);
  });

  it('should still resolve the default profile independently when a step assignment declares a ladder', () => {
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
  it('should keep every stage in order when defaults/steps/tags/personas all declare ladders', () => {
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

  it('should leave providerLadders undefined when no assignment declares a ladder', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ defaults: { profile: 'base' }, targets: { steps: { 'a/b': { profile: 'main' } } } }),
    );
    expect(env.providerLadders).toBeUndefined();
  });

  it('should record only the ladder key when a profile assignment sits beside a ladder', () => {
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

  it('should exclude an internal_agents ladder from providerLadders when compiled (not a promotion target)', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { ladder: ['strong', 'main'] } } } }),
    );
    expect(env.providerLadders).toBeUndefined();
  });
});

describe('ladder honoring preserves the explicit pool assignment contracts', () => {
  function autoRoutingSection(overrides: Partial<RuntimeProviderSection>): RuntimeProviderSection {
    return section({
      auto_routing: {
        router_profile: 'base',
        pools: { general: { candidates: [{ profile: 'main', tier: 'low' }], fallback_profile: 'main' } },
      },
      ...overrides,
    });
  }

  it('should keep concrete defaults and build auto_routing without an implicit default pool', () => {
    const env = compileRuntimeProviderEnvironment(autoRoutingSection({}));
    expect(env.provider).toBe('mock');
    expect(env.model).toBe('base-model');
    expect(env.autoRouting).not.toHaveProperty('defaultPool');
  });

  it('should throw when `internal_agents.selector` declares a pool (pools are not allowed for internal agents)', () => {
    expect(() =>
      compileRuntimeProviderEnvironment(
        autoRoutingSection({
          targets: { internal_agents: { selector: { pool: 'general' } } },
        }),
      ),
    ).toThrow(/internal_agents\.selector` cannot use a `pool`/);
  });

  it('should honor the fixed profile when `internal_agents.selector` declares a profile', () => {
    const env = compileRuntimeProviderEnvironment(
      section({ targets: { internal_agents: { selector: { profile: 'strong' } } } }),
    );
    expect(env.internalAgents?.selector).toEqual(STRONG_ENTRY);
  });
});
