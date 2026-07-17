import type { AutoRoutingCandidate, AutoRoutingConfig, AutoRoutingStrategy } from '../../models/config-types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderResolutionSource } from '../provider-options-trace.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';

export interface AutoRoutingStepMetadata {
  name: string;
  tags?: string[];
  personaKey?: string;
  instruction?: string;
}

export interface AutoRoutingLogger {
  warn: (message: string) => void;
}

export type AutoRouteWithAi = (
  autoRouting: AutoRoutingConfig,
  step: AutoRoutingStepMetadata,
) => Promise<AutoRoutingCandidate | undefined>;

export type AutoRouteBatchWithAi = (
  autoRouting: AutoRoutingConfig,
  steps: Array<AutoRoutingStepMetadata & { id: string }>,
) => Promise<Map<string, AutoRoutingCandidate | undefined>>;

type CurrentProviderInfo = Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource' | 'modelSource'>;

export interface ResolveAutoRoutingRuntimeInput {
  autoRouting: AutoRoutingConfig;
  step: AutoRoutingStepMetadata;
  currentProviderInfo: CurrentProviderInfo;
  routeWithAi?: AutoRouteWithAi;
  logger?: AutoRoutingLogger;
  abortSignal?: AbortSignal;
}

export interface ResolveAutoRoutingBatchItem {
  id: string;
  step: AutoRoutingStepMetadata;
  currentProviderInfo: CurrentProviderInfo;
}

export interface ResolveAutoRoutingBatchInput {
  autoRouting: AutoRoutingConfig;
  items: ResolveAutoRoutingBatchItem[];
  routeWithAi?: AutoRouteWithAi;
  routeBatchWithAi?: AutoRouteBatchWithAi;
  logger?: AutoRoutingLogger;
  abortSignal?: AbortSignal;
}

const STRATEGY_COST_TIER: Record<AutoRoutingStrategy, AutoRoutingCandidate['costTier']> = {
  cost: 'low',
  balanced: 'medium',
  performance: 'high',
};

const AI_ROUTER_FAILURE_WARNING = 'Auto routing AI router failed; falling back to strategy default';
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

export function validateAutoRoutingStrategyDefaultCandidate(autoRouting: AutoRoutingConfig): void {
  const requiredTier = STRATEGY_COST_TIER[autoRouting.strategy];
  if (autoRouting.candidates.some((item) => item.costTier === requiredTier)) {
    return;
  }
  throw new Error(
    `Auto routing strategy "${autoRouting.strategy}" requires a ${requiredTier} cost_tier candidate`,
  );
}

export function applyAutoRoutingStrategyOverride(
  autoRouting: AutoRoutingConfig | undefined,
  strategy: AutoRoutingStrategy | undefined,
): AutoRoutingConfig | undefined {
  if (autoRouting === undefined || strategy === undefined) {
    return autoRouting;
  }
  const resolved = {
    ...autoRouting,
    strategy,
  };
  validateAutoRoutingStrategyDefaultCandidate(resolved);
  return resolved;
}

function findCandidate(autoRouting: AutoRoutingConfig, name: string | undefined): AutoRoutingCandidate | undefined {
  if (name === undefined) {
    return undefined;
  }
  return autoRouting.candidates.find((candidate) => candidate.name === name);
}

function validateBatchAiSelections(
  aiCandidates: Map<string, AutoRoutingCandidate | undefined>,
  aiItems: ResolveAutoRoutingBatchItem[],
): void {
  const missingIds = aiItems
    .map((item) => item.id)
    .filter((id) => !aiCandidates.has(id));

  if (missingIds.length > 0) {
    throw new Error(`Auto routing AI response is missing selection for batch item(s): ${missingIds.join(', ')}`);
  }

  const undefinedSelectionIds = aiItems
    .map((item) => item.id)
    .filter((id) => aiCandidates.get(id) === undefined);

  if (undefinedSelectionIds.length > 0) {
    throw new Error(
      `Auto routing AI response has undefined selection for batch item(s): ${undefinedSelectionIds.join(', ')}`,
    );
  }
}

