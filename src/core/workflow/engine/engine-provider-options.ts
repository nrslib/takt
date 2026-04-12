import type { ProviderType } from '../../../shared/types/provider.js';
import type { McpServerConfig, StepProviderOptions } from '../../models/types.js';
import {
  providerSupportsAllowedTools,
  providerSupportsClaudeAllowedTools,
  providerSupportsMcpServers,
} from '../../../infra/providers/provider-capabilities.js';

interface CapabilitySensitiveStepOptions {
  stepName: string;
  usesStructuredOutput: boolean;
  usesMcpServers: boolean;
  usesClaudeAllowedTools: boolean;
  usesAllowedTools?: string;
}

export function resolveAllowedToolsForProvider(
  providerOptions: StepProviderOptions | undefined,
  hasOutputContracts: boolean,
  edit: boolean | undefined,
): string[] | undefined {
  const allowedTools = providerOptions?.claude?.allowedTools;
  if (!hasOutputContracts || edit === true) {
    return allowedTools;
  }

  return allowedTools?.filter((tool) => tool !== 'Write');
}

export function assertProviderResolvedForCapabilitySensitiveOptions(
  provider: ProviderType | undefined,
  options: CapabilitySensitiveStepOptions,
): void {
  if (provider !== undefined) {
    return;
  }

  const enabledFeatures: string[] = [];
  if (options.usesStructuredOutput) {
    enabledFeatures.push('structured_output');
  }
  if (options.usesMcpServers) {
    enabledFeatures.push('mcp_servers');
  }
  if (options.usesClaudeAllowedTools) {
    enabledFeatures.push('provider_options.claude.allowed_tools');
  }
  if (options.usesAllowedTools) {
    enabledFeatures.push(options.usesAllowedTools);
  }
  if (enabledFeatures.length === 0) {
    return;
  }

  throw new Error(
    `Step "${options.stepName}" uses ${enabledFeatures.join(', ')} but provider is not resolved`,
  );
}

export function assertProviderSupportsClaudeAllowedTools(
  provider: ProviderType | undefined,
  providerOptions: StepProviderOptions | undefined,
): void {
  const allowedTools = providerOptions?.claude?.allowedTools;
  if (!allowedTools || allowedTools.length === 0) {
    return;
  }

  if (provider !== undefined && providerSupportsClaudeAllowedTools(provider) === false) {
    throw new Error(
      `provider_options.claude.allowed_tools is not supported for provider "${provider}"`,
    );
  }
}

export function assertProviderSupportsAllowedTools(
  provider: ProviderType | undefined,
  allowedTools: string[] | undefined,
  optionName = 'allowed_tools',
): void {
  if (!allowedTools || allowedTools.length === 0) {
    return;
  }

  if (provider !== undefined && providerSupportsAllowedTools(provider) === false) {
    throw new Error(
      `${optionName} is not supported for provider "${provider}"`,
    );
  }
}

export function assertProviderSupportsMcpServers(
  provider: ProviderType | undefined,
  mcpServers: Record<string, McpServerConfig> | undefined,
): void {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return;
  }

  if (provider !== undefined && providerSupportsMcpServers(provider) === false) {
    throw new Error(
      `mcp_servers is not supported for provider "${provider ?? 'unknown'}"`,
    );
  }
}
