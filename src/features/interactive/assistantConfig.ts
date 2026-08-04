import { loadGlobalConfig } from '../../infra/config/global/globalConfig.js';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { resolveConfigValueWithSource } from '../../infra/config/resolveConfigValue.js';
import { resolveRuntimeInternalAgentProvider } from '../../infra/config/runtime-provider/internal-agents.js';
import { composeRuntimeProviderOverride } from '../../infra/config/runtime-provider/override.js';
import {
  resolveAssistantProviderModelFromConfig,
  type AssistantCliOverrides,
  type AssistantProviderConfig,
} from '../../core/config/provider-resolution.js';
import type { ProviderRoutingEntry } from '../../core/models/config-types.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';

/**
 * Assistant provider/model resolution result. Mirrors the selector seam by carrying the
 * runtime-v1 provider options next to provider/model, without widening the shared
 * `ProviderModelOutput`. `runtimeManaged` is true only when an active runtime.yaml provider
 * section owns the resolution; the caller then takes `providerOptions` from here and does not
 * fall back to the legacy `resolveNonWorkflowProviderOptions` path. The result carries no
 * override source: env values are folded into the override composition, not surfaced here.
 */
export interface ResolvedAssistantProvider {
  provider?: ProviderType;
  model?: string;
  providerOptions?: StepProviderOptions;
  runtimeManaged: boolean;
}

export function resolveAssistantConfigLayers(projectDir: string): AssistantProviderConfig {
  const project = loadProjectConfig(projectDir);
  const global = loadGlobalConfig();

  return {
    local: {
      provider: project.provider,
      model: project.model,
      taktProviders: project.taktProviders,
    },
    global: {
      provider: global.provider,
      model: global.model,
      taktProviders: global.taktProviders,
    },
  };
}

/**
 * Resolve the assistant provider/model/options. When an active runtime.yaml provider section
 * exists the `internal_agents.assistant` ladder wins (order.md #1136) and its profile `options`
 * are carried through; otherwise the legacy `taktProviders` resolution runs and the caller keeps
 * resolving options via `resolveNonWorkflowProviderOptions`. Explicit CLI and env
 * (`TAKT_PROVIDER`/`TAKT_MODEL`) overrides win over the runtime profile in both modes — cli takes
 * priority over env — and a provider override drops the runtime-tied model and options (symmetric
 * with the selector seam `resolveSelectorFromRuntimeV1`).
 */
export function resolveAssistantProviderModel(
  projectDir: string,
  cliOverrides?: AssistantCliOverrides,
): ResolvedAssistantProvider {
  const runtime = resolveRuntimeInternalAgentProvider(projectDir, 'assistant');
  if (runtime !== undefined) {
    return resolveAssistantFromRuntimeV1(runtime, projectDir, cliOverrides);
  }
  const legacy = resolveAssistantProviderModelFromConfig(
    resolveAssistantConfigLayers(projectDir),
    cliOverrides,
  );
  return { runtimeManaged: false, provider: legacy.provider, model: legacy.model };
}

/**
 * Resolve the assistant provider/model/options from an active runtime.yaml section. A CLI or env
 * provider/model override wins over the runtime profile (order.md treats an explicit provider
 * selection as a runtime override in both modes), with cli taking priority over env; overriding the
 * provider drops the runtime-tied model and options, while a model-only override keeps the runtime
 * provider and its options. Config values whose source is `default`/`project`/`global` are not
 * overrides and leave the runtime profile untouched.
 */
function resolveAssistantFromRuntimeV1(
  runtime: ProviderRoutingEntry,
  projectDir: string,
  cliOverrides?: AssistantCliOverrides,
): ResolvedAssistantProvider {
  const configuredProvider = resolveConfigValueWithSource(projectDir, 'provider');
  const configuredModel = resolveConfigValueWithSource(projectDir, 'model');
  const providerOverride = cliOverrides?.provider
    ?? (configuredProvider.source === 'env' ? configuredProvider.value : undefined);
  const modelOverride = cliOverrides?.model
    ?? (configuredModel.source === 'env' ? configuredModel.value : undefined);

  const composed = composeRuntimeProviderOverride(
    { provider: runtime.provider, model: runtime.model, providerOptions: runtime.providerOptions },
    { provider: providerOverride, model: modelOverride },
  );
  return {
    runtimeManaged: true,
    provider: composed.provider,
    model: composed.model,
    ...(composed.providerOptions !== undefined ? { providerOptions: composed.providerOptions } : {}),
  };
}
