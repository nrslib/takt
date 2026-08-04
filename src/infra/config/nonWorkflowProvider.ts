import { resolveNonWorkflowProviderModelFromConfig } from '../../core/config/provider-resolution.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { ProviderType } from '../../core/workflow/types.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';
import { resolveRuntimeNonWorkflowProvider } from './runtime-provider/internal-agents.js';

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
  runtimeManaged: boolean;
}

/**
 * Resolve the non-workflow provider/model/options. When an active runtime.yaml provider section
 * exists its `defaults` profile wins (order.md #1136) and its provider/model/options are carried
 * from a single profile; otherwise the legacy config.yaml resolution runs unchanged and the caller
 * keeps resolving options via `resolveNonWorkflowProviderOptions`. A mixed configuration fails fast
 * inside `resolveRuntimeNonWorkflowProvider`, consistent with the sibling selector/assistant seams.
 */
export function resolveNonWorkflowProviderModel(cwd: string): ResolvedNonWorkflowProvider {
  const runtime = resolveRuntimeNonWorkflowProvider(cwd);
  if (runtime !== undefined) {
    return {
      runtimeManaged: true,
      provider: runtime.provider,
      ...(runtime.model !== undefined ? { model: runtime.model } : {}),
      ...(runtime.providerOptions !== undefined ? { providerOptions: runtime.providerOptions } : {}),
    };
  }
  const legacy = resolveNonWorkflowProviderModelFromConfig({
    project: loadProjectConfig(cwd),
    global: loadGlobalConfig(),
  });
  return { runtimeManaged: false, provider: legacy.provider, model: legacy.model };
}
