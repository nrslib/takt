/**
 * Runtime-v1 provider resolution for the seams that resolve provider/model outside the
 * workflow-execution bootstrap (issue #1136): the internal selector/assistant agents and the
 * non-workflow agents (task summarizer, sync conflict resolver, non-assistant interactive
 * personas). These seams cannot read the compiled bundle the bootstrap builds, so when an active
 * `runtime.yaml` provider section exists this module compiles that section through the same
 * `RuntimeProviderPolicyCompiler`. The internal-agent resolver returns the `internal_agents`
 * entry (falling back to the `defaults` profile per the order.md resolution ladder); the
 * non-workflow resolver returns the `defaults` profile directly (those agents are not covered by
 * `targets.internal_agents`). Both share the mixed-config gate and return `undefined` in legacy
 * mode so callers keep their legacy config.yaml resolution.
 */

import { getGlobalConfigDir, getProjectConfigDir } from '../paths.js';
import type { ProviderRoutingEntry } from '../../../core/models/config-types.js';
import { compileProviderEnvironment, type CompiledProviderEnvironment } from './environment.js';
import { collectProjectLegacyProviderSignals } from './legacy-signals.js';
import { resolveRuntimeProviderFileWithOrigins } from './loader.js';
import { determineProviderConfigMode } from './mode.js';
import { getEffectiveRuntimeProviderFile } from './schema.js';
import { createRuntimeProviderResolutionContext } from './resolution-context.js';

export type RuntimeInternalAgent = 'selector' | 'assistant';

/**
 * Compile the active runtime.yaml provider section for a seam that resolves provider/model outside
 * the workflow bootstrap. Returns `undefined` in legacy mode (no active section) so the caller
 * keeps its legacy config.yaml resolution; throws the shared mixed-config error when a legacy
 * config.yaml provider signal coexists with an active section (order.md #1136), rather than the
 * seam silently preferring runtime-v1.
 */
function resolveActiveRuntimeProviderEnvironment(
  projectCwd: string,
): CompiledProviderEnvironment | undefined {
  const resolvedRuntimeFile = resolveRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(),
    projectConfigDir: getProjectConfigDir(projectCwd),
  });
  const runtimeFile = getEffectiveRuntimeProviderFile(resolvedRuntimeFile.runtimeFile);
  const { mode } = determineProviderConfigMode({
    runtimeFile,
    legacyProviderSignals: collectProjectLegacyProviderSignals(projectCwd),
  });
  if (mode === 'legacy') {
    return undefined;
  }
  const section = runtimeFile?.provider;
  if (section === undefined) {
    // Unreachable: runtime-v1 mode requires an active provider section. Fail fast like
    // resolveCompiledProviderEnvironment instead of silently falling back to legacy resolution.
    throw new Error('runtime-v1 mode resolved without a provider section');
  }
  return compileProviderEnvironment({
    kind: 'runtime-v1',
    section,
    resolutionContext: createRuntimeProviderResolutionContext(
      projectCwd,
      resolvedRuntimeFile.profileOrigins,
    ),
  });
}

/**
 * Build the `defaults` profile entry from a compiled runtime env. Runtime defaults are always a
 * concrete profile or ladder stage, so an unresolved provider is a configuration error rather
 * than an invitation to reuse an auto-routing fallback or legacy config.yaml value.
 */
function defaultsProfileEntry(
  env: CompiledProviderEnvironment,
): ProviderRoutingEntry | undefined {
  if (env.provider === undefined) {
    throw new Error(
      'No provider configured. The active runtime.yaml provider section resolves no `provider.defaults`; set `provider.defaults` in runtime.yaml',
    );
  }
  return {
    provider: env.provider,
    ...(env.model !== undefined ? { model: env.model } : {}),
    ...(env.providerOptions !== undefined ? { providerOptions: env.providerOptions } : {}),
    ...(env.permissionMode !== undefined ? { permissionMode: env.permissionMode } : {}),
  };
}

/**
 * Resolve provider/model/options for an internal agent from an active runtime.yaml provider
 * section. Returns `undefined` when no active runtime-v1 section exists (legacy mode) or when
 * neither an explicit `internal_agents` target nor a fixed `defaults` profile is available.
 */
export function resolveRuntimeInternalAgentProvider(
  projectCwd: string,
  agent: RuntimeInternalAgent,
): ProviderRoutingEntry | undefined {
  const env = resolveActiveRuntimeProviderEnvironment(projectCwd);
  if (env === undefined) {
    return undefined;
  }
  const explicit = env.internalAgents?.[agent];
  if (explicit !== undefined) {
    return explicit;
  }
  return defaultsProfileEntry(env);
}

/**
 * Resolve provider/model/options for the non-workflow agents (task summarizer, sync conflict
 * resolver, non-assistant interactive personas) from an active runtime.yaml provider section.
 * These agents are not the selector/assistant internal agents, so they resolve the `defaults`
 * profile directly. Returns `undefined` in legacy mode so callers keep resolving
 * provider/model/options from config.yaml.
 */
export function resolveRuntimeNonWorkflowProvider(
  projectCwd: string,
): ProviderRoutingEntry | undefined {
  const env = resolveActiveRuntimeProviderEnvironment(projectCwd);
  if (env === undefined) {
    return undefined;
  }
  return defaultsProfileEntry(env);
}
