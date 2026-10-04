/**
 * CLI/env provider override re-application for the runtime-v1 environment (issue #1136).
 *
 * order.md treats an explicit `--provider`/`--model` (or the matching env vars) as a runtime
 * override in *both* configuration modes. The compiled runtime-v1 bundle only carries the
 * runtime.yaml `profiles.default`, so the main execution path must re-apply the CLI/env override
 * on top of it the same way the selector seam already does (`resolveSelectorFromRuntimeV1`):
 * overriding the provider drops the runtime-tied model/options, while a model-only override keeps
 * the runtime provider. This is the single shared rule the compiled-environment seam applies.
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
 * The single provider/model/options composition rule shared by every runtime-v1 override seam.
 * Overriding the provider drops the runtime-tied model and options; a model-only override keeps the
 * runtime provider and its options; when neither is overridden the runtime values pass through
 * verbatim. Source tagging, model normalization, validation, and return shaping stay per-seam.
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
 * runtime bundle untouched, so an unmodified runtime.yaml environment is returned verbatim.
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
  const modelSource = modelOverride !== undefined
    ? override.modelSource
    : providerOverride !== undefined
      ? override.providerSource
      : runtime.modelSource;

  return {
    ...runtime,
    provider: composed.provider,
    providerSource,
    model: composed.model,
    modelSource,
    providerOptions: composed.providerOptions,
    permissionMode: composed.permissionMode,
  };
}
