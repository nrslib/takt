import {
  resolveConfigValues,
  resolveNonWorkflowProviderModel,
  resolveNonWorkflowProviderOptions,
} from '../../infra/config/index.js';
import { getProvider } from '../../infra/providers/index.js';
import type { AssistantCliOverrides } from '../../core/config/provider-resolution.js';
import { resolveAssistantProviderModel } from './assistantConfig.js';
import type { SessionContext } from './aiCaller.js';

/**
 * Raised when no provider could be resolved. The message is unchanged, so
 * existing callers that only surface `error.message` behave exactly as before;
 * the type lets a front-end localize instead of matching on the text.
 */
export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('Provider is not configured.');
    this.name = 'ProviderNotConfiguredError';
  }
}

export function initializeSession(
  cwd: string,
  personaName: string,
  assistantCliOverrides?: AssistantCliOverrides,
): SessionContext {
  const { language } = resolveConfigValues(cwd, ['language']);
  const lang = language === 'ja' ? 'ja' : 'en';
  const usesAssistantProvider = ['interactive', 'grill-me-interactive', 'instruct', 'retry'].includes(personaName);
  const resolved = usesAssistantProvider
    ? resolveAssistantProviderModel(cwd, assistantCliOverrides)
    : resolveNonWorkflowProviderModel(cwd);
  const { provider: resolvedProvider, model } = resolved;
  if (!resolvedProvider) {
    throw new ProviderNotConfiguredError();
  }
  // A runtime-v1 assistant or non-workflow `defaults` profile owns its options (the assistant path
  // drops them on a CLI provider override); every other case keeps the legacy `provider_options`
  // resolution unchanged so provider/model/options come from one source.
  const providerOptions = resolved.runtimeManaged
    ? resolved.providerOptions
    : resolveNonWorkflowProviderOptions(cwd);

  return {
    provider: getProvider(resolvedProvider),
    providerType: resolvedProvider,
    model,
    lang,
    personaName,
    sessionId: undefined,
    providerOptions,
    permissionMode: resolved.permissionMode,
  };
}
