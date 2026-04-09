import { parseProviderModel } from '../../shared/utils/providerModel.js';

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

type ProviderModelCompatibilityOptions = {
  modelFieldName?: string;
  requireProviderQualifiedModelForOpencode?: boolean;
};

export function validateProviderModelCompatibility(
  provider: string | undefined,
  model: string | undefined,
  options: ProviderModelCompatibilityOptions = {},
): void {
  const {
    modelFieldName = 'Configuration error: model',
    requireProviderQualifiedModelForOpencode = true,
  } = options;

  if (!provider) return;

  if (provider === 'opencode' && !model) {
    throw new Error(
      "Configuration error: provider 'opencode' requires model in 'provider/model' format (e.g. 'opencode/big-pickle')."
    );
  }

  if (!model) return;

  if ((provider === 'codex' || provider === 'opencode') && CLAUDE_MODEL_ALIASES.has(model)) {
    throw new Error(
      `Configuration error: model '${model}' is a Claude model alias but provider is '${provider}'. ` +
      `Either change the provider to 'claude-sdk' (or headless 'claude') or specify a ${provider}-compatible model.`
    );
  }

  if (provider === 'opencode' && requireProviderQualifiedModelForOpencode) {
    parseProviderModel(model, modelFieldName);
  }
}
