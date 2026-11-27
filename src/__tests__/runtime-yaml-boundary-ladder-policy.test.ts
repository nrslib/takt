import { describe, expect, it } from 'vitest';
import { validateRuntimeProviderSection } from '../infra/config/runtime-provider/policy.js';
import type { RuntimeProviderSection } from '../infra/config/runtime-provider/schema.js';

/**
 * Issue #1208 Stage 1 — ladder profile references are validated at load time.
 *
 * Contract (plan.md 完了契約):
 * - Every profile named in a `ladder` must resolve to a defined profile with a provider;
 *   model omission follows the runtime profile policy.
 *
 * The section objects carry the not-yet-typed `ladder` key, so they are built loosely and cast to
 * the parameter type. This mirrors the existing assertProfile checks (runtime-provider-policy.test.ts)
 * — the discriminating cases are: unknown profile → throw, incomplete profile → throw, all-resolved
 * ladder → no throw.
 */

function sectionWithLadder(ladder: readonly string[], profiles: Record<string, { provider?: string; model?: string }>): RuntimeProviderSection {
  return {
    defaults: { profile: 'real' },
    profiles: { real: { provider: 'mock', model: 'm' }, ...profiles },
    targets: { steps: { 'development-core/fix': { ladder } } },
  } as unknown as RuntimeProviderSection;
}

describe('CT-LAD-5 ladder profile references validated at load time', () => {
  it('should accept a ladder when every stage references a fully-defined profile', () => {
    const section = sectionWithLadder(['real', 'strong'], { strong: { provider: 'claude', model: 'opus' } });
    expect(() => validateRuntimeProviderSection(section)).not.toThrow();
  });

  it('should fail fast naming the missing profile when a ladder references an unknown profile', () => {
    const section = sectionWithLadder(['real', 'ghost'], {});
    expect(() => validateRuntimeProviderSection(section)).toThrow(/ghost|unknown profile/i);
  });

  it('should accept a ladder profile that delegates its model to the provider', () => {
    const section = sectionWithLadder(['real', 'half'], { half: { provider: 'claude' } });
    expect(() => validateRuntimeProviderSection(section)).not.toThrow();
  });

  it('should fail fast when a ladder profile is missing its provider', () => {
    const section = sectionWithLadder(['real', 'half'], { half: { model: 'fixed' } });
    expect(() => validateRuntimeProviderSection(section)).toThrow(/provider/i);
  });
});

describe('a ladder must escalate to a different profile at every stage', () => {
  it('should fail fast when a ladder repeats its own profile in the next stage', () => {
    // `['real', 'real']` is a self-reference: the promotion "escalates" to what it already runs.
    const section = sectionWithLadder(['real', 'real'], {});
    expect(() => validateRuntimeProviderSection(section)).toThrow(/real/i);
  });

  it('should fail fast when a ladder cycles back to an earlier profile', () => {
    const section = sectionWithLadder(['real', 'strong', 'real'], {
      strong: { provider: 'claude', model: 'opus' },
    });
    expect(() => validateRuntimeProviderSection(section)).toThrow(/real/i);
  });
});
