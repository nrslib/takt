import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
  type ModelProviderCandidate,
  type ProviderModelOutput,
} from '../provider-resolution.js';
import type { ProviderType } from '../workflow/types.js';
import type { ConfigAutoRoutingConfig, ProviderTypeOrAuto } from '../models/config-types.js';

export interface AssistantProviderConfigSource {
  provider?: ProviderType;
  model?: string;
  taktProviders?: {
    assistant?: {
      provider?: ProviderType;
      model?: string;
    };
  };
}

export interface AssistantProviderConfig {
  local: AssistantProviderConfigSource;
  global: AssistantProviderConfigSource;
}

export interface AssistantCliOverrides {
  provider?: ProviderType;
  model?: string;
}

export interface NonWorkflowProviderConfigSource {
  provider?: ProviderTypeOrAuto;
  model?: string;
  autoRouting?: Pick<ConfigAutoRoutingConfig, 'defaultProvider'>;
}

export interface NonWorkflowProviderConfig {
  project: NonWorkflowProviderConfigSource;
  global: NonWorkflowProviderConfigSource;
}

const MISSING_AUTO_DEFAULT_PROVIDER_ERROR =
  'Configuration error: auto_routing.default_provider is required when provider is auto for operations without workflow step context.';

function toConcreteModelCandidate(
  source: NonWorkflowProviderConfigSource,
): ModelProviderCandidate {
  if (source.provider === 'auto') {
    return {};
  }
  return { provider: source.provider, model: source.model };
}

export function resolveNonWorkflowProviderModelFromConfig(
  config: NonWorkflowProviderConfig,
): ProviderModelOutput {
  const provider = config.project.provider ?? config.global.provider;
  if (provider !== 'auto') {
    return {
      provider,
      model: resolveModelFromCandidates([
        toConcreteModelCandidate(config.project),
        toConcreteModelCandidate(config.global),
      ], provider),
    };
  }

  const defaultProvider = config.project.autoRouting?.defaultProvider
    ?? config.global.autoRouting?.defaultProvider;
  if (defaultProvider === undefined) {
    throw new Error(MISSING_AUTO_DEFAULT_PROVIDER_ERROR);
  }

  return {
    provider: defaultProvider.provider,
    model: defaultProvider.model,
  };
}

/**
 * Resolve provider/model for assistant interactive mode.
 * Priority: CLI overrides > local assistant > global assistant > local top-level > global top-level
 */
export function resolveAssistantProviderModelFromConfig(
  config: AssistantProviderConfig,
  cliOverrides?: AssistantCliOverrides,
): ProviderModelOutput {
  const localAssistantProvider = config.local.taktProviders?.assistant?.provider;
  const globalAssistantProvider = config.global.taktProviders?.assistant?.provider;
  const provider = resolveProviderModelCandidates([
    { provider: cliOverrides?.provider },
    { provider: localAssistantProvider },
    { provider: globalAssistantProvider },
    { provider: config.local.provider },
    { provider: config.global.provider },
  ]).provider;

  const model = resolveModelFromCandidates([
    { model: cliOverrides?.model },
    {
      model: config.local.taktProviders?.assistant?.model,
      provider: localAssistantProvider,
    },
    {
      model: config.global.taktProviders?.assistant?.model,
      provider: globalAssistantProvider,
    },
    { model: config.local.model, provider: config.local.provider },
    { model: config.global.model, provider: config.global.provider },
  ], provider);

  return { provider, model };
}

export function resolveAssistantScopedProviderModelFromConfig(
  config: AssistantProviderConfig,
): ProviderModelOutput {
  const localAssistantProvider = config.local.taktProviders?.assistant?.provider;
  const globalAssistantProvider = config.global.taktProviders?.assistant?.provider;
  const provider = resolveProviderModelCandidates([
    { provider: localAssistantProvider },
    { provider: globalAssistantProvider },
  ]).provider;

  const model = resolveModelFromCandidates([
    {
      model: config.local.taktProviders?.assistant?.model,
      provider: localAssistantProvider,
    },
    {
      model: config.global.taktProviders?.assistant?.model,
      provider: globalAssistantProvider,
    },
  ], provider);

  return { provider, model };
}
