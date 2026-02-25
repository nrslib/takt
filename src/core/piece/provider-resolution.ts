import type { PieceMovement } from '../models/types.js';
import type { PersonaProviderEntry } from '../models/persisted-global-config.js';
import type { ProviderType } from './types.js';

export interface MovementProviderModelInput {
  step: Pick<PieceMovement, 'provider' | 'model' | 'personaDisplayName'>;
  provider?: ProviderType;
  model?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
}

export interface MovementProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export interface ProviderModelCandidate {
  provider?: ProviderType;
  model?: string;
}

export function resolveProviderModelCandidates(
  candidates: readonly ProviderModelCandidate[],
): MovementProviderModelOutput {
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

export function resolveMovementProviderModel(input: MovementProviderModelInput): MovementProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.step.personaDisplayName];
  const provider = resolveProviderModelCandidates([
    { provider: personaEntry?.provider },
    { provider: input.step.provider },
    { provider: input.provider },
  ]).provider;
  const model = resolveProviderModelCandidates([
    { model: personaEntry?.model },
    { model: input.step.model },
    { model: input.model },
  ]).model;
  return { provider, model };
}
