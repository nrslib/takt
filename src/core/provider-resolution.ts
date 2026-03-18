import type { ProviderType } from './piece/types.js';

export interface ProviderModelCandidate {
  provider?: ProviderType;
  model?: string;
}

export interface ModelProviderCandidate {
  model?: string;
  provider?: ProviderType;
}

export interface ProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export function resolveProviderModelCandidates(
  candidates: readonly ProviderModelCandidate[],
): ProviderModelOutput {
  let provider: ProviderType | undefined;
  let model: string | undefined;

  for (const candidate of candidates) {
    if (provider === undefined && candidate.provider !== undefined) {
      provider = candidate.provider;
    }
    if (model === undefined && candidate.model !== undefined) {
      model = candidate.model;
    }
    if (provider !== undefined && model !== undefined) {
      break;
    }
  }

  return { provider, model };
}

export function resolveModelFromCandidates(
  candidates: readonly ModelProviderCandidate[],
  resolvedProvider: ProviderType | undefined,
): string | undefined {
  for (const candidate of candidates) {
    const { model, provider } = candidate;
    if (model === undefined) {
      continue;
    }
    if (provider !== undefined && provider !== resolvedProvider) {
      continue;
    }
    return model;
  }
  return undefined;
}
