import type { LoopMonitorJudge, WorkflowConfig, WorkflowStep } from '../models/types.js';
import type { PersonaProviderEntry, ProviderRoutingConfig, ProviderRoutingEntry } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface StepProviderModelInput {
  step: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName'> & {
    name?: string;
    providerSpecified?: boolean;
    modelSpecified?: boolean;
    providerRoutingPersonaKey?: string;
    tags?: string[];
  };
  provider?: ProviderType;
  model?: string;
  providerRouting?: ProviderRoutingConfig;
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
  triggeringStep: StepProviderModelInput['step'];
  provider?: ProviderType;
  model?: string;
  providerRouting?: ProviderRoutingConfig;
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

function resolveTagProviderRoutingEntry(
  providerRouting: ProviderRoutingConfig | undefined,
  tags: readonly string[] | undefined,
): Pick<ProviderRoutingEntry, 'provider' | 'model'> | undefined {
  if (!providerRouting?.tags || !tags || tags.length === 0) {
    return undefined;
  }

  let resolved: ProviderRoutingEntry | undefined;
  for (const tag of tags) {
    const entry = providerRouting.tags[tag];
    if (!entry) {
      continue;
    }
    resolved = {
      ...(resolved?.provider !== undefined ? { provider: resolved.provider } : {}),
      ...(resolved?.model !== undefined ? { model: resolved.model } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
    };
  }
  return resolved;
}

export function resolveStepProviderModel(input: StepProviderModelInput): StepProviderModelOutput {
  if (input.providerRouting?.steps && input.step.name === undefined) {
    throw new Error('Provider routing step resolution requires step.name');
  }
  const routingStepEntry = input.step.name !== undefined
    ? input.providerRouting?.steps?.[input.step.name]
    : undefined;
  const routingTagEntry = resolveTagProviderRoutingEntry(input.providerRouting, input.step.tags);
  const routingPersonaEntry = input.step.providerRoutingPersonaKey
    ? input.providerRouting?.personas?.[input.step.providerRoutingPersonaKey]
    : undefined;
  const personaEntry = input.personaProviders?.[input.step.personaDisplayName];
  const stepProviderIsDirect = input.step.provider !== undefined && input.step.providerSpecified !== false;
  const stepModelIsDirect = input.step.model !== undefined && input.step.modelSpecified !== false;
  const workflowProvider = input.step.providerSpecified === false ? input.step.provider : undefined;
  const workflowModel = input.step.modelSpecified === false ? input.step.model : undefined;

  let provider: ProviderType | undefined;
  let providerSource: ProviderResolutionSource | undefined;
  if (stepProviderIsDirect) {
    provider = input.step.provider;
    providerSource = 'step';
  } else if (routingStepEntry?.provider !== undefined) {
    provider = routingStepEntry.provider;
    providerSource = 'provider_routing.steps';
  } else if (routingTagEntry?.provider !== undefined) {
    provider = routingTagEntry.provider;
    providerSource = 'provider_routing.tags';
  } else if (routingPersonaEntry?.provider !== undefined) {
    provider = routingPersonaEntry.provider;
    providerSource = 'provider_routing.personas';
  } else if (personaEntry?.provider !== undefined) {
    provider = personaEntry.provider;
    providerSource = 'persona_providers';
  } else if (workflowProvider !== undefined) {
    provider = workflowProvider;
    providerSource = 'workflow';
  } else if (input.provider !== undefined) {
    provider = input.provider;
    providerSource = input.providerSource;
  }

  let model: string | undefined;
  let modelSource: ProviderResolutionSource | undefined;
  if (stepModelIsDirect) {
    model = input.step.model;
    modelSource = 'step';
  } else if (routingStepEntry?.model !== undefined) {
    model = routingStepEntry.model;
    modelSource = 'provider_routing.steps';
  } else if (routingTagEntry?.model !== undefined) {
    model = routingTagEntry.model;
    modelSource = 'provider_routing.tags';
  } else if (routingPersonaEntry?.model !== undefined) {
    model = routingPersonaEntry.model;
    modelSource = 'provider_routing.personas';
  } else if (personaEntry?.model !== undefined) {
    model = personaEntry.model;
    modelSource = 'persona_providers';
  } else if (workflowModel !== undefined) {
    model = workflowModel;
    modelSource = 'workflow';
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
    providerRouting: input.providerRouting,
    personaProviders: input.personaProviders,
  });

  return {
    provider: input.judge.provider ?? triggeringStep.provider,
    model: input.judge.model
      ?? (input.judge.provider !== undefined ? undefined : triggeringStep.model),
  };
}
