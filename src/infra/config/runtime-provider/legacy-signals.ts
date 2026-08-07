/**
 * Shared legacy-provider signal collection (issue #1136).
 *
 * A "legacy provider signal" is a provider setting explicitly written to project/global
 * `config.yaml` (or a workflow) that must not coexist with an active runtime.yaml provider
 * section. `determineProviderConfigMode` turns a non-empty signal list into a mixed-config
 * fail-fast. This module owns the single signal-generation mapping so every entry point — the
 * workflow-execution bootstrap, the auxiliary preview/doctor entry, and the selector/assistant
 * seams — consumes the same mode decision instead of re-deriving it.
 */

import type { TaktProvidersConfig } from '../../../core/models/config-types.js';
import type { ProviderOptionsSource } from '../../../core/workflow/provider-options-trace.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import { resolveConfigValueWithSource, resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import type { LegacyProviderEnvironmentInput } from './environment.js';
import type { LegacyProviderSignal } from './mode.js';

function isNonEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

/**
 * A promotion entry carries a concrete provider target when any of provider/model/providerOptions
 * is set. A target-less `{at:N}` promotion (issue #1208) is NOT a legacy signal — its target lives
 * in the runtime.yaml ladder, so it is exactly what Stage 1 introduces. Detection runs on the
 * normalized `WorkflowConfig` steps (both production callers pass normalized config), so only the
 * camelCase `providerOptions` shape exists here.
 */
interface LegacyPromotionEntryView {
  provider?: unknown;
  model?: unknown;
  providerOptions?: unknown;
}

function hasTargetedPromotion(
  promotion: ReadonlyArray<LegacyPromotionEntryView> | undefined,
): boolean {
  return promotion?.some((entry) =>
    entry.provider !== undefined
    || entry.model !== undefined
    || entry.providerOptions !== undefined,
  ) ?? false;
}

/** Flatten every step's `promotion` list into a single view for mixed-config signal detection. */
export function collectStepPromotionEntries(
  steps: readonly unknown[] | undefined,
): LegacyPromotionEntryView[] {
  const entries: LegacyPromotionEntryView[] = [];
  for (const step of steps ?? []) {
    const promotion = (step as { promotion?: ReadonlyArray<LegacyPromotionEntryView> }).promotion;
    if (promotion) {
      entries.push(...promotion);
    }
  }
  return entries;
}

/**
 * Reduce project/global `takt_providers` into the subset that counts as a mixed-config signal:
 * a `selector` or `assistant` entry whose `provider` is set in `config.yaml`. Project wins over
 * global so the returned view reflects the effective config the same way the rest of the loader
 * layers do.
 */
export function selectConfigTaktProviders(
  project: TaktProvidersConfig | undefined,
  global: TaktProvidersConfig | undefined,
): TaktProvidersConfig | undefined {
  const selectorProvider = project?.selector?.provider ?? global?.selector?.provider;
  const assistantProvider = project?.assistant?.provider ?? global?.assistant?.provider;
  if (selectorProvider === undefined && assistantProvider === undefined) {
    return undefined;
  }
  return {
    ...(selectorProvider !== undefined ? { selector: { provider: selectorProvider } } : {}),
    ...(assistantProvider !== undefined ? { assistant: { provider: assistantProvider } } : {}),
  };
}

/**
 * Detect legacy provider settings that must not coexist with an active runtime.yaml provider
 * section. CLI/env overrides and built-in defaults are runtime overrides / defaults (allowed in
 * both modes), so they are not reported as legacy configuration — only settings explicitly
 * written to project/global `config.yaml` (or the workflow) count.
 */
