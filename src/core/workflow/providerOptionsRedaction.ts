import type { StepProviderOptions } from '../models/workflow-provider-options.js';

export const CONFIGURED_PROVIDER_OPTION_VALUE = '[configured]';

function redactExtensionSource(source: string): string {
  const trimmedSource = source.trim();
  const credentials = /^(.*?:\/\/)[^/@]+@(.+)$/u.exec(trimmedSource);
  const withoutCredentials = credentials === null
    ? trimmedSource
    : `${credentials[1]}${CONFIGURED_PROVIDER_OPTION_VALUE}@${credentials[2]}`;
  return withoutCredentials.replace(
    /([?&#])([^=&#\s]+)=([^&#]*)/gu,
    (parameter, delimiter: string, rawKey: string) => {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/gu, ' '));
      } catch {
        // Keep the raw key when percent-encoding is malformed.
      }
      return /api[_-]?key|token|password|secret|credential/iu.test(key)
        ? `${delimiter}${rawKey}=${CONFIGURED_PROVIDER_OPTION_VALUE}`
        : parameter;
    },
  );
}

export function redactProviderOptions(
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
  const pi = providerOptions.pi?.extensions !== undefined
    ? {
        ...providerOptions.pi,
        extensions: providerOptions.pi.extensions.map(redactExtensionSource),
      }
    : providerOptions.pi;
  const deepseekHarness = providerOptions.deepseekHarness?.baseUrl !== undefined
    ? {
        ...providerOptions.deepseekHarness,
        baseUrl: CONFIGURED_PROVIDER_OPTION_VALUE,
      }
    : providerOptions.deepseekHarness;
  return {
    ...providerOptions,
    ...(codex !== undefined ? { codex } : {}),
    ...(claude !== undefined ? { claude } : {}),
    ...(pi !== undefined ? { pi } : {}),
    ...(deepseekHarness !== undefined ? { deepseekHarness } : {}),
  };
}
