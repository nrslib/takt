import type { ProviderType } from './types.js';
import { getProvider } from './index.js';
import { createStrictInternalAgentIsolationError } from '../../shared/types/provider.js';

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

const OPENCODE_ALLOWED_TOOLS_PROVIDERS = new Set<ProviderType>([
  'opencode',
]);

const MAX_TURNS_PROVIDERS = new Set<ProviderType>([
  'claude',
  'claude-sdk',
  'codex',
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
  supportsOpenCodeAllowedTools: boolean;
  supportsMaxTurns: boolean;
  supportsStrictInternalAgentIsolation: boolean;
}

const STRICT_INTERNAL_AGENT_NATIVE_TOOLS: Readonly<Partial<Record<ProviderType, readonly string[]>>> = {
  codex: ['request_user_input', 'update_plan', 'view_image', 'web_search'],
  claude: [],
  'claude-sdk': [],
  'claude-terminal': [],
  mock: [],
};

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
    supportsOpenCodeAllowedTools: OPENCODE_ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsMaxTurns: MAX_TURNS_PROVIDERS.has(provider),
    supportsStrictInternalAgentIsolation: providerImpl.supportsStrictInternalAgentIsolation,
  };
}

export function providerSupportsStrictInternalAgentIsolation(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsStrictInternalAgentIsolation;
}

export function assertProviderSupportsStrictInternalAgentIsolation(
  provider: ProviderType,
): void {
  if (providerSupportsStrictInternalAgentIsolation(provider) !== true) {
    throw createStrictInternalAgentIsolationError(provider);
  }
}

export function assertProviderSupportsSelectorExecution(provider: ProviderType): void {
  assertProviderSupportsStrictInternalAgentIsolation(provider);
  if (providerSupportsStructuredOutput(provider) !== true) {
    throw new Error(
      `Provider "${provider}" does not support native structured output required by dynamic parallel selector`,
    );
  }
}

export function resolveStrictInternalAgentNativeTools(
  provider: ProviderType,
): readonly string[] {
  assertProviderSupportsStrictInternalAgentIsolation(provider);
  const tools = STRICT_INTERNAL_AGENT_NATIVE_TOOLS[provider];
  if (tools === undefined) {
    throw new Error(`Provider "${provider}" has no strict internal-agent native tool profile`);
  }
  return [...tools];
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

export function providerSupportsOpenCodeAllowedTools(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsOpenCodeAllowedTools;
}

export function providerSupportsMaxTurns(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsMaxTurns;
}

export function providerKeepsAllowedToolWithoutEdit(
  provider: ProviderType | undefined,
  tool: string,
): boolean {
  if (provider === undefined) {
    return true;
  }

  return getProvider(provider).keepsAllowedToolWithoutEdit(tool);
}