export function collectLegacyProviderSignals(
  legacy: LegacyProviderEnvironmentInput,
  workflow: {
    name: string;
    provider?: unknown;
    model?: unknown;
    autoRouting?: unknown;
    promotion?: ReadonlyArray<LegacyPromotionEntryView>;
  },
  providerOptionsSource: ProviderOptionsSource | undefined,
): LegacyProviderSignal[] {
  const signals: LegacyProviderSignal[] = [];

  if (legacy.providerSource === 'project' || legacy.providerSource === 'global') {
    signals.push({
      setting: 'provider',
      location: `config.yaml:provider (${legacy.providerSource})`,
      migrateTo: 'provider.defaults + provider.profiles',
    });
  }
  if (legacy.modelSource === 'project' || legacy.modelSource === 'global') {
    signals.push({
      setting: 'model',
      location: `config.yaml:model (${legacy.modelSource})`,
      migrateTo: 'provider.defaults + provider.profiles',
    });
  }
  if (legacy.providerSource === 'workflow' || workflow.provider !== undefined) {
    signals.push({
      setting: 'provider',
      location: `workflow "${workflow.name}":provider`,
      migrateTo: 'provider.targets.steps',
    });
  }
  if (legacy.modelSource === 'workflow' || workflow.model !== undefined) {
    signals.push({
      setting: 'model',
      location: `workflow "${workflow.name}":model`,
      migrateTo: 'provider.targets.steps',
    });
  }
  // A workflow step that still names a concrete promotion target (provider/model/provider_options)
  // is legacy under runtime-v1: the target belongs in the runtime.yaml ladder (issue #1208). A
  // target-less `{at:N}` promotion is intentionally NOT reported — it is the Stage 1 primitive.
  if (hasTargetedPromotion(workflow.promotion)) {
    signals.push({
      setting: 'promotion',
      location: `workflow "${workflow.name}":promotion`,
      migrateTo: 'provider.targets.steps ladder',
    });
  }
  // Only takt_providers with an explicit provider (config.yaml only; never CLI/env/default) count.
  if (
    legacy.taktProviders?.selector?.provider !== undefined
    || legacy.taktProviders?.assistant?.provider !== undefined
  ) {
    signals.push({
      setting: 'takt_providers',
      location: 'config.yaml:takt_providers',
      migrateTo: 'provider.targets.internal_agents',
    });
  }
  // Only provider_options explicitly written to project/global config.yaml are a legacy signal.
  // The resolver always merges built-in skill defaults into the value (source 'default'), and
  // env overrides (source 'env') are runtime overrides — neither must trip the mixed-config gate.
  if (
    (providerOptionsSource === 'project' || providerOptionsSource === 'global')
    && isNonEmptyRecord(legacy.providerOptions as Record<string, unknown> | undefined)
  ) {
    signals.push({
      setting: 'provider_options',
      location: 'config.yaml:provider_options',
      migrateTo: 'provider.profiles.*.options',
    });
  }
  if (isNonEmptyRecord(legacy.personaProviders)) {
    signals.push({
      setting: 'persona_providers',
      location: 'config.yaml:persona_providers',
      migrateTo: 'provider.targets.personas',
    });
  }
  if (isNonEmptyRecord(legacy.providerRouting as Record<string, unknown> | undefined)) {
    signals.push({
      setting: 'provider_routing',
      location: 'config.yaml:provider_routing',
      migrateTo: 'provider.targets',
    });
  }
  // auto_routing is inherited as `workflowConfig.autoRouting ?? globalConfig.autoRouting`, so the
  // effective value can originate from the workflow. Report the location that actually holds it —
  // consistent with the provider/model workflow-vs-config.yaml split above — so the mixed-config
  // error points at a real migration target rather than a config.yaml entry that does not exist.
  if (legacy.autoRouting !== undefined) {
    signals.push({
      setting: 'auto_routing',
      location: workflow.autoRouting !== undefined
        ? `workflow "${workflow.name}":auto_routing`
        : 'config.yaml:auto_routing',
      migrateTo: 'provider.auto_routing',
    });
  }

  return signals;
}

/**
 * Collect the legacy provider signals for entry points that carry no workflow context (the
 * selector and assistant seams). Reads project/global `config.yaml` directly through the same
 * resolvers the bootstrap uses, so the seams fail fast on a mixed configuration with the same
 * `location`/`migrateTo` details as the workflow-execution path.
 */
export function collectProjectLegacyProviderSignals(projectCwd: string): LegacyProviderSignal[] {
  const provider = resolveConfigValueWithSource(projectCwd, 'provider');
  const model = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  const resolved = resolveWorkflowConfigValues(projectCwd, [
    'personaProviders',
    'providerRouting',
    'autoRouting',
  ]);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: provider.value,
    providerSource: provider.source,
    model: model.value,
    modelSource: model.source,
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolved.autoRouting,
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  return collectLegacyProviderSignals(legacy, { name: 'internal-agent' }, providerOptions.source);
}
