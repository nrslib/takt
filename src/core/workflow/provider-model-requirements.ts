import { parseProviderModel } from '../../shared/utils/providerModel.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

type ProviderModelRequirementsOptions = {
  modelFieldName?: string;
  modelSource?: ProviderResolutionSource;
};

export function allowsOpenCodeDefaultModel(
  provider: string | undefined,
  model: string | undefined,
  modelSource: ProviderResolutionSource | undefined,
): boolean {
  return provider === 'opencode' && model === undefined && modelSource === 'default';
}

export function validateProviderModelRequirements(
  provider: string | undefined,
  model: string | undefined,
  options: ProviderModelRequirementsOptions = {},
): void {
  const {
    modelFieldName = 'Configuration error: model',
    modelSource,
  } = options;

  if (!provider) return;

  if (provider === 'opencode' && !model && !allowsOpenCodeDefaultModel(provider, model, modelSource)) {
    throw new Error(
      "Configuration error: provider 'opencode' requires model in 'provider/model' format (e.g. 'opencode/big-pickle')."
    );
  }

  if (!model) return;

  if (provider === 'opencode') {
    parseProviderModel(model, modelFieldName);
  }
}
