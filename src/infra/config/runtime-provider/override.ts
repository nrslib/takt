/**
 * Runtime provider override composition helpers (issue #1136).
 *
 * `composeRuntimeProviderOverride` keeps the non-step runtime seams' existing behavior. The step
 * execution seam also removes provider-bound options when a provider is overridden, but preserves
 * the runtime model candidate and its owner so step resolution can compare them with the selected
 * provider.
 */

import type { ProviderType } from '../../../shared/types/provider.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import type { PermissionMode } from '../../../core/models/types.js';
import type { CompiledProviderEnvironment } from './environment.js';

/** Provider/model resolved by the bootstrap, tagged with the layer that supplied each value. */
export interface RuntimeProviderOverride {
  provider: ProviderType | undefined;
  providerSource: ProviderResolutionSource;
  model: string | undefined;
  modelSource: ProviderResolutionSource;
}

/** Runtime-tied provider/model/options a CLI/env override is layered on top of. */
export interface RuntimeProviderValues {
  provider: ProviderType | undefined;
  model: string | undefined;
  providerOptions: StepProviderOptions | undefined;
  permissionMode?: PermissionMode;
}

/**
 * Generic runtime override composition used by selector and non-workflow seams. A provider override
 * drops the runtime-tied model and options; a model-only override keeps the runtime provider and
 * its options. The step environment uses this helper for provider-bound settings and preserves its
 * model candidate separately for step resolution.
 */
export function composeRuntimeProviderOverride(
  runtime: RuntimeProviderValues,
  override: { provider: ProviderType | undefined; model: string | undefined },
): RuntimeProviderValues {
  const providerOverridden = override.provider !== undefined;
  const provider = override.provider ?? runtime.provider;
  const providerOptions = providerOverridden ? undefined : runtime.providerOptions;
  const permissionMode = providerOverridden ? undefined : runtime.permissionMode;
  const model = override.model !== undefined
    ? override.model
    : providerOverridden
      ? undefined
      : runtime.model;
  return { provider, model, providerOptions, permissionMode };
}

/** Only CLI flags and environment variables are explicit runtime overrides. */
function isRuntimeOverrideSource(source: ProviderResolutionSource): boolean {
  return source === 'cli' || source === 'env';
}

/**
 * Re-apply a CLI/env provider/model override on top of a compiled runtime-v1 environment. Values
 * whose source is not `cli`/`env` (e.g. the schema `default`) are not overrides and leave the
 * runtime bundle untouched. A provider-only override preserves the model candidate and owner for
 * the step resolver, which decides whether the model belongs to the selected provider.
 */
export function applyRuntimeProviderOverride(
  runtime: CompiledProviderEnvironment,
  override: RuntimeProviderOverride,
): CompiledProviderEnvironment {
  const providerOverride = isRuntimeOverrideSource(override.providerSource)
    ? override.provider
    : undefined;
  const modelOverride = isRuntimeOverrideSource(override.modelSource)
    ? override.model
    : undefined;
  if (providerOverride === undefined && modelOverride === undefined) {
    return runtime;
  }

  const composed = composeRuntimeProviderOverride(runtime, {
    provider: providerOverride,
    model: modelOverride,
  });
  const providerSource = providerOverride !== undefined
    ? override.providerSource
    : runtime.providerSource;
  const modelSource = modelOverride !== undefined ? override.modelSource : runtime.modelSource;
  const modelProvider = modelOverride === undefined ? runtime.modelProvider : undefined;

  const result: CompiledProviderEnvironment = {
    ...runtime,
    provider: composed.provider,
    providerSource,
    model: modelOverride ?? runtime.model,
    modelSource,
    providerOptions: composed.providerOptions,
    permissionMode: composed.permissionMode,
  };
  if (modelProvider === undefined) {
    delete result.modelProvider;
  } else {
    result.modelProvider = modelProvider;
  }
  return result;
}
