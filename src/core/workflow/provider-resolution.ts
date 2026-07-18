import type { LoopMonitorJudge, WorkflowConfig, WorkflowStep } from '../models/types.js';
import type { AutoRoutingConfig, PersonaProviderEntry, ProviderRoutingConfig, ProviderRoutingEntry } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface ProviderModelResolutionContext {
  provider?: ProviderType;
  model?: string;
  autoRouting?: AutoRoutingConfig;
  providerRouting?: ProviderRoutingConfig;
  personaProviders?: Record<string, PersonaProviderEntry>;
}

export interface StepProviderModelInput extends ProviderModelResolutionContext {
  step: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName'> & {
    name?: string;
    providerSpecified?: boolean;
    modelSpecified?: boolean;
    providerRoutingPersonaKey?: string;
    tags?: string[];
  };
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
  providerSource?: ProviderResolutionSource;
  model?: string;
  modelSource?: ProviderResolutionSource;
}

export interface WorkflowCallProviderModelOutput {
  provider: ProviderType | undefined;
  providerSource?: ProviderResolutionSource;
  model: string | undefined;
  modelSource?: ProviderResolutionSource;
}

export interface LoopMonitorJudgeProviderModelInput {
  judge: Pick<LoopMonitorJudge, 'provider' | 'model' | 'modelSpecified'>;
  triggeringProviderInfo: StepProviderModelOutput;
}

export interface LoopMonitorJudgeProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
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

interface ProviderModelOverride {
  provider?: ProviderType;
  providerSpecified: boolean;
  model?: string;
  modelSpecified: boolean;
  source: ProviderResolutionSource;
}

const PROVIDER_MODEL_SOURCE_PRIORITY: Record<ProviderResolutionSource, number> = {
  cli: 0,
  env: 0,
  promotion: 1,
  step: 2,
  workflow_call: 3,
  'provider_routing.steps': 4,
  'provider_routing.tags': 5,
  'provider_routing.personas': 6,
  persona_providers: 7,
  'auto.rules': 8,
  'auto.ai': 8,
  'auto.default': 8,
  workflow: 9,
  project: 10,
  global: 11,
  default: 12,
};

function hasHigherProviderModelPriority(
  currentSource: ProviderResolutionSource | undefined,
  overrideSource: ProviderResolutionSource,
): boolean {
  return currentSource !== undefined
    && PROVIDER_MODEL_SOURCE_PRIORITY[currentSource] < PROVIDER_MODEL_SOURCE_PRIORITY[overrideSource];
}

function isExplicitProviderModelSource(
  source: ProviderResolutionSource | undefined,
): source is 'cli' | 'env' {
  return source === 'cli' || source === 'env';
}

function resolveLowerPriorityValue<T>(
  projectOrGlobalValue: T | undefined,
  projectOrGlobalSource: ProviderResolutionSource | undefined,
  workflowValue: T | undefined,
): { value: T; source: ProviderResolutionSource | undefined } | undefined {
  if (workflowValue !== undefined) {
    return { value: workflowValue, source: 'workflow' };
  }
  if (projectOrGlobalValue !== undefined) {
    return { value: projectOrGlobalValue, source: projectOrGlobalSource };
  }
  return undefined;
}

