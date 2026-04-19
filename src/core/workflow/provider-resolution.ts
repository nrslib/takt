import type { LoopMonitorJudge, WorkflowConfig, WorkflowStep } from '../models/types.js';
import type { PersonaProviderEntry } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface StepProviderModelInput {
  step: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName'>;
  provider?: ProviderType;
  model?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Source layer of `provider` argument (engine-level fallback). */
  providerSource?: ProviderResolutionSource;
  /** Source layer of `model` argument (engine-level fallback). */
  modelSource?: ProviderResolutionSource;
}

export interface StepProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
}

export interface WorkflowCallProviderModelInput {
  workflow: Pick<WorkflowConfig, 'provider' | 'model'>;
  provider?: ProviderType;
  model?: string;
}

export interface WorkflowCallProviderModelOutput {
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

  let provider: ProviderType | undefined;
  let providerSource: ProviderResolutionSource | undefined;
  if (personaEntry?.provider !== undefined) {
    provider = personaEntry.provider;
    providerSource = 'persona_providers';
  } else if (input.step.provider !== undefined) {
    provider = input.step.provider;
    providerSource = 'step';
  } else if (input.provider !== undefined) {
    provider = input.provider;
    providerSource = input.providerSource;
  }

  let model: string | undefined;
  let modelSource: ProviderResolutionSource | undefined;
  if (personaEntry?.model !== undefined) {
    model = personaEntry.model;
    modelSource = 'persona_providers';
  } else if (input.step.model !== undefined) {
    model = input.step.model;
    modelSource = 'step';
  } else if (input.model !== undefined) {
    model = input.model;
    modelSource = input.modelSource;
  }

  return { provider, model, providerSource, modelSource };
}

export function resolveWorkflowCallProviderModel(
  input: WorkflowCallProviderModelInput,
): WorkflowCallProviderModelOutput {
  const provider = resolveProviderModelCandidates([
    { provider: input.workflow.provider },
    { provider: input.provider },
  ]).provider;
  const model = resolveProviderModelCandidates([
    { model: input.workflow.model },
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
