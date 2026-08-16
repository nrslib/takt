/**
 * Shared legacy-provider signal collection (issue #1136).
 *
 * A "legacy provider signal" is a provider setting explicitly written to project/global
 * `config.yaml` settings that must not coexist with an active runtime.yaml provider
 * section. `determineProviderConfigMode` turns a non-empty signal list into a mixed-config
 * fail-fast. This module owns the single signal-generation mapping so every entry point — the
 * workflow-execution bootstrap, the auxiliary preview/doctor entry, and the selector/assistant
 * seams — consumes the same mode decision instead of re-deriving it.
 */

import type { TaktProvidersConfig } from '../../../core/models/config-types.js';
import type { ProviderOptionsSource } from '../../../core/workflow/provider-options-trace.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import {
  resolveConfigValueWithSource,
  resolveProviderOptionsWithTrace,
  toProviderResolutionSource,
} from '../resolveConfigValue.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import type { LegacyProviderEnvironmentInput } from './environment.js';
import type { LegacyProviderSignal } from './mode.js';

function isNonEmptyRecord(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
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
 * written to project/global `config.yaml` count.
 */
export function collectLegacyProviderSignals(
  legacy: LegacyProviderEnvironmentInput,
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
  if (legacy.autoRouting !== undefined) {
    signals.push({
      setting: 'auto_routing',
      location: 'config.yaml:auto_routing',
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
    providerSource: toProviderResolutionSource(provider.source),
    model: model.value,
    modelSource: toProviderResolutionSource(model.source),
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolved.autoRouting,
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  return collectLegacyProviderSignals(legacy, providerOptions.source);
}
