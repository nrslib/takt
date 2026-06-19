import type { ProviderType } from '../../../shared/types/provider.js';
import type { McpServerConfig, StepProviderOptions } from '../../models/types.js';
import {
  providerKeepsAllowedToolWithoutEdit,
  providerSupportsAllowedTools,
  providerSupportsClaudeAllowedTools,
  providerSupportsMcpServers,
  providerSupportsOpenCodeAllowedTools,
} from '../../../infra/providers/provider-capabilities.js';
import {
  isTeamLeaderInspectTool,
  type TeamLeaderInspectTool,
} from '../../../shared/team-leader-inspect-tools.js';

interface CapabilitySensitiveStepOptions {
  stepName: string;
  usesStructuredOutput: boolean;
}

type CapabilityProbe = (provider: ProviderType | undefined) => boolean | undefined;

const CLAUDE_TEAM_LEADER_INSPECT_TOOL_NAMES: Record<TeamLeaderInspectTool, string> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
};

// Silent-drop: workflows may carry options for providers they aren't currently
// running under. Keep the value only when capability is confirmed true.
function keepWhenProviderSupports<T>(
  value: T | undefined,
  provider: ProviderType | undefined,
  probe: CapabilityProbe,
): T | undefined {
  return probe(provider) === true ? value : undefined;
}

export function resolveAllowedToolsForProvider(
  providerOptions: StepProviderOptions | undefined,
  hasOutputContracts: boolean,
  edit: boolean | undefined,
  provider: ProviderType | undefined,
): string[] | undefined {
  const allowedTools = keepWhenProviderSupports(
    providerOptions?.claude?.allowedTools,
    provider,
    providerSupportsClaudeAllowedTools,
  ) ?? keepWhenProviderSupports(
    providerOptions?.opencode?.allowedTools,
    provider,
    providerSupportsOpenCodeAllowedTools,
  );
  if (!allowedTools) {
    return undefined;
  }
  if (!hasOutputContracts || edit === true) {
    return allowedTools;
  }
  return allowedTools.filter((tool) => providerKeepsAllowedToolWithoutEdit(provider, tool));
}

export function resolveMcpServersForProvider(
  mcpServers: Record<string, McpServerConfig> | undefined,
  provider: ProviderType | undefined,
): Record<string, McpServerConfig> | undefined {
  return keepWhenProviderSupports(mcpServers, provider, providerSupportsMcpServers);
}

export function resolvePartAllowedToolsForProvider(
  partAllowedTools: string[] | undefined,
  provider: ProviderType | undefined,
): string[] | undefined {
  return keepWhenProviderSupports(partAllowedTools, provider, providerSupportsAllowedTools);
}

export function resolveInspectToolsForProvider(
  inspectTools: string[] | undefined,
  provider: ProviderType | undefined,
): string[] | undefined {
  if (inspectTools === undefined || inspectTools.length === 0) {
    return undefined;
  }

  const supportedInspectTools = inspectTools.map((tool) => {
    if (!isTeamLeaderInspectTool(tool)) {
      throw new Error(`Unsupported team_leader.inspect_tools value "${tool}"`);
    }
    return tool;
  });

  if (provider === undefined) {
    throw new Error('team_leader.inspect_tools requires a resolved provider');
  }
  if (providerSupportsOpenCodeAllowedTools(provider) === true) {
    return supportedInspectTools;
  }
  if (providerSupportsClaudeAllowedTools(provider) === true) {
    return supportedInspectTools.map((tool) => CLAUDE_TEAM_LEADER_INSPECT_TOOL_NAMES[tool]);
  }
  throw new Error(`Provider "${provider}" does not support team_leader.inspect_tools`);
}

export function assertProviderResolvedForCapabilitySensitiveOptions(
  provider: ProviderType | undefined,
  options: CapabilitySensitiveStepOptions,
): asserts provider is ProviderType {
  if (provider !== undefined) {
    return;
  }

  if (!options.usesStructuredOutput) {
    return;
  }

  throw new Error(
    `Step "${options.stepName}" uses structured_output but provider is not resolved`,
  );
}
