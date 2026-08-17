import type { AssistantProviderConfig } from '../../core/config/provider-resolution.js';
import type { ProviderRoutingEntry } from '../../core/models/config-types.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { PermissionMode } from '../../core/models/types.js';
import { mergeProviderOptions } from './providerOptions.js';
import { validateProviderModelRequirements } from '../../core/workflow/provider-model-requirements.js';
import { ConfiguredModelSchema } from '../../core/models/model-schema.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { resolveConfigValueWithSource } from './resolveConfigValue.js';
import { resolveRuntimeInternalAgentProvider } from './runtime-provider/internal-agents.js';
import { composeRuntimeProviderOverride } from './runtime-provider/override.js';
import type { CompiledProviderEnvironment } from './runtime-provider/environment.js';

export interface SelectorProviderOverrides {
  provider?: ProviderType;
  model?: string;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
}

export interface ResolvedSelectorProvider {
  provider?: ProviderType;
  model?: string;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  providerOptions?: StepProviderOptions;
  permissionMode?: PermissionMode;
}

interface SelectorCandidate {
  provider?: ProviderType;
  model?: string;
  source: ProviderResolutionSource;
}

function normalizeSelectorModel(model: string | undefined): string | undefined {
  return model === undefined ? undefined : ConfiguredModelSchema.parse(model);
}

export function resolveSelectorProviderFromConfig(
  config: AssistantProviderConfig,
  overrides?: SelectorProviderOverrides,
): ResolvedSelectorProvider {
  const localSelector = config.local.taktProviders?.selector;
  const globalSelector = config.global.taktProviders?.selector;
  const candidates: SelectorCandidate[] = [
    { provider: overrides?.provider, source: overrides?.providerSource ?? 'cli' },
    { model: normalizeSelectorModel(overrides?.model), source: overrides?.modelSource ?? 'cli' },
    { provider: localSelector?.provider, model: normalizeSelectorModel(localSelector?.model), source: 'project' },
    { provider: globalSelector?.provider, model: normalizeSelectorModel(globalSelector?.model), source: 'global' },
    { provider: config.local.provider, model: normalizeSelectorModel(config.local.model), source: 'project' },
    { provider: config.global.provider, model: normalizeSelectorModel(config.global.model), source: 'global' },
  ];
  const providerCandidate = candidates.find((candidate) => candidate.provider !== undefined);
  const provider = providerCandidate?.provider;
  const modelCandidate = candidates.find((candidate) =>
    candidate.model !== undefined
    && (candidate.provider === undefined || candidate.provider === provider),
  );
  validateProviderModelRequirements(provider, modelCandidate?.model, {
    modelFieldName: 'Configuration error: takt_providers.selector resolved model',
  });
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(providerCandidate === undefined ? {} : { providerSource: providerCandidate.source }),
    ...(modelCandidate?.model === undefined ? {} : { model: modelCandidate.model }),
    ...(modelCandidate === undefined ? {} : { modelSource: modelCandidate.source }),
    ...(provider === undefined ? {} : { providerOptions: resolveSelectorProviderOptions(config, provider) }),
  };
}

export function resolveSelectorProviderForProject(
  projectCwd: string,
  overrides?: SelectorProviderOverrides,
): ResolvedSelectorProvider {
  const runtimeSelector = resolveRuntimeInternalAgentProvider(projectCwd, 'selector');
  if (runtimeSelector !== undefined) {
    return resolveSelectorFromRuntimeV1(runtimeSelector, projectCwd, overrides);
  }
  return resolveSelectorProviderFromLegacyProject(projectCwd, overrides);
}

export function resolveSelectorProviderFromRuntimeEnvironment(
  environment: CompiledProviderEnvironment,
  overrides?: SelectorProviderOverrides,
): ResolvedSelectorProvider {
  const runtimeSelector = environment.internalAgents?.selector ?? (
    environment.provider === undefined
      ? undefined
      : {
          provider: environment.provider,
          model: environment.model,
          providerOptions: environment.providerOptions,
          permissionMode: environment.permissionMode,
        }
  );
  if (runtimeSelector === undefined) {
    return {};
  }

  const providerFromEnvironment = environment.providerSource === 'cli'
    || environment.providerSource === 'env'
    ? environment.provider
    : undefined;
  const modelFromEnvironment = environment.modelSource === 'cli'
    || environment.modelSource === 'env'
    ? environment.model
    : undefined;
  const providerOverride = overrides?.provider ?? providerFromEnvironment;
  const modelOverride = overrides?.model ?? modelFromEnvironment;
  return resolveSelectorFromRuntimeValues(
    runtimeSelector,
    {
      provider: providerOverride,
      model: modelOverride,
      providerSource: overrides?.providerSource
        ?? (overrides?.provider !== undefined
          ? 'cli'
          : providerFromEnvironment === undefined ? undefined : environment.providerSource),
      modelSource: overrides?.modelSource
        ?? (overrides?.model !== undefined
          ? 'cli'
          : modelFromEnvironment === undefined ? undefined : environment.modelSource),
    },
  );
}

