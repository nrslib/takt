import type { ProviderType } from './types.js';
import { getProvider } from './index.js';

const MCP_SERVER_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
]);

const ALLOWED_TOOLS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'opencode',
  'mock',
]);

const CLAUDE_ALLOWED_TOOLS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'mock',
]);

interface ProviderCapabilities {
  supportsStructuredOutput: boolean;
  supportsMcpServers: boolean;
  supportsAllowedTools: boolean;
  supportsClaudeAllowedTools: boolean;
}

function resolveProviderCapabilities(
  provider: ProviderType | undefined,
): ProviderCapabilities | undefined {
  if (provider === undefined) {
    return undefined;
  }

  return {
    supportsStructuredOutput: getProvider(provider).supportsStructuredOutput,
    supportsMcpServers: MCP_SERVER_PROVIDERS.has(provider),
    supportsAllowedTools: ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsClaudeAllowedTools: CLAUDE_ALLOWED_TOOLS_PROVIDERS.has(provider),
  };
}

export function providerSupportsStructuredOutput(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsStructuredOutput;
}

export function providerSupportsMcpServers(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsMcpServers;
}

export function providerSupportsAllowedTools(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsAllowedTools;
}

export function providerSupportsClaudeAllowedTools(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsClaudeAllowedTools;
}
