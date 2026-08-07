import { describe, expect, it } from 'vitest';
import { validateRuntimeProviderSection } from '../infra/config/runtime-provider/policy.js';
import type { RuntimeProviderSection } from '../infra/config/runtime-provider/schema.js';

/**
 * Issue #1208 Stage 1 — ladder profile references are validated at load time.
 * Implemented in the following `implement` step; assertions expected to fail until then.
 *
 * Contract (plan.md 完了契約):
 * - CT-LAD-5 every profile named in a `ladder` must resolve to a defined profile that carries both
 *   `provider` and `model`; an unresolved name fails fast at load time (order.md:157).
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
  it('Given a ladder that references a fully-defined profile, When validated, Then it does not throw', () => {
    const section = sectionWithLadder(['real', 'strong'], { strong: { provider: 'claude', model: 'opus' } });
    expect(() => validateRuntimeProviderSection(section)).not.toThrow();
  });

  it('Given a ladder that references an unknown profile, When validated, Then it fails fast naming the missing profile', () => {
    const section = sectionWithLadder(['real', 'ghost'], {});
    expect(() => validateRuntimeProviderSection(section)).toThrow(/ghost|unknown profile/i);
  });

  it('Given a ladder profile missing `model`, When validated, Then it fails fast', () => {
    const section = sectionWithLadder(['real', 'half'], { half: { provider: 'claude' } });
    expect(() => validateRuntimeProviderSection(section)).toThrow(/half|provider|model/i);
  });
});
