import type {
  FallbackContext,
  FallbackOperationOrigin,
} from '../../models/types.js';
import type {
  RuntimeStepResolution,
  StepProviderInfo,
} from '../types.js';

export function reviewerOperationOrigin(
  reviewerStepName: string,
): FallbackOperationOrigin {
  return Object.freeze({
    stage: 'reviewer',
    reviewerStepName,
  });
}

export function sameFallbackOperationOrigin(
  left: FallbackOperationOrigin,
  right: FallbackOperationOrigin,
): boolean {
  return left.stage === right.stage
    && left.reviewerStepName === right.reviewerStepName;
}

export function fallbackTargetsOperation(
  fallback: FallbackContext | undefined,
  origin: FallbackOperationOrigin,
): fallback is FallbackContext {
  return fallback !== undefined
    && sameFallbackOperationOrigin(fallback.origin, origin);
}

function fallbackProviderInfo(fallback: FallbackContext): StepProviderInfo {
  return {
    provider: fallback.currentProvider,
    model: fallback.currentModel,
    providerSource: 'step',
    modelSource: fallback.currentModel !== undefined ? 'step' : undefined,
  };
}

export function runtimeForOperation(
  runtime: RuntimeStepResolution | undefined,
  origin: FallbackOperationOrigin,
  baseProviderInfo?: StepProviderInfo,
): RuntimeStepResolution | undefined {
  if (!fallbackTargetsOperation(runtime?.fallback, origin)) {
    const operationRuntime = runtime?.fallback === undefined
      ? runtime
      : {
          ...runtime,
          fallback: undefined,
        };
    return baseProviderInfo === undefined
      ? operationRuntime
      : { ...operationRuntime, providerInfo: baseProviderInfo };
  }
  const resolvedFallbackProviderInfo = fallbackProviderInfo(runtime.fallback);
  const optionSource = [baseProviderInfo, runtime.providerInfo].find(
    (providerInfo) =>
      providerInfo?.provider === resolvedFallbackProviderInfo.provider
      && providerInfo?.model === resolvedFallbackProviderInfo.model,
  );
  return {
    ...runtime,
    providerInfo: {
      ...resolvedFallbackProviderInfo,
      ...(optionSource?.providerOptions !== undefined
        ? { providerOptions: optionSource.providerOptions }
        : {}),
    },
  };
}

export function fallbackContextForOperation(
  runtime: RuntimeStepResolution | undefined,
  origin: FallbackOperationOrigin,
): FallbackContext | undefined {
  return fallbackTargetsOperation(runtime?.fallback, origin)
    ? runtime.fallback
    : undefined;
}
