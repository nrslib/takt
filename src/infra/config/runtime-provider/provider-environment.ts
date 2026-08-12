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
import { resolveRuntimeProviderFile } from './loader.js';
import {
  determineProviderConfigMode,
  type ProviderConfigMode,
  type LegacyProviderSignal,
} from './mode.js';
import {
  collectLegacyProviderSignals,
  collectStepPromotionEntries,
  selectConfigTaktProviders,
} from './legacy-signals.js';
import {
  loadGlobalConfig,
  loadProjectConfig,
  resolveConfigValueWithSource,
  resolveProviderOptionsWithTrace,
  resolveWorkflowConfigValues,
} from '../index.js';
import { resolveEffectiveAutoRouting } from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { RuntimeProviderFile } from './schema.js';

export interface ResolvedRuntimeEnvironment {
  providerEnvironment: CompiledProviderEnvironment;
  companionEnabled: boolean;
  providerConfigMode: ProviderConfigMode;
}

export interface ResolveProviderEnvironmentInput {
  /** Project root; its `.takt/runtime.yaml` overrides the global one. */
  projectCwd: string;
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
  const runtimeFile = resolveRuntimeProviderFile({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(input.projectCwd),
  });
  const companionEnabled = runtimeFile?.companion?.enabled ?? true;
  const runtimeFileForProviderResolution = companionEnabled
    ? runtimeFile
    : withoutCompanionTargets(runtimeFile);
  const { mode } = determineProviderConfigMode({
    runtimeFile: runtimeFileForProviderResolution,
    legacyProviderSignals: input.legacySignals,
  });
  if (mode === 'legacy') {
    return {
      providerEnvironment: compileProviderEnvironment({ kind: 'legacy', legacy: input.legacy }),
      companionEnabled,
      providerConfigMode: mode,
    };
  }
  const section = runtimeFileForProviderResolution?.provider;
  if (section === undefined) {
    // Unreachable: runtime-v1 mode requires an active provider section.
    throw new Error('runtime-v1 mode resolved without a provider section');
  }
  // The runtime-v1 bundle carries only the runtime.yaml `profiles.default`; re-apply the CLI/env
  // provider/model override the bootstrap already resolved so the main execution path honors an
  // explicit `--provider`/`--model` the same way the selector seam does.
  return {
    providerEnvironment: applyRuntimeProviderOverride(
      compileProviderEnvironment({ kind: 'runtime-v1', section }),
      {
        provider: input.legacy.provider,
        providerSource: input.legacy.providerSource,
        model: input.legacy.model,
        modelSource: input.legacy.modelSource,
      },
    ),
    companionEnabled,
    providerConfigMode: mode,
  };
}

function withoutCompanionTargets(
  runtimeFile: RuntimeProviderFile | undefined,
): RuntimeProviderFile | undefined {
  if (runtimeFile?.provider?.targets === undefined) {
    return runtimeFile;
  }
  const targets = { ...runtimeFile.provider.targets };
  delete targets.companions;
  return {
    ...runtimeFile,
    provider: {
      ...runtimeFile.provider,
      targets,
    },
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
  workflow: Pick<WorkflowConfig, 'name' | 'provider' | 'model' | 'autoRouting'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): CompiledProviderEnvironment {
  return resolveAuxiliaryRuntimeEnvironment(projectCwd, workflow).providerEnvironment;
}

export function resolveAuxiliaryRuntimeEnvironment(
  projectCwd: string,
  workflow: Pick<WorkflowConfig, 'name' | 'provider' | 'model' | 'autoRouting'>
    & Partial<Pick<WorkflowConfig, 'steps'>>,
): ResolvedRuntimeEnvironment {
  const resolved = resolveWorkflowConfigValues(projectCwd, [
    'personaProviders',
    'providerRouting',
    'autoRouting',
  ]);
  const provider = resolveConfigValueWithSource(projectCwd, 'provider', {
    workflowContext: { provider: workflow.provider },
  });
  const model = resolveConfigValueWithSource(projectCwd, 'model', {
    workflowContext: { model: workflow.model },
  });
  const providerOptions = resolveProviderOptionsWithTrace(projectCwd);
  const legacy: LegacyProviderEnvironmentInput = {
    provider: provider.value,
    providerSource: provider.source,
    model: model.value,
    modelSource: model.source,
    personaProviders: resolved.personaProviders,
    providerRouting: resolved.providerRouting,
    autoRouting: resolveEffectiveAutoRouting(workflow, resolved.autoRouting),
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
      {
        name: workflow.name,
        provider: workflow.provider,
        model: workflow.model,
        autoRouting: workflow.autoRouting,
        promotion: collectStepPromotionEntries(workflow.steps),
      },
      providerOptions.source,
    ),
  });
}
