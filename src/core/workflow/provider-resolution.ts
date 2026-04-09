import type { LoopMonitorJudge, WorkflowStep } from '../models/types.js';
import type { PersonaProviderEntry } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';

export interface StepProviderModelInput {
  step: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName'>;
  provider?: ProviderType;
  model?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
}

export interface StepProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
}

export interface LoopMonitorJudgeProviderModelInput {
  judge: Pick<LoopMonitorJudge, 'provider' | 'model'>;
  triggeringStep: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName'>;
  provider?: ProviderType;
  model?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
}

export interface LoopMonitorJudgeProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
}

export interface AgentProviderModelInput {
  cliProvider?: ProviderType;
  cliModel?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
  personaDisplayName?: string;
  localProvider?: ProviderType;
  localModel?: string;
  globalProvider?: ProviderType;
  globalModel?: string;
}

export interface AgentProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export function resolveAgentProviderModel(input: AgentProviderModelInput): AgentProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.personaDisplayName ?? ''];
  const provider = resolveProviderModelCandidates([
    { provider: input.cliProvider },
    { provider: personaEntry?.provider },
    { provider: input.localProvider },
    { provider: input.globalProvider },
  ]).provider;
  const model = resolveModelFromCandidates([
    { model: input.cliModel },
    { model: personaEntry?.model },
    { model: input.localModel, provider: input.localProvider },
    { model: input.globalModel, provider: input.globalProvider },
  ], provider);

  return { provider, model };
}
export function resolveStepProviderModel(input: StepProviderModelInput): StepProviderModelOutput {
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

export function resolveLoopMonitorJudgeProviderModel(
  input: LoopMonitorJudgeProviderModelInput,
): LoopMonitorJudgeProviderModelOutput {
  const triggeringStep = resolveStepProviderModel({
    step: input.triggeringStep,
    provider: input.provider,
    model: input.model,
    personaProviders: input.personaProviders,
  });

  return {
    provider: input.judge.provider ?? triggeringStep.provider,
    model: input.judge.model
      ?? (input.judge.provider !== undefined ? undefined : triggeringStep.model),
  };
}