function collectProviderOptionsSources(
  providerOptions: StepProviderOptions | undefined,
  source: ProviderResolutionSource,
): Record<string, ProviderResolutionSource> | undefined {
  if (providerOptions === undefined) {
    return undefined;
  }

  const result: Record<string, ProviderResolutionSource> = {};
  for (const [providerKey, providerValue] of Object.entries(providerOptions)) {
    if (providerValue === undefined || typeof providerValue !== 'object') {
      continue;
    }
    for (const optionKey of Object.keys(providerValue)) {
      result[`${providerKey}.${optionKey}`] = source;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAutoRoutingResolvedProviderModel(
  provider: AutoRoutingCandidate['provider'],
  model: string | undefined,
): void {
  validateProviderModelRequirements(provider, model, {
    modelFieldName: 'Configuration error: auto_routing resolved model',
  });

  if (!model) {
    return;
  }
  if ((provider === 'codex' || provider === 'opencode') && CLAUDE_MODEL_ALIASES.has(model)) {
    throw new Error(
      `Configuration error: auto_routing resolved model '${model}' is a Claude model alias but provider is '${provider}'. ` +
      `Either choose a Claude provider or specify a ${provider}-compatible model.`,
    );
  }
}

export function resolveAutoRoutingCandidateProviderInfo(
  candidate: AutoRoutingCandidate,
  source: ProviderResolutionSource,
  autoRouting: AutoRoutingConfig,
  currentProviderInfo: CurrentProviderInfo,
): StepProviderInfo {
  const modelResolvedByAuto = currentProviderInfo.modelSource === undefined;
  const resolvedModel = modelResolvedByAuto ? candidate.model : currentProviderInfo.model;
  const resolvedModelSource = currentProviderInfo.modelSource ?? source;
  validateAutoRoutingResolvedProviderModel(candidate.provider, resolvedModel);
  return {
    provider: candidate.provider,
    model: resolvedModel,
    providerSource: source,
    modelSource: resolvedModelSource,
    ...(candidate.providerOptions !== undefined ? { providerOptions: candidate.providerOptions } : {}),
    ...(candidate.providerOptions !== undefined
      ? { providerOptionsSources: collectProviderOptionsSources(candidate.providerOptions, source) }
      : {}),
    autoRoutingDecision: {
      candidateName: candidate.name,
      costTier: candidate.costTier,
      strategy: autoRouting.strategy,
      candidateCount: autoRouting.candidates.length,
    },
  };
}

export function matchAutoRoutingRules(
  autoRouting: AutoRoutingConfig,
  step: AutoRoutingStepMetadata,
): AutoRoutingCandidate | undefined {
  let tagCandidate: AutoRoutingCandidate | undefined;
  for (const tag of step.tags ?? []) {
    tagCandidate = findCandidate(autoRouting, autoRouting.rules?.tags?.[tag]) ?? tagCandidate;
  }
  if (tagCandidate !== undefined) {
    return tagCandidate;
  }

  const stepCandidate = findCandidate(autoRouting, autoRouting.rules?.steps?.[step.name]);
  if (stepCandidate !== undefined) {
    return stepCandidate;
  }

  return findCandidate(autoRouting, autoRouting.rules?.personas?.[step.personaKey ?? '']);
}

export function selectStrategyDefaultCandidate(autoRouting: AutoRoutingConfig): AutoRoutingCandidate {
  validateAutoRoutingStrategyDefaultCandidate(autoRouting);
  const requiredTier = STRATEGY_COST_TIER[autoRouting.strategy];
  const candidate = autoRouting.candidates.find((item) => item.costTier === requiredTier);
  if (candidate === undefined) {
    throw new Error(`Auto routing strategy "${autoRouting.strategy}" requires a ${requiredTier} cost_tier candidate`);
  }
  return candidate;
}

export function resolveRuleBasedAutoRoutingProviderInfo(
  input: Pick<ResolveAutoRoutingRuntimeInput, 'autoRouting' | 'step' | 'currentProviderInfo'>,
): StepProviderInfo | undefined {
  if (input.currentProviderInfo.provider !== undefined) {
    return undefined;
  }
  const candidate = matchAutoRoutingRules(input.autoRouting, input.step);
  return candidate === undefined
    ? undefined
    : resolveAutoRoutingCandidateProviderInfo(candidate, 'auto.rules', input.autoRouting, input.currentProviderInfo);
}

export async function resolveAutoRoutingRuntime(
  input: ResolveAutoRoutingRuntimeInput,
): Promise<RuntimeStepResolution | undefined> {
  input.abortSignal?.throwIfAborted();
  if (input.currentProviderInfo.provider !== undefined) {
    return undefined;
  }

  const ruleProviderInfo = resolveRuleBasedAutoRoutingProviderInfo(input);
  if (ruleProviderInfo !== undefined) {
    return { providerInfo: ruleProviderInfo };
  }

  let aiCandidate: AutoRoutingCandidate | undefined;
  if (input.routeWithAi !== undefined) {
    try {
      aiCandidate = await input.routeWithAi(input.autoRouting, input.step);
      input.abortSignal?.throwIfAborted();
      if (aiCandidate === undefined) {
        input.logger?.warn(AI_ROUTER_FAILURE_WARNING);
      }
    } catch {
      input.abortSignal?.throwIfAborted();
      input.logger?.warn(AI_ROUTER_FAILURE_WARNING);
    }
  }
  if (aiCandidate !== undefined) {
    return {
      providerInfo: resolveAutoRoutingCandidateProviderInfo(
        aiCandidate,
        'auto.ai',
        input.autoRouting,
        input.currentProviderInfo,
      ),
    };
  }

  input.abortSignal?.throwIfAborted();
  const defaultCandidate = selectStrategyDefaultCandidate(input.autoRouting);
  return {
    providerInfo: resolveAutoRoutingCandidateProviderInfo(
      defaultCandidate,
      'auto.default',
      input.autoRouting,
      input.currentProviderInfo,
    ),
  };
}

export async function resolveAutoRoutingBatch(
  input: ResolveAutoRoutingBatchInput,
): Promise<Map<string, StepProviderInfo>> {
  input.abortSignal?.throwIfAborted();
  const result = new Map<string, StepProviderInfo>();
  const aiItems: ResolveAutoRoutingBatchItem[] = [];

  for (const item of input.items) {
    if (item.currentProviderInfo.provider !== undefined) {
      continue;
    }

    const ruleCandidate = matchAutoRoutingRules(input.autoRouting, item.step);
    if (ruleCandidate !== undefined) {
      result.set(
        item.id,
        resolveAutoRoutingCandidateProviderInfo(
          ruleCandidate,
          'auto.rules',
          input.autoRouting,
          item.currentProviderInfo,
        ),
      );
      continue;
    }
    aiItems.push(item);
  }

  if (aiItems.length === 0) {
    return result;
  }

  if (input.routeBatchWithAi !== undefined) {
    let aiCandidates: Map<string, AutoRoutingCandidate | undefined> | undefined;
    try {
      const batchAiCandidates = await input.routeBatchWithAi(
        input.autoRouting,
        aiItems.map((item) => ({ id: item.id, ...item.step })),
      );
      input.abortSignal?.throwIfAborted();
      validateBatchAiSelections(batchAiCandidates, aiItems);
      aiCandidates = batchAiCandidates;
    } catch {
      input.abortSignal?.throwIfAborted();
      input.logger?.warn(AI_ROUTER_FAILURE_WARNING);
    }
    if (aiCandidates !== undefined) {
      for (const item of aiItems) {
        const aiCandidate = aiCandidates.get(item.id);
        if (aiCandidate !== undefined) {
          result.set(
            item.id,
            resolveAutoRoutingCandidateProviderInfo(
              aiCandidate,
              'auto.ai',
              input.autoRouting,
              item.currentProviderInfo,
            ),
          );
        }
      }
    }
  } else {
    const routedItems = await Promise.all(aiItems.map(async (item) => {
      let aiCandidate: AutoRoutingCandidate | undefined;
      if (input.routeWithAi !== undefined) {
        try {
          aiCandidate = await input.routeWithAi(input.autoRouting, item.step);
          input.abortSignal?.throwIfAborted();
          if (aiCandidate === undefined) {
            input.logger?.warn(AI_ROUTER_FAILURE_WARNING);
          }
        } catch {
          input.abortSignal?.throwIfAborted();
          input.logger?.warn(AI_ROUTER_FAILURE_WARNING);
        }
      }
      return { item, aiCandidate };
    }));

    for (const { item, aiCandidate } of routedItems) {
      if (aiCandidate !== undefined) {
        result.set(
          item.id,
          resolveAutoRoutingCandidateProviderInfo(
            aiCandidate,
            'auto.ai',
            input.autoRouting,
            item.currentProviderInfo,
          ),
        );
      }
    }
  }

  for (const item of aiItems) {
    input.abortSignal?.throwIfAborted();
    if (result.has(item.id)) {
      continue;
    }
    const defaultCandidate = selectStrategyDefaultCandidate(input.autoRouting);
    result.set(
      item.id,
      resolveAutoRoutingCandidateProviderInfo(
        defaultCandidate,
        'auto.default',
        input.autoRouting,
        item.currentProviderInfo,
      ),
    );
  }

  return result;
}
