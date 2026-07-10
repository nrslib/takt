import type { LoopMonitorJudge, WorkflowConfig, WorkflowStep } from '../models/types.js';
import type { PersonaProviderEntry, ProviderRoutingConfig, ProviderRoutingEntry, ProviderTypeOrAuto } from '../models/config-types.js';
import {
  resolveProviderModelCandidates,
  resolveModelFromCandidates,
} from '../provider-resolution.js';
import type { ProviderType } from './types.js';
import type { ProviderResolutionSource } from './provider-options-trace.js';

export interface ProviderModelResolutionContext {
  provider?: ProviderTypeOrAuto;
  model?: string;
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
  provider?: ProviderTypeOrAuto;
  model?: string;
}

export interface WorkflowCallProviderModelOutput {
  provider: ProviderTypeOrAuto | undefined;
  model: string | undefined;
}

export interface LoopMonitorJudgeProviderModelInput {
  judge: Pick<LoopMonitorJudge, 'provider' | 'model' | 'modelSpecified'>;
  /**
   * judge ステップ自身の通常解決結果（provider_routing.* / persona_providers.loop-judge を含む）。
   * 省略時は judge.provider / judge.model の直接指定のみを見る（呼び出し側の互換パス）。
   */
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
  cliProvider?: ProviderTypeOrAuto;
  cliModel?: string;
  personaProviders?: Record<string, PersonaProviderEntry>;
  personaDisplayName?: string;
  localProvider?: ProviderTypeOrAuto;
  localModel?: string;
  globalProvider?: ProviderTypeOrAuto;
  globalModel?: string;
}

export interface AgentProviderModelOutput {
  provider?: ProviderType;
  model?: string;
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

function isAutoProvider(provider: ProviderTypeOrAuto | undefined): provider is 'auto' {
  return provider === 'auto';
}

export function toConcreteProvider(provider: ProviderTypeOrAuto | undefined): ProviderType | undefined {
  return isAutoProvider(provider) ? undefined : provider;
}

export function resolveAgentProviderModel(input: AgentProviderModelInput): AgentProviderModelOutput {
  const personaEntry = input.personaProviders?.[input.personaDisplayName ?? ''];
  const provider = resolveProviderModelCandidates([
    { provider: toConcreteProvider(input.cliProvider) },
    { provider: personaEntry?.provider },
    { provider: toConcreteProvider(input.localProvider) },
    { provider: toConcreteProvider(input.globalProvider) },
  ]).provider;
  const model = resolveModelFromCandidates([
    { model: input.cliModel },
    { model: personaEntry?.model },
    { model: input.localModel, provider: toConcreteProvider(input.localProvider) },
    { model: input.globalModel, provider: toConcreteProvider(input.globalProvider) },
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
  const stepProviderIsAuto = isAutoProvider(input.step.provider) && input.step.providerSpecified !== false;
  const stepProviderIsDirect = input.step.provider !== undefined
    && !stepProviderIsAuto
    && input.step.providerSpecified !== false;
  const stepModelIsDirect = input.step.modelSpecified === true
    || (input.step.model !== undefined && input.step.modelSpecified !== false);
  const workflowProvider = input.step.providerSpecified === false && !isAutoProvider(input.step.provider)
    ? input.step.provider
    : undefined;
  const workflowModel = input.step.modelSpecified === false ? input.step.model : undefined;

  let provider: ProviderType | undefined;
  let providerSource: ProviderResolutionSource | undefined;
  if (stepProviderIsAuto) {
    provider = undefined;
    providerSource = undefined;
  } else if (stepProviderIsDirect) {
    provider = toConcreteProvider(input.step.provider);
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
  } else if (input.provider !== undefined && !isAutoProvider(input.provider)) {
    provider = toConcreteProvider(input.provider);
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
  const provider = input.workflow.provider ?? input.provider;
  const model = resolveProviderModelCandidates([
    { model: input.workflow.model },
    { model: input.model },
  ]).model;
  return { provider, model };
}

/**
 * judge の provider/model が「明示指定された」とみなせる解決経路。
 * ここに無い経路（'workflow' 既定・engine/CLI/config 由来のフォールバックなど）は
 * 「指定なし」として扱い、トリガー元へフォールバックする対象になる。
 */
const EXPLICIT_JUDGE_PROVIDER_SOURCES: ReadonlySet<ProviderResolutionSource> = new Set([
  'step',
  'provider_routing.steps',
  'provider_routing.tags',
  'provider_routing.personas',
  'persona_providers',
]);

function isExplicitJudgeSource(source: ProviderResolutionSource | undefined): boolean {
  return source !== undefined && EXPLICIT_JUDGE_PROVIDER_SOURCES.has(source);
}

export function resolveLoopMonitorJudgeProviderModel(
  input: LoopMonitorJudgeProviderModelInput,
): LoopMonitorJudgeProviderModelOutput {
  // judgeProviderInfo が渡されない呼び出し（既存の単体テストなど）は、judge.provider /
  // judge.model の直接指定だけを見る従来どおりの経路にフォールバックする。
  const judgeInfo: StepProviderModelOutput = input.judgeProviderInfo ?? {
    provider: input.judge.provider,
    model: input.judge.model,
    providerSource: input.judge.provider !== undefined ? 'step' : undefined,
    modelSource: (input.judge.modelSpecified === true
      || (input.judge.model !== undefined && input.judge.modelSpecified !== false))
      ? 'step'
      : undefined,
  };

  // judge 側に provider_routing.* / persona_providers.loop-judge を含む明示指定が
  // 何も無い場合だけ、トリガー元（ループを踏んだステップ）の解決済み provider を引き継ぐ。
  // これを既定にすると「実装した本人が自分のループの健全性を判定する」ことになり監視が
  // 機能しない（実測: coder の qwen3-coder-next が 4 回とも「健全」と判定し 56 周・9 時間走った）。
  const providerIsExplicit = isExplicitJudgeSource(judgeInfo.providerSource);
  const provider = providerIsExplicit ? judgeInfo.provider : input.triggeringProviderInfo.provider;
  const providerSource = providerIsExplicit ? judgeInfo.providerSource : input.triggeringProviderInfo.providerSource;

  // provider だけ明示されて model が明示されていない場合、トリガー元の model は引き継がない。
  // provider=codex なのに model=opencode/... のような破綻した組み合わせを避けるため。
  const modelIsExplicit = isExplicitJudgeSource(judgeInfo.modelSource);
  const model = modelIsExplicit
    ? judgeInfo.model
    : (providerIsExplicit ? undefined : input.triggeringProviderInfo.model);
  const modelSource = modelIsExplicit
    ? judgeInfo.modelSource
    : (providerIsExplicit ? judgeInfo.providerSource : input.triggeringProviderInfo.modelSource);

  return {
    provider,
    ...(providerSource !== undefined ? { providerSource } : {}),
    model,
    ...(modelSource !== undefined ? { modelSource } : {}),
  };
}
