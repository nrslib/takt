/**
 * Bootstrap seam that compiles the effective provider environment (issue #1136).
 *
 * Reads the fixed `runtime.yaml` locations, decides legacy vs runtime-v1 mode (failing fast on
 * a mixed configuration), and compiles the matching configuration format into the shared
 * engine-options bundle. This is the single place the bootstrap consults; the engine, runners
 * and provider SDK stay format-agnostic.
 *
 * Lives in `infra/config/runtime-provider` (not `features`) so that infra entry points such as
 * `workflowPreview` can consult it without an `infra → features` upward dependency.
 */

import { getGlobalConfigDir, getProjectConfigDir } from '../paths.js';
import {
  compileProviderEnvironment,
  type CompiledProviderEnvironment,
  type LegacyProviderEnvironmentInput,
} from './environment.js';
import { applyRuntimeProviderOverride } from './override.js';
import { resolveRuntimeProviderFileWithOrigins } from './loader.js';
import {
  determineProviderConfigMode,
  hasActiveMcpSection,
  hasActiveProviderSection,
  type ProviderConfigMode,
  type LegacyProviderSignal,
} from './mode.js';
import {
  collectLegacyProviderSignals,
  selectConfigTaktProviders,
} from './legacy-signals.js';
import {
  loadGlobalConfig,
  loadProjectConfig,
  resolveConfigValueWithSource,
  resolveProviderOptionsWithTrace,
  resolveWorkflowConfigValues,
  toProviderResolutionSource,
} from '../index.js';
import { resolveEffectiveAutoRouting } from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  DEFAULT_COMPANION_FIX_POLICY,
  DEFAULT_COMPANION_REVIEW_MODE,
  type CompanionFixPolicy,
  type CompanionReviewMode,
} from '../../../core/models/companion-types.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import { getEffectiveRuntimeProviderFile } from './schema.js';
import { createRuntimeProviderResolutionContext } from './resolution-context.js';
import { DEFAULT_COMPANION_ENABLED } from '../../../shared/constants.js';

export interface ResolvedRuntimeEnvironment {
  providerEnvironment: CompiledProviderEnvironment;
  /** Provider options resolved from config.yaml and environment variables. */
  configProviderOptions?: StepProviderOptions;
  companionEnabled: boolean;
  companionReviewMode: CompanionReviewMode;
  companionFixPolicy: CompanionFixPolicy;
  providerConfigMode: ProviderConfigMode;
}

export interface ResolveProviderEnvironmentInput {
  /** Project root; its `.takt/runtime.yaml` overrides the global one. */
  projectCwd: string;
  /** Execution directory used for trusted relative paths from global runtime profiles. */
  executionCwd?: string;
  /** Provider engine-options the legacy path already resolved (used verbatim in legacy mode). */
  legacy: LegacyProviderEnvironmentInput;
  /** Legacy provider settings detected in the current run (for mixed-config fail-fast). */
  legacySignals: LegacyProviderSignal[];
}

export function resolveCompiledProviderEnvironment(
  input: ResolveProviderEnvironmentInput,
): CompiledProviderEnvironment {
  return resolveRuntimeEnvironment(input).providerEnvironment;
}

