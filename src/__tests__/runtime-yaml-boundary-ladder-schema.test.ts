import { describe, expect, it } from 'vitest';
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';

/**
 * Issue #1208 Stage 1 — runtime.yaml `ladder` assignment (the third assignment form).
 * Implemented in the following `implement` step; assertions expected to fail until then.
 *
 * Contracts (plan.md 完了契約):
 * - CT-LAD-1 assignment gains `ladder: [profileA, profileB]`; profile | pool | ladder are mutually
 *   exclusive — exactly one may be present (order.md:86-94).
 *
 * These are schema-shape assertions only (reference resolution of the profile names is validated
 * at policy time; see runtime-yaml-boundary-ladder-policy.test.ts / CT-LAD-5). The XOR-with-three
 * cases discriminate a naive addition that only appends `ladder` without extending the
 * "exactly one of" refinement.
 */

type LooseAssignment = { profile?: unknown; pool?: unknown; ladder?: unknown };
type LooseRuntimeDoc = {
  version?: unknown;
  provider: {
    profiles: Record<string, { provider?: unknown; model?: unknown }>;
    targets: { steps: Record<string, LooseAssignment> };
  };
};

// order.md:86-94 verbatim shape.
function ladderDoc(): LooseRuntimeDoc {
  return {
    version: 1,
    provider: {
      defaults: { profile: 'main' },
      profiles: {
        main: { provider: 'opencode', model: 'ollama-cloud/glm-5.2' },
        strong: { provider: 'claude', model: 'opus' },
      },
      targets: {
        steps: { 'development-core/fix': { ladder: ['main', 'strong'] } },
      },
    },
  };
}

describe('CT-LAD-1 runtime.yaml ladder assignment', () => {
  it('should accept and retain the stage order when a step assignment declares `ladder: [main, strong]`', () => {
    const result = RuntimeProviderFileSchema.safeParse(ladderDoc());
    expect(result.success).toBe(true);
    if (result.success) {
      const steps = (result.data.provider?.targets?.steps ?? {}) as Record<string, LooseAssignment>;
      expect(steps['development-core/fix']?.ladder).toEqual(['main', 'strong']);
    }
  });

  it('should reject an assignment when it declares both `profile` and `ladder`', () => {
    const doc = ladderDoc();
    doc.provider.targets.steps['development-core/fix'] = { profile: 'main', ladder: ['main', 'strong'] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('should reject an assignment when it declares both `pool` and `ladder`', () => {
    const doc = ladderDoc();
    doc.provider.targets.steps['development-core/fix'] = { pool: 'sol-pool', ladder: ['main', 'strong'] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('should reject an assignment when `ladder` is empty', () => {
    const doc = ladderDoc();
    doc.provider.targets.steps['development-core/fix'] = { ladder: [] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('should reject an assignment when a `ladder` entry is not a string', () => {
    const doc = ladderDoc();
    doc.provider.targets.steps['development-core/fix'] = { ladder: ['main', 42] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });

  it('should reject an assignment when a `ladder` entry is an empty string', () => {
    // An empty stage name would resolve against the profile map as a missing reference at load
    // time; the schema rejects it earlier so the error names the shape, not a phantom profile.
    const doc = ladderDoc();
    doc.provider.targets.steps['development-core/fix'] = { ladder: ['main', ''] };
    expect(RuntimeProviderFileSchema.safeParse(doc).success).toBe(false);
  });
});
