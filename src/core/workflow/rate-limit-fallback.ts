import type { AgentResponse, FallbackContext, RateLimitFallbackProvider, WorkflowStep } from '../models/types.js';
import type { StepProviderInfo } from './types.js';

function sameFallbackProvider(
  candidate: RateLimitFallbackProvider,
  current: { provider?: StepProviderInfo['provider']; model?: StepProviderInfo['model'] },
): boolean {
  if (candidate.provider !== current.provider) {
    return false;
  }
  return candidate.model === undefined || candidate.model === current.model;
}

function toFallbackProvider(providerInfo: StepProviderInfo): RateLimitFallbackProvider {
  if (!providerInfo.provider) {
    throw new Error('Resolved provider is required for rate limit fallback');
  }
  return {
    provider: providerInfo.provider,
    ...(providerInfo.model !== undefined ? { model: providerInfo.model } : {}),
  };
}

export function appendFallbackAttempt(
  attempted: readonly RateLimitFallbackProvider[],
  providerInfo: StepProviderInfo,
): RateLimitFallbackProvider[] {
  const current = toFallbackProvider(providerInfo);
  return attempted.some((tried) => sameFallbackProvider(current, tried))
    ? [...attempted]
    : [...attempted, current];
}

export function pickNextFallbackProvider(
  switchChain: readonly RateLimitFallbackProvider[] | undefined,
  current: StepProviderInfo,
  attempted: readonly RateLimitFallbackProvider[],
): RateLimitFallbackProvider | undefined {
  return switchChain?.find((candidate) => (
    !sameFallbackProvider(candidate, current)
    && !attempted.some((tried) => sameFallbackProvider(candidate, tried))
  ));
}

export function buildRateLimitFallbackContext(options: {
  readonly step: WorkflowStep;
  readonly response: AgentResponse;
  readonly current: StepProviderInfo;
  readonly fallback: RateLimitFallbackProvider;
  readonly originalIteration: number;
  readonly reportDir: string;
}): FallbackContext {
  if (!options.current.provider) {
    throw new Error(`Step "${options.step.name}" has no resolved provider for rate limit fallback`);
  }
  return {
    reason: 'rate_limited',
    reasonDetail: options.response.error ?? 'Rate limit exceeded',
    originalIteration: options.originalIteration,
    previousProvider: options.current.provider,
    ...(options.current.model !== undefined ? { previousModel: options.current.model } : {}),
    currentProvider: options.fallback.provider,
    ...(options.fallback.model !== undefined ? { currentModel: options.fallback.model } : {}),
    stepName: options.step.name,
    reportDir: options.reportDir,
  };
}
