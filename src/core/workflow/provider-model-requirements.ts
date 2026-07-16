import { parseProviderModel } from '../../shared/utils/providerModel.js';

type ProviderModelRequirementsOptions = {
  modelFieldName?: string;
};

export function validateProviderModelRequirements(
  provider: string | undefined,
  model: string | undefined,
  options: ProviderModelRequirementsOptions = {},
): void {
  const { modelFieldName = 'Configuration error: model' } = options;

  if (!provider) return;

  if (provider === 'opencode' && !model) {
    throw new Error(
      "Configuration error: provider 'opencode' requires model in 'provider/model' format (e.g. 'opencode/big-pickle')."
    );
  }

  if (!model) return;

  if (provider === 'opencode') {
    parseProviderModel(model, modelFieldName);
  }
}