export function resolveRuntimeEnvironment(
  input: ResolveProviderEnvironmentInput,
): ResolvedRuntimeEnvironment {
  const resolvedRuntimeFile = resolveRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(input.projectCwd),
  });
  const runtimeFile = resolvedRuntimeFile.runtimeFile;
  const companionEnabled = runtimeFile?.companion?.enabled ?? DEFAULT_COMPANION_ENABLED;
  const companionReviewMode = runtimeFile?.companion?.review_mode ?? DEFAULT_COMPANION_REVIEW_MODE;
  const companionFixPolicy = runtimeFile?.companion?.fix_policy ?? DEFAULT_COMPANION_FIX_POLICY;
  const runtimeFileForProviderResolution = getEffectiveRuntimeProviderFile(runtimeFile);
  const { mode } = determineProviderConfigMode({
    runtimeFile: runtimeFileForProviderResolution,
    legacyProviderSignals: input.legacySignals,
  });
  if (mode === 'legacy') {
    return {
      providerEnvironment: compileProviderEnvironment({ kind: 'legacy', legacy: input.legacy }),
      companionEnabled,
      companionReviewMode,
      companionFixPolicy,
      providerConfigMode: mode,
    };
  }
  const section = hasActiveProviderSection(runtimeFileForProviderResolution)
    ? runtimeFileForProviderResolution?.provider
    : undefined;
  const activeMcp = hasActiveMcpSection(runtimeFileForProviderResolution)
    ? runtimeFileForProviderResolution?.mcp
    : undefined;
  // Runtime-v1 mode may be entered by an active `mcp` section alone (order.md:36:
  // `mcp` is independent from `provider`). When no active `provider` section is present
  // the provider bundle carries no runtime provider/model/options, but the mcp
  // assignment still flows through `mcpAssignment` so the engine resolves
  // effective servers per agent execution.
  if (section === undefined) {
    const legacyEnvironment = compileProviderEnvironment({ kind: 'legacy', legacy: input.legacy });
    return {
      // MCP-only mode keeps the complete legacy provider environment and adds
      // only the active runtime MCP assignment (docs/configuration.md).
      providerEnvironment: { ...legacyEnvironment, mcpAssignment: activeMcp },
      configProviderOptions: input.legacy.providerOptions,
      companionEnabled,
      companionReviewMode,
      companionFixPolicy,
      providerConfigMode: mode,
    };
  }
  // The runtime-v1 bundle carries only the runtime.yaml `profiles.default`; re-apply the CLI/env
  // provider/model override the bootstrap already resolved so the main execution path honors an
  // explicit `--provider`/`--model` the same way the selector seam does.
  return {
    providerEnvironment: applyRuntimeProviderOverride(
      compileProviderEnvironment({
        kind: 'runtime-v1',
        section,
        mcp: activeMcp,
        resolutionContext: createRuntimeProviderResolutionContext(
          input.projectCwd,
          resolvedRuntimeFile.profileOrigins,
          input.executionCwd,
        ),
      }),
      {
        provider: input.legacy.provider,
        providerSource: input.legacy.providerSource,
        model: input.legacy.model,
        modelSource: input.legacy.modelSource,
      },
    ),
    configProviderOptions: input.legacy.providerOptions,
    companionEnabled,
    companionReviewMode,
    companionFixPolicy,
    providerConfigMode: mode,
  };
}

/**
 * Resolve the compiled provider environment for auxiliary entry points (preview / doctor) that
 * carry no CLI or task overrides. Display and validation must resolve
 * provider/model/personaProviders/providerRouting/autoRouting through the same compiled bundle as
 * execution, so a runtime-v1 environment surfaces the runtime.yaml `profiles.default` values
 * instead of legacy defaults, and a mixed configuration fails fast at these entries too.
 */
export function resolveAuxiliaryProviderEnvironment(
  projectCwd: string,
  workflow: Pick<WorkflowConfig, 'name'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): CompiledProviderEnvironment {
  return resolveAuxiliaryRuntimeEnvironment(projectCwd, workflow).providerEnvironment;
}

export function resolveAuxiliaryRuntimeEnvironment(
  projectCwd: string,
  _workflow: Pick<WorkflowConfig, 'name'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): ResolvedRuntimeEnvironment {
  const resolved = resolveWorkflowConfigValues(projectCwd, [
    'personaProviders',
    'providerRouting',
    'autoRouting',
  ]);
  const provider = resolveConfigValueWithSource(projectCwd, 'provider');
  const model = resolveConfigValueWithSource(projectCwd, 'model');
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: provider.value,
    providerSource: toProviderResolutionSource(provider.source),
    model: model.value,
    modelSource: toProviderResolutionSource(model.source),
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolveEffectiveAutoRouting(resolved.autoRouting),
    providerOptions: providerOptions.value,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  return resolveRuntimeEnvironment({
    projectCwd,
    legacy,
    legacySignals: collectLegacyProviderSignals(
      legacy,
      providerOptions.source,
    ),
  });
}
