/**
 * Provider configuration mode detection (issue #1136).
 *
 * Runtime mode is decided by the presence of an *active* `provider` section — not by the
 * runtime.yaml file merely existing (an inactive `version: 1` file keeps legacy behavior).
 * When an active runtime section coexists with any legacy provider setting, mode detection
 * fails fast with an error that names each legacy location and its migration target, rather
 * than silently merging or preferring one side.
 */

import { hasActiveProviderContent, type RuntimeProviderFile, type McpSection } from './schema.js';
import { DEFAULT_COMPANION_ENABLED } from '../../../shared/constants.js';

export type ProviderConfigMode = 'legacy' | 'runtime-v1';

export interface LegacyProviderSignal {
  /** Legacy setting that was found (e.g. `provider_routing`). */
  setting: string;
  /** Where it lives (e.g. `config.yaml:provider_routing`). */
  location: string;
  /** Runtime-v1 destination it should move to (e.g. `provider.targets`). */
  migrateTo: string;
}

export interface DetermineProviderConfigModeInput {
  runtimeFile: RuntimeProviderFile | undefined;
  legacyProviderSignals: LegacyProviderSignal[];
}

/** True only when the runtime.yaml carries a provider section with meaningful content. */
export function hasActiveProviderSection(file: RuntimeProviderFile | undefined): boolean {
  return hasActiveProviderContent(
    file?.provider,
    file?.companion?.enabled ?? DEFAULT_COMPANION_ENABLED,
  );
}

/**
 * True only when the runtime.yaml carries an `mcp` section with meaningful
 * content. The `mcp` section is independent from `provider` — it may be active
 * alone (order.md:36, plan MCP-LEGACY-GATE). Server definitions become active
 * only when a default or positive target assignment references them.
 */
export function hasActiveMcpSection(file: RuntimeProviderFile | undefined): boolean {
  return hasActiveMcpAssignments(file?.mcp);
}

/** Section-level variant: true only when a default or positive target assignment exists. */
export function hasActiveMcpAssignments(mcp: McpSection | undefined): boolean {
  if (!mcp) {
    return false;
  }
  const hasDefaults = mcp.defaults !== undefined && mcp.defaults.servers.length > 0;
  const hasTargetAssignments = [
    mcp.targets?.personas,
    mcp.targets?.tags,
    mcp.targets?.steps,
  ].some((targetMap) => Object.values(targetMap ?? {}).some(
    (target) => (target.servers?.length ?? 0) > 0,
  ));
  return hasDefaults || hasTargetAssignments;
}

export function determineProviderConfigMode(
  input: DetermineProviderConfigModeInput,
): { mode: ProviderConfigMode } {
  const hasProvider = hasActiveProviderSection(input.runtimeFile);
  const hasMcp = hasActiveMcpSection(input.runtimeFile);
  if (!hasProvider && !hasMcp) {
    return { mode: 'legacy' };
  }
  // An active MCP section can be layered on top of legacy provider/model
  // resolution; runtime-v1 owns only the MCP assignment in this case.
  if (!hasProvider && hasMcp) {
    return { mode: 'runtime-v1' };
  }
  if (input.legacyProviderSignals.length > 0) {
    throw new Error(buildMixedConfigError(input.legacyProviderSignals));
  }
  return { mode: 'runtime-v1' };
}

function buildMixedConfigError(signals: LegacyProviderSignal[]): string {
  const lines = signals.map(
    (signal) => `  - ${signal.setting} at ${signal.location} → migrate to ${signal.migrateTo}`,
  );
  return [
    'Mixed provider configuration detected: an active runtime.yaml provider section cannot',
    'coexist with legacy provider settings. Remove the runtime.yaml provider section or migrate',
    'the following legacy settings:',
    ...lines,
  ].join('\n');
}
