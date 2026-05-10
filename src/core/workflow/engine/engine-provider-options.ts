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
}

type CapabilityProbe = (provider: ProviderType | undefined) => boolean | undefined;

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
  );
  if (!allowedTools) {
    return undefined;
  }
  if (!hasOutputContracts || edit === true) {
    return allowedTools;
  }
  return allowedTools.filter((tool) => tool !== 'Write');
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
