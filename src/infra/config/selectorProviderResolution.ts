import type { AssistantProviderConfig } from '../../core/config/provider-resolution.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { mergeProviderOptions } from './providerOptions.js';
import { validateProviderModelRequirements } from '../../core/workflow/provider-model-requirements.js';
import { ConfiguredModelSchema } from '../../core/models/model-schema.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { resolveConfigValueWithSource } from './resolveConfigValue.js';

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
  return provider === 'codex' || provider === 'opencode' || provider === 'claude' || provider === 'copilot' || provider === 'kiro'
    ? [provider]
    : [];
}
