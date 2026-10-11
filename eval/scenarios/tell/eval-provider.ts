import { isProviderType, type ProviderType } from '../../../src/shared/types/provider.js';

export function resolveEvalProvider(
  provider: string | undefined,
  model: string | undefined,
): { providerType: Exclude<ProviderType, 'mock'>; model: string | undefined } {
  const providerType = provider ?? 'codex';
  if (!isProviderType(providerType) || providerType === 'mock') {
    throw new Error(`Evaluation requires a real provider; received "${providerType}"`);
  }
  return { providerType, model };
}
