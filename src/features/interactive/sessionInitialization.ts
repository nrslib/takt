import {
  resolveConfigValues,
  resolveNonWorkflowProviderModel,
} from '../../infra/config/index.js';
import { getProvider } from '../../infra/providers/index.js';
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
  const { language } = resolveConfigValues(cwd, ['language']);
  const lang = language === 'ja' ? 'ja' : 'en';
  const usesAssistantProvider = ['interactive', 'instruct', 'retry'].includes(personaName);
  const resolvedProviderModel = usesAssistantProvider
    ? resolveAssistantProviderModelFromConfig(
      resolveAssistantConfigLayers(cwd),
      assistantCliOverrides,
    )
    : resolveNonWorkflowProviderModel(cwd);
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