export function applyProviderModelOverride<T extends StepProviderModelOutput>(
  current: T,
  override: ProviderModelOverride,
): T {
  const applyProvider = override.providerSpecified
    && !hasHigherProviderModelPriority(current.providerSource, override.source);
  const applyModel = override.modelSpecified
    && !hasHigherProviderModelPriority(current.modelSource, override.source);
  const clearInheritedModel = applyProvider
    && !override.modelSpecified
    && !hasHigherProviderModelPriority(current.modelSource, override.source);

  return {
    ...current,
    ...(applyProvider ? {
      provider: override.provider,
      providerSource: override.source,
    } : {}),
    ...(applyModel ? {
      model: override.model,
      modelSource: override.source,
    } : clearInheritedModel ? {
      model: undefined,
      modelSource: override.source,
    } : {}),
  };
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
  const stepProviderIsDirect = input.step.provider !== undefined
    && input.step.providerSpecified !== false;
  const stepModelIsDirect = input.step.modelSpecified === true
    || (input.step.model !== undefined && input.step.modelSpecified !== false);
  const workflowProvider = input.step.providerSpecified === false
    ? input.step.provider
    : undefined;
  const workflowModel = input.step.modelSpecified === false ? input.step.model : undefined;
  const explicitProviderSource = isExplicitProviderModelSource(input.providerSource)
    ? input.providerSource
    : undefined;
  const explicitProvider = explicitProviderSource !== undefined ? input.provider : undefined;
  const explicitModelSource = isExplicitProviderModelSource(input.modelSource)
    ? input.modelSource
    : undefined;
  const workflowCallProvider = input.providerSource === 'workflow_call' ? input.provider : undefined;
  const workflowCallModelIsResolved = input.modelSource === 'workflow_call';
  const lowerProvider = resolveLowerPriorityValue(
    input.provider,
    input.providerSource,
    workflowProvider,
  );
  const lowerModel = resolveLowerPriorityValue(
    input.model,
    input.modelSource,
    workflowModel,
  );

  let provider: ProviderType | undefined;
  let providerSource: ProviderResolutionSource | undefined;
  if (explicitProvider !== undefined) {
    provider = explicitProvider;
    providerSource = explicitProviderSource;
  } else if (stepProviderIsDirect) {
    provider = input.step.provider;
    providerSource = 'step';
  } else if (workflowCallProvider !== undefined) {
    provider = workflowCallProvider;
    providerSource = 'workflow_call';
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
  } else if (input.autoRouting === undefined && lowerProvider !== undefined) {
    provider = lowerProvider.value;
    providerSource = lowerProvider.source;
  }

  let model: string | undefined;
  let modelSource: ProviderResolutionSource | undefined;
  if (explicitModelSource !== undefined) {
    model = input.model;
    modelSource = explicitModelSource;
  } else if (stepModelIsDirect) {
    model = input.step.model;
    modelSource = 'step';
  } else if (workflowCallModelIsResolved) {
    model = input.model;
    modelSource = 'workflow_call';
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
  } else if ((input.autoRouting === undefined || provider !== undefined) && lowerModel !== undefined) {
    model = lowerModel.value;
    modelSource = lowerModel.source;
  }

  return { provider, model, providerSource, modelSource };
}

export function resolveWorkflowCallProviderModel(
  input: WorkflowCallProviderModelInput,
): WorkflowCallProviderModelOutput {
  const explicitProviderSource = isExplicitProviderModelSource(input.providerSource)
    ? input.providerSource
    : undefined;
  const explicitModelSource = isExplicitProviderModelSource(input.modelSource)
    ? input.modelSource
    : undefined;
  const lowerProvider = resolveLowerPriorityValue(
    input.provider,
    input.providerSource,
    input.workflow.provider,
  );
  const lowerModel = resolveLowerPriorityValue(
    input.model,
    input.modelSource,
    input.workflow.model,
  );
  const provider = explicitProviderSource !== undefined
    ? input.provider
    : lowerProvider?.value;
  const providerSource = explicitProviderSource !== undefined
    ? explicitProviderSource
    : lowerProvider?.source;
  const model = explicitModelSource !== undefined
    ? input.model
    : lowerModel?.value;
  const modelSource = explicitModelSource !== undefined
    ? explicitModelSource
    : lowerModel?.source;
  return { provider, providerSource, model, modelSource };
}

export function resolveLoopMonitorJudgeProviderModel(
  input: LoopMonitorJudgeProviderModelInput,
): LoopMonitorJudgeProviderModelOutput {
  const judgeProviderIsDirect = input.judge.provider !== undefined;
  const judgeModelIsDirect = input.judge.modelSpecified === true
    || (input.judge.model !== undefined && input.judge.modelSpecified !== false);

  return applyProviderModelOverride(input.triggeringProviderInfo, {
    provider: input.judge.provider,
    providerSpecified: judgeProviderIsDirect,
    model: input.judge.model,
    modelSpecified: judgeModelIsDirect,
    source: 'step',
  });
}
