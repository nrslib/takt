import type { LoopMonitorJudge, WorkflowConfig, WorkflowStep } from '../models/types.js';
import type { AutoRoutingConfig, PersonaProviderEntry, ProviderEscalationTarget, ProviderRoutingConfig, ProviderRoutingEntry, TagRoutingConflictPolicy } from '../models/config-types.js';
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
  /** `escalate` target of the profile behind the engine-level `provider`/`model` defaults. */
  escalation?: ProviderEscalationTarget;
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
  /**
   * How to resolve a step whose tag set maps to two or more distinct tag routing
   * assignments at the same priority. Defaults to `last-wins` (legacy merge order); the
   * runtime-v1 environment sets `fail-fast` so conflicts throw before the agent runs.
   */
  tagConflictPolicy?: TagRoutingConflictPolicy;
}

export interface StepProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  /**
   * `escalate` target declared by the runtime.yaml profile that supplied the provider.
   * A profile always carries provider and model together, so the provider-winning layer is
   * the layer that identifies the profile.
   */
  escalation?: ProviderEscalationTarget;
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
  judgeProviderInfo?: StepProviderModelOutput;
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
  'auto.dynamic': 8,
  'auto.fallback': 8,
  workflow: 9,
  project: 10,
  global: 11,
  'runtime-v1': 11,
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

/**
 * Serialize a value with object keys recursively sorted so that assignments that differ
 * only in key insertion order produce the same identity. `normalizeProviderOptions`
 * already normalizes shape, but identity must not depend on that step, so sorting keeps
 * AC "options key-order-only difference does not conflict" unconditionally true.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
  return `{${entries.join(',')}}`;
}

function tagRoutingEntryIdentity(
  entry: Pick<ProviderRoutingEntry, 'provider' | 'model' | 'providerOptions' | 'escalation'>,
): string {
  const options = entry.providerOptions !== undefined ? stableSerialize(entry.providerOptions) : '';
  // escalate 先が違えば別の割り当てである。identity から外すと、格上げ先だけが
  // 異なる2つの tag 割り当てが「同じ」と判定され、fail-fast を素通りする。
  return `${entry.provider ?? ''}::${entry.model ?? ''}::${options}::${entry.escalation?.profile ?? ''}`;
}

function resolveTagProviderRoutingEntry(
  providerRouting: ProviderRoutingConfig | undefined,
  tags: readonly string[] | undefined,
  tagConflictPolicy: TagRoutingConflictPolicy | undefined,
): Pick<ProviderRoutingEntry, 'provider' | 'model' | 'escalation'> | undefined {
  if (!providerRouting?.tags || !tags || tags.length === 0) {
    return undefined;
  }

  const routingTags = providerRouting.tags;
  const matchedTags = tags.filter((tag): tag is string => routingTags[tag] !== undefined);
  if (matchedTags.length === 0) {
    return undefined;
  }

  if (tagConflictPolicy === 'fail-fast') {
    const distinct = new Set(
      matchedTags.map((tag) => tagRoutingEntryIdentity(routingTags[tag] as ProviderRoutingEntry)),
    );
    if (distinct.size > 1) {
      throw new Error(
        `Conflicting provider routing for tags [${matchedTags.join(', ')}] at the same priority`,
      );
    }
  }

  let resolved: ProviderRoutingEntry | undefined;
  for (const tag of matchedTags) {
    const entry = routingTags[tag] as ProviderRoutingEntry;
    // escalation は provider を供給した profile のものなので provider と一緒に動く。
    // provider を上書きするブランチでは、上書き元が escalate を持たない場合でも
    // 前の entry の escalation を必ず捨てる（残すと別 profile の格上げ先が付く）。
    const escalationOverride = entry.provider !== undefined
      ? entry.escalation
      : resolved?.escalation;
    resolved = {
      ...(resolved?.provider !== undefined ? { provider: resolved.provider } : {}),
      ...(resolved?.model !== undefined ? { model: resolved.model } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(escalationOverride !== undefined ? { escalation: escalationOverride } : {}),
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
  const routingTagEntry = resolveTagProviderRoutingEntry(
    input.providerRouting,
    input.step.tags,
    input.tagConflictPolicy,
  );
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

  const escalation = resolveEscalationForProviderSource(providerSource, {
    'provider_routing.steps': routingStepEntry?.escalation,
    'provider_routing.tags': routingTagEntry?.escalation,
    'provider_routing.personas': routingPersonaEntry?.escalation,
    persona_providers: personaEntry?.escalation,
    'runtime-v1': input.escalation,
  });

  return {
    provider,
    model,
    providerSource,
    modelSource,
    ...(escalation !== undefined ? { escalation } : {}),
  };
}

/**
 * Only layers that resolve to a runtime.yaml profile carry an escalation target. An explicit
 * CLI/step/workflow_call provider deliberately overrides the profile, so it escalates nowhere.
 */
function resolveEscalationForProviderSource(
  providerSource: ProviderResolutionSource | undefined,
  bySource: Partial<Record<ProviderResolutionSource, ProviderEscalationTarget | undefined>>,
): ProviderEscalationTarget | undefined {
  return providerSource === undefined ? undefined : bySource[providerSource];
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
  const judgeInfo = input.judgeProviderInfo ?? {
    provider: input.judge.provider,
    model: input.judge.model,
    providerSource: input.judge.provider !== undefined ? 'step' as const : undefined,
    modelSource: (input.judge.modelSpecified === true
      || (input.judge.model !== undefined && input.judge.modelSpecified !== false))
      ? 'step' as const
      : undefined,
  };
  const explicitSources: ReadonlySet<ProviderResolutionSource> = new Set([
    'cli',
    'env',
    'step',
    'provider_routing.steps',
    'provider_routing.tags',
    'provider_routing.personas',
    'persona_providers',
  ]);
  const providerIsExplicit = judgeInfo.providerSource !== undefined
    && explicitSources.has(judgeInfo.providerSource);
  const modelIsExplicit = judgeInfo.modelSource !== undefined
    && explicitSources.has(judgeInfo.modelSource);

  return {
    provider: providerIsExplicit ? judgeInfo.provider : input.triggeringProviderInfo.provider,
    providerSource: providerIsExplicit
      ? judgeInfo.providerSource
      : input.triggeringProviderInfo.providerSource,
    model: modelIsExplicit
      ? judgeInfo.model
      : (providerIsExplicit ? undefined : input.triggeringProviderInfo.model),
    modelSource: modelIsExplicit
      ? judgeInfo.modelSource
      : (providerIsExplicit ? judgeInfo.providerSource : input.triggeringProviderInfo.modelSource),
  };
}
