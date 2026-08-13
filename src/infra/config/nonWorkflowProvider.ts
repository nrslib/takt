import { resolveNonWorkflowProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { PermissionMode } from '../../core/models/types.js';
import type { ProviderType } from '../../core/workflow/types.js';
import { validateProviderModelRequirements } from '../../core/workflow/provider-model-requirements.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { resolveConfigValueWithSource } from './resolveConfigValue.js';
import { resolveRuntimeNonWorkflowProvider } from './runtime-provider/internal-agents.js';
import { composeRuntimeProviderOverride } from './runtime-provider/override.js';

/**
 * Provider/model/options for a non-workflow agent (task summarizer, sync conflict resolver,
 * non-assistant interactive persona). Mirrors the assistant seam's `ResolvedAssistantProvider`:
 * `runtimeManaged` is true only when an active runtime.yaml provider section owns the resolution,
 * in which case `providerOptions` come from the same `defaults` profile and the caller must not
 * fall back to the legacy `resolveNonWorkflowProviderOptions` path.
 */
export interface ResolvedNonWorkflowProvider {
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  permissionMode?: PermissionMode;
  runtimeManaged: boolean;
}

/**
 * Resolve the non-workflow provider/model/options. When an active runtime.yaml provider section
 * exists its `defaults` profile wins (order.md #1136) and its provider/model/options are carried
 * from a single profile, with env (`TAKT_PROVIDER`/`TAKT_MODEL`) overrides composed on top the
 * same way the selector/assistant seams do; otherwise the legacy config.yaml resolution runs
 * unchanged (env overrides are already folded into the loaded config there) and the caller keeps
 * resolving options via `resolveNonWorkflowProviderOptions`. A mixed configuration fails fast
 * inside `resolveRuntimeNonWorkflowProvider`, consistent with the sibling selector/assistant seams.
 */
export function resolveNonWorkflowProviderModel(cwd: string): ResolvedNonWorkflowProvider {
  const runtime = resolveRuntimeNonWorkflowProvider(cwd);
  if (runtime !== undefined) {
    // An env (`TAKT_PROVIDER`/`TAKT_MODEL`) override is a runtime override in both modes, the same
    // rule the selector/assistant seams apply: a provider override drops the runtime-tied
    // model/options, while a model-only override keeps the runtime provider and its options.
    const configuredProvider = resolveConfigValueWithSource(cwd, 'provider');
    const configuredModel = resolveConfigValueWithSource(cwd, 'model');
    const composed = composeRuntimeProviderOverride(
      {
        provider: runtime.provider,
        model: runtime.model,
        providerOptions: runtime.providerOptions,
        permissionMode: runtime.permissionMode,
      },
      {
        provider: configuredProvider.source === 'env' ? configuredProvider.value : undefined,
        model: configuredModel.source === 'env' ? configuredModel.value : undefined,
      },
    );
    // Same fail-fast the selector seam applies: providers that require a model (e.g. opencode's
    // `provider/model` format) must not defer the error to the provider SDK.
    validateProviderModelRequirements(composed.provider, composed.model, {
      modelFieldName: 'Configuration error: runtime.yaml defaults resolved model',
    });
    return {
      runtimeManaged: true,
      provider: composed.provider,
      ...(composed.model !== undefined ? { model: composed.model } : {}),
      ...(composed.providerOptions !== undefined ? { providerOptions: composed.providerOptions } : {}),
      ...(composed.permissionMode !== undefined ? { permissionMode: composed.permissionMode } : {}),
    };
  }
  const legacy = resolveNonWorkflowProviderModelFromConfig({
    project: loadProjectConfig(cwd),
    global: loadGlobalConfig(),
  });
  return { runtimeManaged: false, provider: legacy.provider, model: legacy.model };
}
