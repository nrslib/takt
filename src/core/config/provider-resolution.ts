import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
  type ProviderModelOutput,
} from '../provider-resolution.js';
import type { ProviderType } from '../workflow/types.js';

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
  provider?: ProviderType;
  model?: string;
}

export interface NonWorkflowProviderConfig {
  project: NonWorkflowProviderConfigSource;
  global: NonWorkflowProviderConfigSource;
}

export function resolveNonWorkflowProviderModelFromConfig(
  config: NonWorkflowProviderConfig,
): ProviderModelOutput {
  const provider = config.project.provider ?? config.global.provider;
  return {
    provider,
    model: resolveModelFromCandidates([
      { provider: config.project.provider, model: config.project.model },
      { provider: config.global.provider, model: config.global.model },
    ], provider),
  };
}

/**
 * Resolve provider/model for assistant conversations (interactive, instruct, retry).
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
