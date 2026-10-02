import type { WorkflowStep } from '../models/types.js';
import type { AutoRoutingConfig, PersonaProviderEntry, ProviderRoutingConfig, ProviderRoutingEntry, TagRoutingConflictPolicy } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';
import { hasAutoRoutingPoolAssignment } from './auto-routing/selector.js';
import { resolveWorkflowStepTarget } from './provider-target-resolution.js';

export interface ProviderModelResolutionContext {
  provider?: ProviderType;
  model?: string;
  /** Provider explicitly paired with the lower-priority model configuration value. */
  modelProvider?: ProviderType;
  autoRouting?: AutoRoutingConfig;
  providerRouting?: ProviderRoutingConfig;
  personaProviders?: Record<string, PersonaProviderEntry>;
  /** Permission mode tied to the engine-level runtime defaults profile. */
  permissionMode?: import('../models/types.js').PermissionMode;
}

export interface StepProviderModelInput extends ProviderModelResolutionContext {
  step: Pick<WorkflowStep, 'provider' | 'model' | 'personaDisplayName' | 'engineSynthesized'> & {
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
  /** Provider paired with model when provider selection is deferred to auto routing. */
  modelProvider?: ProviderType;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  permissionMode?: import('../models/types.js').PermissionMode;
  providerOptions?: import('../models/workflow-types.js').StepProviderOptions;
}

export interface WorkflowCallProviderModelInput {
  provider?: ProviderType;
  providerSource?: ProviderResolutionSource;
  model?: string;
  modelSource?: ProviderResolutionSource;
  modelProvider?: ProviderType;
  /** Permission mode tied to the inherited provider source. */
  permissionMode?: import('../models/types.js').PermissionMode;
}

export interface WorkflowCallProviderModelOutput {
  provider: ProviderType | undefined;
  providerSource?: ProviderResolutionSource;
  model: string | undefined;
  modelSource?: ProviderResolutionSource;
  modelProvider?: ProviderType;
  permissionMode?: import('../models/types.js').PermissionMode;
}

export interface LoopMonitorJudgeProviderModelInput {
  judgeProviderInfo: StepProviderModelOutput;
  triggeringProviderInfo: StepProviderModelOutput;
}

export interface LoopMonitorJudgeProviderModelOutput {
  provider: ProviderType | undefined;
  model: string | undefined;
  modelProvider?: ProviderType;
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  permissionMode?: import('../models/types.js').PermissionMode;
  providerOptions?: import('../models/workflow-types.js').StepProviderOptions;
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

type ResolvedTagProviderRoutingEntry = Pick<ProviderRoutingEntry, 'provider' | 'model' | 'permissionMode'> & {
  modelProvider?: ProviderType;
};

const PROVIDER_MODEL_SOURCE_PRIORITY: Record<ProviderResolutionSource, number> = {
  cli: 0,
  env: 0,
  promotion: 1,
  step: 2,
  'provider_routing.steps': 3,
  'provider_routing.tags': 4,
  'provider_routing.personas': 5,
  persona_providers: 6,
  'auto.rules': 7,
  'auto.dynamic': 7,
  'auto.fallback': 7,
  // Listed only to satisfy the shared source union; a capability set never carries provider/model.
  capabilities: 8,
  project: 9,
  global: 10,
  'runtime-v1': 10,
  default: 11,
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
): { value: T; source: ProviderResolutionSource | undefined } | undefined {
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
      ...(override.providerSpecified
        ? { modelProvider: override.provider }
        : current.modelProvider === undefined
          ? {}
          : { modelProvider: undefined }),
    } : clearInheritedModel ? {
      model: undefined,
      modelSource: override.source,
      ...(current.modelProvider === undefined ? {} : { modelProvider: undefined }),
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

export function tagRoutingEntryIdentity(
  entry: Pick<ProviderRoutingEntry, 'provider' | 'model' | 'providerOptions' | 'permissionMode'>,
): string {
  const options = entry.providerOptions !== undefined ? stableSerialize(entry.providerOptions) : '';
  return `${entry.provider ?? ''}::${entry.model ?? ''}::${options}::${entry.permissionMode ?? ''}`;
}

/**
 * 同一優先度で複数の tag が一致したとき、それらが同じ割り当てを指しているかを判定する。
 * stage 0 の割り当てと promotion の ladder 選択が同じ判定を共有するために公開している。
 * 別実装にすると、片方が fail-fast する入力をもう片方が黙って last-wins で解決する。
 */
export function assertTagMatchesAgree(
  matches: readonly { tag: string; identity: string }[],
  policy: TagRoutingConflictPolicy | undefined,
  conflictSubject: string,
): void {
  if (policy !== 'fail-fast') {
    return;
  }
  if (new Set(matches.map((match) => match.identity)).size <= 1) {
    return;
  }
  const tags = matches.map((match) => match.tag).join(', ');
  throw new Error(`Conflicting ${conflictSubject} for tags [${tags}] at the same priority`);
}

function resolveTagProviderRoutingEntry(
  providerRouting: ProviderRoutingConfig | undefined,
  tags: readonly string[] | undefined,
  tagConflictPolicy: TagRoutingConflictPolicy | undefined,
): ResolvedTagProviderRoutingEntry | undefined {
  if (!providerRouting?.tags || !tags || tags.length === 0) {
    return undefined;
  }

  const routingTags = providerRouting.tags;
  const matchedTags = tags.filter((tag): tag is string => routingTags[tag] !== undefined);
  if (matchedTags.length === 0) {
    return undefined;
  }

  assertTagMatchesAgree(
    matchedTags.map((tag) => ({
      tag,
      identity: tagRoutingEntryIdentity(routingTags[tag] as ProviderRoutingEntry),
    })),
    tagConflictPolicy,
    'provider routing',
  );

  let resolved: ProviderRoutingEntry | undefined;
  let modelProvider: ProviderType | undefined;
  for (const tag of matchedTags) {
    const entry = routingTags[tag] as ProviderRoutingEntry;
    const permissionModeOverride = entry.provider !== undefined
      ? entry.permissionMode
      : resolved?.permissionMode;
    resolved = {
      ...(resolved?.provider !== undefined ? { provider: resolved.provider } : {}),
      ...(resolved?.model !== undefined ? { model: resolved.model } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(permissionModeOverride !== undefined ? { permissionMode: permissionModeOverride } : {}),
    };
    if (entry.model !== undefined) {
      modelProvider = entry.provider;
    }
  }
  return resolved === undefined ? undefined : { ...resolved, modelProvider };
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
  const routingStepEntry = resolveWorkflowStepTarget(
    input.providerRouting?.steps,
    input.step.name,
    input.providerRouting?.workflowName,
  );
  const routingTagEntry = resolveTagProviderRoutingEntry(
    input.providerRouting,
    input.step.tags,
    input.tagConflictPolicy,
  );
  const routingPersonaEntry = input.step.providerRoutingPersonaKey
    ? input.providerRouting?.personas?.[input.step.providerRoutingPersonaKey]
    : undefined;
  const personaEntry = input.personaProviders?.[input.step.personaDisplayName];
  const stepProviderIsDirect = input.step.engineSynthesized === true
    && input.step.provider !== undefined
    && input.step.providerSpecified !== false;
  const stepModelIsDirect = input.step.engineSynthesized === true && (
    input.step.modelSpecified === true
    || (input.step.model !== undefined && input.step.modelSpecified !== false)
  );
  const explicitProviderSource = isExplicitProviderModelSource(input.providerSource)
    ? input.providerSource
    : undefined;
  const explicitProvider = explicitProviderSource !== undefined ? input.provider : undefined;
  const explicitModelSource = input.model !== undefined && isExplicitProviderModelSource(input.modelSource)
    ? input.modelSource
    : undefined;
  const absentExplicitModelSource = input.model === undefined && isExplicitProviderModelSource(input.modelSource)
    ? input.modelSource
    : undefined;
  const autoRoutingApplies = input.autoRouting !== undefined
    && hasAutoRoutingPoolAssignment(input.autoRouting, {
      name: input.step.name,
      tags: input.step.tags,
      personaKey: input.step.providerRoutingPersonaKey,
    });
  const lowerProvider = resolveLowerPriorityValue(
    input.provider,
    input.providerSource,
  );
  const lowerModel = resolveLowerPriorityValue(
    input.model,
    input.modelSource,
  );

  let provider: ProviderType | undefined;
  let providerSource: ProviderResolutionSource | undefined;
  if (explicitProvider !== undefined) {
    provider = explicitProvider;
    providerSource = explicitProviderSource;
  } else if (stepProviderIsDirect) {
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
  } else if (!autoRoutingApplies && lowerProvider !== undefined) {
    provider = lowerProvider.value;
    providerSource = lowerProvider.source;
  }

  let model: string | undefined;
  let modelSource: ProviderResolutionSource | undefined;
  let modelProvider: ProviderType | undefined;
  if (explicitModelSource !== undefined) {
    model = input.model;
    modelSource = explicitModelSource;
  } else if (stepModelIsDirect) {
    model = input.step.model;
    modelSource = 'step';
    modelProvider = stepProviderIsDirect ? input.step.provider : undefined;
  } else if (routingStepEntry?.model !== undefined) {
    model = routingStepEntry.model;
    modelSource = 'provider_routing.steps';
    modelProvider = routingStepEntry.provider;
  } else if (routingTagEntry?.model !== undefined) {
    model = routingTagEntry.model;
    modelSource = 'provider_routing.tags';
    modelProvider = routingTagEntry.modelProvider;
  } else if (routingPersonaEntry?.model !== undefined) {
    model = routingPersonaEntry.model;
    modelSource = 'provider_routing.personas';
    modelProvider = routingPersonaEntry.provider;
  } else if (personaEntry?.model !== undefined) {
    model = personaEntry.model;
    modelSource = 'persona_providers';
    modelProvider = personaEntry.provider;
  } else if ((!autoRoutingApplies || provider !== undefined) && lowerModel !== undefined) {
    model = lowerModel.value;
    modelSource = lowerModel.source;
    modelProvider = input.modelProvider;
  }

  if (modelSource === undefined) {
    modelSource = absentExplicitModelSource;
  }

  if (model !== undefined && modelProvider !== undefined && provider !== undefined && modelProvider !== provider) {
    model = undefined;
    modelSource = 'default';
    modelProvider = undefined;
  }

  const permissionMode = resolveValueForProviderSource(providerSource, {
    'provider_routing.steps': routingStepEntry?.permissionMode,
    'provider_routing.tags': routingTagEntry?.permissionMode,
    'provider_routing.personas': routingPersonaEntry?.permissionMode,
    persona_providers: personaEntry?.permissionMode,
    'runtime-v1': input.permissionMode,
  });

  return {
    provider,
    model,
    providerSource,
    modelSource,
    ...(provider === undefined && modelProvider !== undefined ? { modelProvider } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

function resolveValueForProviderSource<T>(
  providerSource: ProviderResolutionSource | undefined,
  bySource: Partial<Record<ProviderResolutionSource, T | undefined>>,
): T | undefined {
  return providerSource === undefined ? undefined : bySource[providerSource];
}

export function resolveWorkflowCallProviderModel(
  input: WorkflowCallProviderModelInput,
): WorkflowCallProviderModelOutput {
  return {
    provider: input.provider,
    providerSource: input.providerSource,
    model: input.model,
    modelSource: input.modelSource,
    ...(input.modelProvider !== undefined ? { modelProvider: input.modelProvider } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
  };
}

export function resolveLoopMonitorJudgeProviderModel(
  input: LoopMonitorJudgeProviderModelInput,
): LoopMonitorJudgeProviderModelOutput {
  const judgeInfo = input.judgeProviderInfo;
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
  const modelProvider = modelIsExplicit
    ? judgeInfo.modelProvider
    : (providerIsExplicit ? undefined : input.triggeringProviderInfo.modelProvider);

  return {
    provider: providerIsExplicit ? judgeInfo.provider : input.triggeringProviderInfo.provider,
    providerSource: providerIsExplicit
      ? judgeInfo.providerSource
      : input.triggeringProviderInfo.providerSource,
    model: modelIsExplicit
      ? judgeInfo.model
      : (providerIsExplicit ? undefined : input.triggeringProviderInfo.model),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    modelSource: modelIsExplicit
      ? judgeInfo.modelSource
      : (providerIsExplicit
        ? judgeInfo.modelSource === 'default'
          ? judgeInfo.modelSource
          : judgeInfo.providerSource
        : input.triggeringProviderInfo.modelSource),
    ...(providerIsExplicit
      ? judgeInfo.permissionMode === undefined ? {} : { permissionMode: judgeInfo.permissionMode }
      : input.triggeringProviderInfo.permissionMode === undefined
        ? {}
        : { permissionMode: input.triggeringProviderInfo.permissionMode }),
    ...(providerIsExplicit
      ? judgeInfo.providerOptions === undefined ? {} : { providerOptions: judgeInfo.providerOptions }
      : input.triggeringProviderInfo.providerOptions === undefined
        ? {}
        : { providerOptions: input.triggeringProviderInfo.providerOptions }),
  };
}