export function resolveSelectorProviderFromLegacyProject(
  projectCwd: string,
  overrides?: SelectorProviderOverrides,
): ResolvedSelectorProvider {
  const project = loadProjectConfig(projectCwd);
  const global = loadGlobalConfig();
  const configuredProvider = resolveConfigValueWithSource(projectCwd, 'provider');
  const configuredModel = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOverride = overrides?.provider ?? (
    configuredProvider.source === 'env' ? configuredProvider.value : undefined
  );
  const modelOverride = overrides?.model ?? (
    configuredModel.source === 'env' ? configuredModel.value : undefined
  );
  return resolveSelectorProviderFromConfig({
    local: {
      provider: project.provider,
      model: project.model,
      taktProviders: project.taktProviders,
    },
    global: {
      provider: global.provider,
      model: global.model,
      taktProviders: global.taktProviders,
    },
  }, {
    provider: providerOverride,
    model: modelOverride,
    providerSource: overrides?.providerSource
      ?? (configuredProvider.source === 'env' ? 'env' : undefined),
    modelSource: overrides?.modelSource
      ?? (configuredModel.source === 'env' ? 'env' : undefined),
  });
}

/**
 * Resolve the selector provider from an active runtime.yaml section. CLI/env overrides still win
 * (order.md treats explicit provider selection as a runtime override in both modes); when the
 * provider is overridden the runtime-tied model/options no longer apply.
 */
function resolveSelectorFromRuntimeV1(
  runtime: ProviderRoutingEntry,
  projectCwd: string,
  overrides?: SelectorProviderOverrides,
): ResolvedSelectorProvider {
  const configuredProvider = resolveConfigValueWithSource(projectCwd, 'provider');
  const configuredModel = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOverride = overrides?.provider
    ?? (configuredProvider.source === 'env' ? configuredProvider.value : undefined);
  const providerOverrideSource = overrides?.providerSource
    ?? (configuredProvider.source === 'env' ? 'env' : 'cli');
  const modelOverride = overrides?.model
    ?? (configuredModel.source === 'env' ? configuredModel.value : undefined);
  const modelOverrideSource = overrides?.modelSource
    ?? (configuredModel.source === 'env' ? 'env' : 'cli');

  return resolveSelectorFromRuntimeValues(
    runtime,
    {
      provider: providerOverride,
      model: modelOverride,
      providerSource: providerOverride === undefined ? undefined : providerOverrideSource,
      modelSource: modelOverride === undefined ? undefined : modelOverrideSource,
    },
  );
}

function resolveSelectorFromRuntimeValues(
  runtime: ProviderRoutingEntry,
  overrides: {
    provider?: ProviderType;
    model?: string;
    providerSource?: ProviderResolutionSource;
    modelSource?: ProviderResolutionSource;
  },
): ResolvedSelectorProvider {
  const providerOverride = overrides.provider;
  const modelOverride = overrides.model;
  const composed = composeRuntimeProviderOverride(
    {
      provider: runtime.provider,
      model: normalizeSelectorModel(runtime.model),
      providerOptions: runtime.providerOptions,
      permissionMode: runtime.permissionMode,
    },
    { provider: providerOverride, model: normalizeSelectorModel(modelOverride) },
  );
  const provider = composed.provider;
  const providerSource: ProviderResolutionSource | undefined = providerOverride !== undefined
    ? overrides.providerSource
    : (runtime.provider !== undefined ? 'runtime-v1' : undefined);

  const model = composed.model;
  let modelSource: ProviderResolutionSource | undefined;
  if (modelOverride !== undefined) {
    modelSource = overrides.modelSource;
  } else if (providerOverride === undefined && runtime.model !== undefined) {
    modelSource = 'runtime-v1';
  }

  validateProviderModelRequirements(provider, model, {
    modelFieldName: 'Configuration error: runtime.yaml internal_agents.selector resolved model',
  });
  const providerOptions = composed.providerOptions;
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(providerSource === undefined ? {} : { providerSource }),
    ...(model === undefined ? {} : { model }),
    ...(modelSource === undefined ? {} : { modelSource }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(composed.permissionMode !== undefined
      ? { permissionMode: composed.permissionMode }
      : {}),
  };
}

function resolveSelectorProviderOptions(
  config: AssistantProviderConfig,
  provider: ProviderType,
): StepProviderOptions | undefined {
  const merged = mergeProviderOptions(
    config.global.taktProviders?.selector?.providerOptions,
    config.local.taktProviders?.selector?.providerOptions,
  );
  if (merged === undefined) {
    return undefined;
  }
  const applicableOptions = Object.fromEntries(getSelectorProviderOptionKeys(provider).flatMap((key) => (
    merged[key] === undefined ? [] : [[key, merged[key]]]
  )));
  return Object.keys(applicableOptions).length === 0 ? undefined : applicableOptions as StepProviderOptions;
}

function getSelectorProviderOptionKeys(provider: ProviderType): readonly (keyof StepProviderOptions)[] {
  if (provider === 'claude-sdk') return ['claude'];
  if (provider === 'claude-terminal') return ['claude', 'claudeTerminal'];
  return provider === 'codex'
    || provider === 'opencode'
    || provider === 'claude'
    || provider === 'copilot'
    || provider === 'kiro'
    || provider === 'pi'
    || provider === 'deepseek-harness'
    ? [provider === 'deepseek-harness' ? 'deepseekHarness' : provider]
    : [];
}
