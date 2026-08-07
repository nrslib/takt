import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema } from '../core/models/index.js';

/**
 * Issue #1208 Stage 1 — promotion target-required refinement is relaxed to accept `{at: N}`.
 * Implemented in the following `implement` step; assertions expected to fail until then.
 *
 * Contracts (plan.md 完了契約):
 * - CT-PROMO-1 promotion `{at: N}` (no provider/model/provider_options) is accepted (order.md:99,138)
 * - CT-PROMO-2 targeted promotion (provider/model/provider_options) is still accepted (order.md:82; maintain)
 *
 * The `{at: 3}` → rejected assertion that previously lived in
 * `promotion-schema-normalizer.test.ts` ("rejects promotion entries without a target override")
 * encodes the OLD contract that CT-PROMO-1 reverses; it is migrated to acceptance there.
 *
 * Discrimination: relaxing the "requires a target" check must NOT also drop the "requires at
 * least one of `at`/`condition`" check — a bare `{}` promotion must still be rejected.
 */

describe('CT-PROMO-1 target-less promotion is accepted', () => {
  it('should accept a step when it declares `promotion: [{at:3},{at:6}]`', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ at: 3 }, { at: 6 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promotion).toHaveLength(2);
    }
  });

  it('should still reject a step when it declares a bare `promotion: [{}]` (no at/condition and no target)', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{}],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['promotion', 0] })]),
      );
    }
  });
});

describe('CT-PROMO-2 targeted promotion remains accepted', () => {
  it('should still accept a step when it declares a targeted `{at:3, model, provider_options}` promotion', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [
        { at: 3, model: 'gpt-5.5', provider_options: { codex: { reasoning_effort: 'high' } } },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promotion).toHaveLength(1);
    }
  });

  it('should still accept a step when it declares a targeted `{condition, provider}` promotion', () => {
    // A condition-driven promotion that names a concrete target is untouched by the target-less
    // restriction — its target says "what to promote to", so it has a runtime effect.
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ condition: 'ai("environment needs escalation")', provider: 'codex' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promotion).toHaveLength(1);
    }
  });
});

describe('FAM-2 target-less promotion must be `{at:N}` only (order.md:99/159)', () => {
  it('should reject a step when it declares a target-less condition-only `promotion: [{condition}]`', () => {
    // A target-less condition entry has no runtime effect: the ladder stage count ignores
    // condition entries, so accepting it would silently drop the promotion. Reject it at load time.
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ condition: 'ai("environment needs escalation")' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['promotion', 0] })]),
      );
    }
  });

  it('should reject a step when it declares a target-less `{at, condition}` entry', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'fix',
      instruction: '{task}',
      promotion: [{ at: 3, condition: 'ai("environment needs escalation")' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['promotion', 0] })]),
      );
    }
  });
});
