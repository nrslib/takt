import type { StepProviderInfo } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface ProviderValidationErrorSource {
  field: 'provider' | 'model';
  source: ProviderResolutionSource | undefined;
  providerSource: ProviderResolutionSource | undefined;
  modelSource: ProviderResolutionSource | undefined;
}

const providerValidationErrorSources = new WeakMap<Error, ProviderValidationErrorSource>();

export function withProviderValidationErrorSource(
  error: unknown,
  providerInfo: Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource' | 'modelSource'>,
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const field = providerInfo.provider === undefined
    || (providerInfo.provider === 'opencode' && providerInfo.model === undefined)
    ? 'provider'
    : 'model';
  providerValidationErrorSources.set(normalized, {
    field,
    source: field === 'provider' ? providerInfo.providerSource : providerInfo.modelSource,
    providerSource: providerInfo.providerSource,
    modelSource: providerInfo.modelSource,
  });
  return normalized;
}

export function getProviderValidationErrorSource(error: unknown): ProviderValidationErrorSource | undefined {
  let current = error;
  while (current instanceof Error) {
    const source = providerValidationErrorSources.get(current);
    if (source) {
      return source;
    }
    current = current.cause;
  }
  return undefined;
}
