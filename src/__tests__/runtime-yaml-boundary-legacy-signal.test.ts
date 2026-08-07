import { describe, expect, it } from 'vitest';
import {
  collectLegacyProviderSignals,
  collectStepPromotionEntries,
} from '../infra/config/runtime-provider/legacy-signals.js';
import { determineProviderConfigMode } from '../infra/config/runtime-provider/mode.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

/**
 * Issue #1208 Stage 1 — a workflow that still carries a *targeted* promotion is a legacy signal, so
 * it participates in the runtime-v1 mixed-config hard error.
 * Implemented in the following `implement` step; assertions expected to fail until then.
 *
 * Contract (plan.md 完了契約):
 * - CT-MIX-2 runtime-v1 active + a workflow with a targeted promotion (provider/model/provider_options)
 *   is detected as a legacy signal and hard-errors (order.md:100,160).
 *
 * ASSUMPTION (plan req#28 seam is implement-decided): the detection input is the existing
 * `collectLegacyProviderSignals` workflow argument, extended with `promotion`, mirroring how
 * `workflow.provider` / `workflow.model` already flow in. The assertions match on
 * /promotion/ rather than an exact setting/location string so an equivalent field name still passes.
 *
 * Discrimination: a *target-less* `{at:N}` promotion must NOT be a legacy signal (order.md:100) —
 * that is the whole point of Stage 1's ladder. A misimplementation that flags every promotion fails
 * the negative case.
 */

const CLEAN_LEGACY: LegacyProviderEnvironmentInput = {
  provider: undefined,
  providerSource: 'default',
  model: undefined,
  modelSource: 'default',
  personaProviders: undefined,
  providerRouting: undefined,
  autoRouting: undefined,
  providerOptions: undefined,
} as LegacyProviderEnvironmentInput;

type WorkflowArg = Parameters<typeof collectLegacyProviderSignals>[1];

function workflowWithPromotion(promotion: ReadonlyArray<Record<string, unknown>>): WorkflowArg {
  return { name: 'wf', promotion } as unknown as WorkflowArg;
}

const ACTIVE_RUNTIME_FILE: RuntimeProviderFile = {
  version: 1,
  provider: { defaults: { profile: 'd' }, profiles: { d: { provider: 'mock', model: 'm' } } },
} as unknown as RuntimeProviderFile;

describe('CT-MIX-2 targeted promotion is a legacy signal', () => {
  it('Given a workflow with a targeted promotion and otherwise-clean legacy config, When collecting signals, Then a promotion signal is reported', () => {
    const signals = collectLegacyProviderSignals(
      CLEAN_LEGACY,
      workflowWithPromotion([{ at: 3, model: 'opus' }]),
      'default',
    );
    expect(signals.some((s) => /promotion/i.test(s.setting) || /promotion/i.test(s.location))).toBe(true);
  });

  it('Given a workflow with only a target-less `{at:N}` promotion, When collecting signals, Then it is NOT reported as legacy', () => {
    const signals = collectLegacyProviderSignals(
      CLEAN_LEGACY,
      workflowWithPromotion([{ at: 3 }]),
      'default',
    );
    expect(signals.some((s) => /promotion/i.test(s.setting) || /promotion/i.test(s.location))).toBe(false);
  });

  it('Given an active runtime.yaml and the targeted-promotion signal, When determining the mode, Then it hard-errors', () => {
    const signals = collectLegacyProviderSignals(
      CLEAN_LEGACY,
      workflowWithPromotion([{ at: 3, model: 'opus' }]),
      'default',
    );
    expect(() =>
      determineProviderConfigMode({ runtimeFile: ACTIVE_RUNTIME_FILE, legacyProviderSignals: signals }),
    ).toThrow(/Mixed provider configuration/i);
  });
});

/**
 * CT-MIX-2 primary execution seam — the tests above inject an already-flattened `promotion` array
 * directly into `collectLegacyProviderSignals`, which pins that function's discrimination but skips
 * the `steps[].promotion → flattened view` step that production actually runs
 * (`provider-environment.ts:130`, `workflowExecutionBootstrap.ts:537`:
 * `promotion: collectStepPromotionEntries(workflow.steps)`). These tests drive the real chain
 * `collectStepPromotionEntries → collectLegacyProviderSignals → determineProviderConfigMode`, so a
 * silent regression in the steps-flattening safety seam is observable.
 *
 * The targeted step is deliberately NOT first, and is preceded by both a promotion-less step and a
 * target-less-promotion step, so a partial-traversal / early-terminating flattener fails.
 */
describe('CT-MIX-2 steps-flattening seam feeds the mixed-config signal', () => {
  it('Given steps where a targeted promotion sits behind promotion-less and target-less steps, When flattening via collectStepPromotionEntries and collecting signals, Then a promotion signal is reported', () => {
    const steps = [
      { name: 'plan' },
      { name: 'review', promotion: [{ at: 2 }] },
      { name: 'fix', promotion: [{ at: 3, model: 'opus' }] },
    ];
    const promotion = collectStepPromotionEntries(steps);
    const signals = collectLegacyProviderSignals(CLEAN_LEGACY, { name: 'wf', promotion }, 'default');
    expect(signals.some((s) => /promotion/i.test(s.setting) || /promotion/i.test(s.location))).toBe(true);
  });

  it('Given steps whose only promotions are target-less `{at:N}`, When flattening and collecting signals, Then no promotion signal is reported', () => {
    const steps = [
      { name: 'plan' },
      { name: 'fix', promotion: [{ at: 3 }] },
    ];
    const promotion = collectStepPromotionEntries(steps);
    const signals = collectLegacyProviderSignals(CLEAN_LEGACY, { name: 'wf', promotion }, 'default');
    expect(signals.some((s) => /promotion/i.test(s.setting) || /promotion/i.test(s.location))).toBe(false);
  });

  it('Given mixed steps, When flattening, Then promotion-less steps are skipped and every promotion-bearing step contributes its entries', () => {
    const steps = [
      { name: 'a', promotion: [{ at: 2 }] },
      { name: 'b' },
      { name: 'c', promotion: [{ at: 3, model: 'opus' }] },
    ];
    const promotion = collectStepPromotionEntries(steps);
    // Both promotion-bearing steps flatten (2 entries); the promotion-less step 'b' is skipped.
    expect(promotion).toHaveLength(2);
    const signals = collectLegacyProviderSignals(CLEAN_LEGACY, { name: 'wf', promotion }, 'default');
    // Exactly one promotion signal: the single targeted entry, not the target-less one.
    expect(signals.filter((s) => /promotion/i.test(s.setting)).length).toBe(1);
  });

  it('Given an active runtime.yaml and steps carrying a targeted promotion, When flattening and determining the mode, Then it hard-errors', () => {
    const steps = [
      { name: 'plan' },
      { name: 'fix', promotion: [{ at: 3, provider: 'codex' }] },
    ];
    const promotion = collectStepPromotionEntries(steps);
    const signals = collectLegacyProviderSignals(CLEAN_LEGACY, { name: 'wf', promotion }, 'default');
    expect(() =>
      determineProviderConfigMode({ runtimeFile: ACTIVE_RUNTIME_FILE, legacyProviderSignals: signals }),
    ).toThrow(/Mixed provider configuration/i);
  });
});
