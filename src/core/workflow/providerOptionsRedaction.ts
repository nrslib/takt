import type { StepProviderOptions } from '../models/workflow-provider-options.js';

export const CONFIGURED_PROVIDER_OPTION_VALUE = '[configured]';

export function redactProviderOptionsForLogging(
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions | undefined {
  if (providerOptions === undefined) {
    return undefined;
  }

  const codex = providerOptions.codex?.baseUrl !== undefined
    ? { ...providerOptions.codex, baseUrl: CONFIGURED_PROVIDER_OPTION_VALUE }
    : providerOptions.codex;
  const claude = providerOptions.claude?.baseUrl !== undefined
    ? { ...providerOptions.claude, baseUrl: CONFIGURED_PROVIDER_OPTION_VALUE }
    : providerOptions.claude;

  return {
    ...providerOptions,
    ...(codex !== undefined ? { codex } : {}),
    ...(claude !== undefined ? { claude } : {}),
  };
}
