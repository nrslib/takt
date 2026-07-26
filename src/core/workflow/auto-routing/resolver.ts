import type { AutoRoutingCandidate, AutoRoutingConfig, AutoRoutingStrategy } from '../../models/config-types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';
import type { ProviderResolutionSource } from '../provider-options-trace.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import type { RoutingWorkSnapshot, WorkRequirementEstimator } from './contracts.js';
import { normalizeRoutingWorkSnapshot } from './normalizer.js';
import { selectRoutingCandidate } from './selector.js';
import type { RoutingRuntime } from './runtime.js';

export interface AutoRoutingStepMetadata {
  name: string;
  tags?: string[];
  personaKey?: string;
  instruction?: string;
}

export function toAutoRoutingStepMetadata(step: {
  name: string;
  tags?: string[];
  providerRoutingPersonaKey?: string;
  instruction?: string;
}): AutoRoutingStepMetadata {
  return { name: step.name, tags: step.tags, personaKey: step.providerRoutingPersonaKey, instruction: step.instruction };
}

export interface AutoRoutingLogger { warn: (message: string) => void; }
type CurrentProviderInfo = Pick<StepProviderInfo, 'provider' | 'model' | 'providerSource' | 'modelSource'>;

export interface ResolveAutoRoutingRuntimeInput {
  autoRouting: AutoRoutingConfig;
  scope?: string;
  step: AutoRoutingStepMetadata;
  snapshot: RoutingWorkSnapshot;
  currentProviderInfo: CurrentProviderInfo;
  estimator?: WorkRequirementEstimator;
  runtime?: RoutingRuntime;
  logger?: AutoRoutingLogger;
  abortSignal?: AbortSignal;
}

export interface ResolveAutoRoutingBatchItem {
  id: string;
  scope?: string;
  step: AutoRoutingStepMetadata;
  snapshot: RoutingWorkSnapshot;
  currentProviderInfo: CurrentProviderInfo;
}

export interface ResolveAutoRoutingBatchInput {
  autoRouting: AutoRoutingConfig;
  items: ResolveAutoRoutingBatchItem[];
  estimator?: WorkRequirementEstimator;
  runtime?: RoutingRuntime;
  logger?: AutoRoutingLogger;
  abortSignal?: AbortSignal;
}

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

export function createRoutingScope(input: { workflow: string; parentStep: string; workItem: string }): string {
  return JSON.stringify([input.workflow, input.parentStep, input.workItem]);
}

function resolveRoutingScope(input: Pick<ResolveAutoRoutingRuntimeInput, 'scope' | 'step'>): string {
  return input.scope ?? createRoutingScope({
    workflow: 'unscoped',
    parentStep: input.step.name,
    workItem: input.step.name,
  });
}

function findCandidate(autoRouting: AutoRoutingConfig, name: string | undefined): AutoRoutingCandidate | undefined {
  return name === undefined ? undefined : autoRouting.candidates.find((candidate) => candidate.name === name);
}

function findMappingValue(mapping: Record<string, string> | undefined, key: string | undefined): string | undefined {
  return key !== undefined && mapping !== undefined && Object.hasOwn(mapping, key) ? mapping[key] : undefined;
}

export function applyAutoRoutingStrategyOverride(autoRouting: AutoRoutingConfig | undefined, strategy: AutoRoutingStrategy | undefined): AutoRoutingConfig | undefined {
  return autoRouting === undefined || strategy === undefined ? autoRouting : { ...autoRouting, strategy };
}

