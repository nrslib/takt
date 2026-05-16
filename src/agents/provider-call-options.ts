import { providerSupportsMaxTurns } from '../infra/providers/provider-capabilities.js';
import type { ProviderType } from '../shared/types/provider.js';
import type { RunAgentOptions } from './runner.js';

export function buildMaxTurnsOption(
  provider: ProviderType | undefined,
  resolvedProvider: ProviderType | undefined,
  maxTurns: number,
): Pick<RunAgentOptions, 'maxTurns'> {
  const effectiveProvider = resolvedProvider ?? provider;
  if (providerSupportsMaxTurns(effectiveProvider) === false) {
    return {};
  }
  return { maxTurns };
}
