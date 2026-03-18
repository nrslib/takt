import { resolveAssistantProviderModel, type AssistantProviderModelOutput } from '../piece/provider-resolution.js';
import type { ProviderType } from '../piece/types.js';

export interface AssistantProviderConfig {
  provider?: ProviderType;
  model?: string;
  taktProviders?: {
    assistant?: {
      provider?: ProviderType;
      model?: string;
    };
  };
}

export interface AssistantCliOverrides {
  provider?: ProviderType;
  model?: string;
}

/**
 * Resolve provider/model for assistant interactive mode.
 * Priority: takt_providers.assistant > CLI overrides > top-level provider/model
 */
export function resolveAssistantProviderModelFromConfig(
  config: AssistantProviderConfig,
  cliOverrides?: AssistantCliOverrides,
): AssistantProviderModelOutput {
  return resolveAssistantProviderModel({
    assistantProvider: config.taktProviders?.assistant?.provider,
    assistantModel: config.taktProviders?.assistant?.model,
    cliProvider: cliOverrides?.provider,
    cliModel: cliOverrides?.model,
    globalProvider: config.provider,
    globalModel: config.model,
  });
}
