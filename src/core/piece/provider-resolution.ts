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

export function resolveMovementProviderModel(input: MovementProviderModelInput): MovementProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.step.personaDisplayName];
  return {
    provider: input.step.provider
      ?? personaEntry?.provider
      ?? input.provider,
    model: input.step.model ?? personaEntry?.model ?? input.model,
  };
}
