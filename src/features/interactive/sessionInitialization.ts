import { resolveConfigValues } from '../../infra/config/index.js';
import { getProvider, type ProviderType } from '../../infra/providers/index.js';
import {
  resolveAssistantProviderModelFromConfig,
  type AssistantCliOverrides,
} from '../../core/config/provider-resolution.js';
import { resolveAssistantConfigLayers } from './assistantConfig.js';
import type { SessionContext } from './aiCaller.js';

export function initializeSession(
  cwd: string,
  personaName: string,
  assistantCliOverrides?: AssistantCliOverrides,
): SessionContext {
  const globalConfig = resolveConfigValues(cwd, ['language', 'provider', 'model']);
  const lang = globalConfig.language === 'ja' ? 'ja' : 'en';
  const resolvedProviderModel = personaName === 'interactive'
    ? resolveAssistantProviderModelFromConfig(
      resolveAssistantConfigLayers(cwd),
      assistantCliOverrides,
    )
    : {
      provider: globalConfig.provider as ProviderType | undefined,
      model: globalConfig.model as string | undefined,
    };
  const { provider: resolvedProvider, model } = resolvedProviderModel;
  if (!resolvedProvider) {
    throw new Error('Provider is not configured.');
  }

  return {
    provider: getProvider(resolvedProvider),
    providerType: resolvedProvider,
    model,
    lang,
    personaName,
    sessionId: undefined,
  };
}
