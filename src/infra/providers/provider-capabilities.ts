import type { ProviderType } from './types.js';
import { getProvider } from './index.js';

const MCP_SERVER_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'claude-terminal',
]);

const ALLOWED_TOOLS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'claude-terminal',
  'opencode',
  'mock',
]);

const CLAUDE_ALLOWED_TOOLS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'claude-terminal',
  'mock',
]);

const MAX_TURNS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'mock',
]);

interface ProviderCapabilities {
  supportsStructuredOutput: boolean;
  supportsNativeImageInput: boolean;
  supportsMcpServers: boolean;
  supportsAllowedTools: boolean;
  supportsClaudeAllowedTools: boolean;
  supportsMaxTurns: boolean;
}

function resolveProviderCapabilities(
  provider: ProviderType | undefined,
): ProviderCapabilities | undefined {
  if (provider === undefined) {
    return undefined;
  }

  const providerImpl = getProvider(provider);

  return {
    supportsStructuredOutput: providerImpl.supportsStructuredOutput,
    supportsNativeImageInput: providerImpl.supportsNativeImageInput,
    supportsMcpServers: MCP_SERVER_PROVIDERS.has(provider),
    supportsAllowedTools: ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsClaudeAllowedTools: CLAUDE_ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsMaxTurns: MAX_TURNS_PROVIDERS.has(provider),
  };
}

export function providerSupportsStructuredOutput(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsStructuredOutput;
}

export function providerSupportsNativeImageInput(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsNativeImageInput;
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

export function providerSupportsMaxTurns(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsMaxTurns;
}
