import type { PieceMovement } from '../models/types.js';
import type { PersonaProviderEntry } from '../models/persisted-global-config.js';
import type { ProviderType } from './types.js';
import { ProviderTypeSchema } from '../models/schemas.js';

const KNOWN_PROVIDER_TYPES_SET = new Set<ProviderType>(ProviderTypeSchema.options);
type UnknownProviderInput = ProviderType | { type?: unknown; provider?: unknown } | Record<string, unknown> | undefined;

export interface MovementProviderModelInput {
  step: Pick<PieceMovement, 'provider' | 'model' | 'personaDisplayName'> & {
    provider?: UnknownProviderInput;
  };
  provider?: UnknownProviderInput;
  model?: string;
  pieceProvider?: UnknownProviderInput;
  pieceModel?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
}

export interface MovementProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export interface ProviderModelCandidate {
  provider?: UnknownProviderInput;
  model?: string;
}

interface ModelProviderCandidate {
  model?: string;
  provider?: UnknownProviderInput;
}

export interface AgentProviderModelInput {
  cliProvider?: ProviderType;
  cliModel?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
  personaDisplayName?: string;
  stepProvider?: ProviderType;
  stepModel?: string;
  localProvider?: ProviderType;
  localModel?: string;
  globalProvider?: ProviderType;
  globalModel?: string;
}

export interface AgentProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export function resolveProviderType(provider: unknown): ProviderType | undefined {
  if (typeof provider === 'string') {
    return KNOWN_PROVIDER_TYPES_SET.has(provider as ProviderType) ? provider as ProviderType : undefined;
  }

  if (
    provider === null
    || typeof provider !== 'object'
    || Array.isArray(provider)
  ) {
    return undefined;
  }

  const providerRecord = provider as Record<string, unknown>;
  return resolveProviderType(providerRecord.type) ?? resolveProviderType(providerRecord.provider);
}

export function resolveProviderModelCandidates(
  candidates: readonly ProviderModelCandidate[],
): MovementProviderModelOutput {
  let provider: ProviderType | undefined;
  let model: string | undefined;

  for (const candidate of candidates) {
    if (provider === undefined) {
      provider = resolveProviderType(candidate.provider);
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

function resolveModelFromCandidates(
  candidates: readonly ModelProviderCandidate[],
  resolvedProvider: ProviderType | undefined,
): string | undefined {
  for (const candidate of candidates) {
    const { model, provider } = candidate;
    if (model === undefined) {
      continue;
    }
    const normalizedProvider = resolveProviderType(provider);
    if (normalizedProvider !== undefined && normalizedProvider !== resolvedProvider) {
      continue;
    }
    return model;
  }
  return undefined;
}

export function resolveAgentProviderModel(input: AgentProviderModelInput): AgentProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.personaDisplayName ?? ''];
  const provider = resolveProviderModelCandidates([
    { provider: input.cliProvider },
    { provider: personaEntry?.provider },
    { provider: input.stepProvider },
    { provider: input.localProvider },
    { provider: input.globalProvider },
  ]).provider;
  const model = resolveModelFromCandidates([
    { model: input.cliModel },
    { model: personaEntry?.model },
    { model: input.stepModel },
    { model: input.localModel, provider: input.localProvider },
    { model: input.globalModel, provider: input.globalProvider },
  ], provider);

  return { provider, model };
}

export function resolveMovementProviderModel(input: MovementProviderModelInput): MovementProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.step.personaDisplayName];
  const stepProvider = resolveProviderType(input.step.provider);
  const pieceProvider = resolveProviderType(input.pieceProvider);
  const resolvedProvider = resolveProviderModelCandidates([
    { provider: personaEntry?.provider },
    { provider: stepProvider },
    { provider: pieceProvider },
    { provider: input.provider },
  ]).provider;
  const stepModel = typeof input.step.model === 'string' ? input.step.model : undefined;
  const resolvedModel = resolveProviderModelCandidates([
    { model: personaEntry?.model },
    { model: stepModel },
    { model: input.pieceModel },
    { model: input.model },
  ]).model;

  return {
    provider: resolvedProvider,
    model: resolvedModel,
  };
}