function collectProviderOptionsSources(providerOptions: StepProviderOptions | undefined, source: ProviderResolutionSource): Record<string, ProviderResolutionSource> | undefined {
  if (providerOptions === undefined) return undefined;
  const result: Record<string, ProviderResolutionSource> = {};
  for (const [providerKey, providerValue] of Object.entries(providerOptions)) {
    if (providerValue === undefined || typeof providerValue !== 'object') continue;
    for (const optionKey of Object.keys(providerValue)) result[`${providerKey}.${optionKey}`] = source;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function validateAutoRoutingResolvedProviderModel(provider: AutoRoutingCandidate['provider'], model: string | undefined): void {
  validateProviderModelRequirements(provider, model, { modelFieldName: 'Configuration error: auto_routing resolved model' });
  if (model && (provider === 'codex' || provider === 'opencode') && CLAUDE_MODEL_ALIASES.has(model)) {
    throw new Error(`Configuration error: auto_routing resolved model '${model}' is a Claude model alias but provider is '${provider}'.`);
  }
}

export function resolveAutoRoutingCandidateProviderInfo(candidate: AutoRoutingCandidate, source: ProviderResolutionSource, autoRouting: AutoRoutingConfig, currentProviderInfo: CurrentProviderInfo, decision?: {
  requiredTier?: 'low' | 'medium' | 'high';
  reasonCodes?: string[];
  fallbackReason?: string;
  fingerprintChanged?: boolean;
  retryReason?: 'failed-without-progress' | 'no-progress';
  estimatorDurationMs?: number;
  inputTokenBucket?: 'small' | 'medium' | 'large';
}): StepProviderInfo {
  const modelResolvedByAuto = currentProviderInfo.modelSource === undefined;
  const model = modelResolvedByAuto ? candidate.model : currentProviderInfo.model;
  validateAutoRoutingResolvedProviderModel(candidate.provider, model);
  return {
    provider: candidate.provider,
    model,
    providerSource: source,
    modelSource: currentProviderInfo.modelSource ?? source,
    ...(candidate.providerOptions !== undefined ? { providerOptions: candidate.providerOptions, providerOptionsSources: collectProviderOptionsSources(candidate.providerOptions, source) } : {}),
    autoRoutingDecision: {
      candidateName: candidate.name,
      routingTier: candidate.routingTier,
      requiredTier: decision?.requiredTier ?? candidate.routingTier,
      strategy: autoRouting.strategy,
      candidateCount: autoRouting.candidates.length,
      ...(decision?.reasonCodes !== undefined ? { reasonCodes: decision.reasonCodes } : {}),
      ...(decision?.fallbackReason !== undefined ? { fallbackReason: decision.fallbackReason } : {}),
      ...(decision?.fingerprintChanged !== undefined ? { fingerprintChanged: decision.fingerprintChanged } : {}),
      ...(decision?.retryReason !== undefined ? { retryReason: decision.retryReason } : {}),
      ...(decision?.estimatorDurationMs !== undefined ? { estimatorDurationMs: decision.estimatorDurationMs } : {}),
      ...(decision?.inputTokenBucket !== undefined ? { inputTokenBucket: decision.inputTokenBucket } : {}),
    },
  };
}

export function matchAutoRoutingRules(autoRouting: AutoRoutingConfig, step: AutoRoutingStepMetadata): AutoRoutingCandidate | undefined {
  let matchedCandidate: AutoRoutingCandidate | undefined;
  for (const tag of step.tags ?? []) {
    const candidate = findCandidate(autoRouting, findMappingValue(autoRouting.rules?.tags, tag));
    if (candidate !== undefined) matchedCandidate = candidate;
  }
  return matchedCandidate
    ?? findCandidate(autoRouting, findMappingValue(autoRouting.rules?.steps, step.name))
    ?? findCandidate(autoRouting, findMappingValue(autoRouting.rules?.personas, step.personaKey));
}

export function resolveRuleBasedAutoRoutingProviderInfo(input: Pick<ResolveAutoRoutingRuntimeInput, 'autoRouting' | 'step' | 'currentProviderInfo'>): StepProviderInfo | undefined {
  if (input.currentProviderInfo.provider !== undefined) return undefined;
  const candidate = matchAutoRoutingRules(input.autoRouting, input.step);
  return candidate === undefined ? undefined : resolveAutoRoutingCandidateProviderInfo(candidate, 'auto.rules', input.autoRouting, input.currentProviderInfo);
}

export function resolveDeterministicAutoRoutingProviderInfo(input: Pick<ResolveAutoRoutingRuntimeInput, 'autoRouting' | 'step' | 'currentProviderInfo'>): StepProviderInfo | undefined {
  if (input.currentProviderInfo.provider !== undefined) return undefined;
  const rule = resolveRuleBasedAutoRoutingProviderInfo(input);
  if (rule !== undefined) return rule;
  const selection = selectRoutingCandidate({ autoRouting: input.autoRouting, step: input.step, estimatorFailure: new Error('estimator unavailable') });
  return resolveAutoRoutingCandidateProviderInfo(selection.candidate, selection.resolutionSource, input.autoRouting, input.currentProviderInfo, { fallbackReason: selection.fallbackReason });
}

export async function resolveAutoRoutingRuntime(input: ResolveAutoRoutingRuntimeInput): Promise<RuntimeStepResolution | undefined> {
  input.abortSignal?.throwIfAborted();
  if (input.currentProviderInfo.provider !== undefined) return undefined;
  const hardRule = resolveRuleBasedAutoRoutingProviderInfo(input);
  if (hardRule !== undefined) return { providerInfo: hardRule };
  if (input.estimator === undefined) return { providerInfo: resolveDeterministicAutoRoutingProviderInfo(input)! };
  if (input.runtime !== undefined) {
    const decision = await input.runtime.resolve({
      scope: resolveRoutingScope(input),
      snapshot: input.snapshot,
      abortSignal: input.abortSignal,
    });
    if (decision.fallbackReason !== undefined) {
      input.logger?.warn('Auto routing estimator failed; using configured pool fallback');
    }
    return {
      providerInfo: resolveAutoRoutingCandidateProviderInfo(
        decision.candidate,
        decision.resolutionSource,
        input.autoRouting,
        input.currentProviderInfo,
        {
          requiredTier: decision.requiredTier,
          reasonCodes: decision.reasonCodes,
          fallbackReason: decision.fallbackReason,
          fingerprintChanged: decision.fingerprintChanged,
          retryReason: decision.escalationReason,
          estimatorDurationMs: decision.estimatorDurationMs,
          inputTokenBucket: decision.inputTokenBucket,
        },
      ),
    };
  }
  let estimate;
  try {
    estimate = await input.estimator.estimate(normalizeRoutingWorkSnapshot(input.snapshot), {
      abortSignal: input.abortSignal,
    });
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw input.abortSignal.reason;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    input.logger?.warn('Auto routing estimator failed; using configured pool fallback');
    const selection = selectRoutingCandidate({ autoRouting: input.autoRouting, step: input.step, estimatorFailure: error as Error });
    return { providerInfo: resolveAutoRoutingCandidateProviderInfo(selection.candidate, selection.resolutionSource, input.autoRouting, input.currentProviderInfo, { fallbackReason: selection.fallbackReason }) };
  }
  const selection = selectRoutingCandidate({ autoRouting: input.autoRouting, step: input.step, estimate });
  return { providerInfo: resolveAutoRoutingCandidateProviderInfo(selection.candidate, selection.resolutionSource, input.autoRouting, input.currentProviderInfo, { requiredTier: estimate.requiredTier, reasonCodes: estimate.reasonCodes }) };
}

export async function resolveAutoRoutingBatch(input: ResolveAutoRoutingBatchInput): Promise<Map<string, StepProviderInfo>> {
  const results = await Promise.all(input.items.map(async (item) => ({
    id: item.id,
    resolution: await resolveAutoRoutingRuntime({ ...input, ...item }),
  })));
  const entries: Array<[string, StepProviderInfo]> = [];
  for (const item of results) {
    if (item.resolution?.providerInfo !== undefined) entries.push([item.id, item.resolution.providerInfo]);
  }
  return new Map(entries);
}
