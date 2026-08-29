import type { ProviderType } from './types.js';
import { getProvider } from './index.js';

const ALLOWED_TOOLS_PROVIDERS: ReadonlySet<ProviderType> = new Set([
  'claude', 'claude-sdk', 'claude-terminal', 'opencode', 'pi', 'mock',
]);

const CLAUDE_ALLOWED_TOOLS_PROVIDERS: ReadonlySet<ProviderType> = new Set([
  'claude', 'claude-sdk', 'claude-terminal', 'mock',
]);

const OPENCODE_ALLOWED_TOOLS_PROVIDERS: ReadonlySet<ProviderType> = new Set(['opencode']);

const MAX_TURNS_PROVIDERS: ReadonlySet<ProviderType> = new Set([
  'claude', 'claude-sdk', 'codex', 'cursor', 'copilot', 'mock',
]);

interface ProviderCapabilities {
  supportsStructuredOutput: boolean;
  supportsIsolatedStructuredExecution: boolean;
  supportsToolFreeExecution: boolean;
  supportsNativeImageInput: boolean;
  supportsMcpServers: boolean;
  supportsStrictMcpConfig: boolean;
  supportsAllowedTools: boolean;
  supportsClaudeAllowedTools: boolean;
  supportsOpenCodeAllowedTools: boolean;
  supportsMaxTurns: boolean;
}

function resolveProviderCapabilities(
  provider: ProviderType | undefined,
): ProviderCapabilities | undefined {
  if (provider === undefined) {
    return undefined;
  }

  const providerImpl = getProvider(provider);
  if (providerImpl === undefined) {
    return undefined;
  }
  const mcpTransports = providerImpl.supportedMcpTransports;

  return {
    supportsStructuredOutput: providerImpl.supportsStructuredOutput,
    supportsIsolatedStructuredExecution: providerImpl.supportsIsolatedStructuredExecution === true,
    supportsToolFreeExecution: providerImpl.supportsToolFreeExecution === true,
    supportsNativeImageInput: providerImpl.supportsNativeImageInput,
    supportsMcpServers: mcpTransports !== undefined && mcpTransports.size > 0,
    supportsStrictMcpConfig: providerImpl.supportsStrictMcpConfig === true,
    supportsAllowedTools: ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsClaudeAllowedTools: CLAUDE_ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsOpenCodeAllowedTools: OPENCODE_ALLOWED_TOOLS_PROVIDERS.has(provider),
    supportsMaxTurns: MAX_TURNS_PROVIDERS.has(provider),
  };
}

export function providerSupportsIsolatedStructuredExecution(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsIsolatedStructuredExecution;
}

export function providerSupportsToolFreeExecution(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsToolFreeExecution;
}

export function assertProviderSupportsIsolatedStructuredExecution(
  provider: ProviderType,
): void {
  if (providerSupportsIsolatedStructuredExecution(provider) !== true) {
    throw new Error(`Provider "${provider}" does not support isolated structured execution`);
  }
}

export function providerSupportsStructuredOutput(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsStructuredOutput;
}

export function providerSupportsPermissionControls(
  provider: ProviderType | undefined,
): boolean | undefined {
  if (provider === undefined) {
    return undefined;
  }
  const providerImpl = getProvider(provider);
  if (providerImpl === undefined) {
    return undefined;
  }
  return providerImpl.supportsPermissionControls === undefined
    ? undefined
    : providerImpl.supportsPermissionControls();
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

export function providerSupportsStrictMcpConfig(
  provider: ProviderType | undefined,
): boolean | undefined {
  return resolveProviderCapabilities(provider)?.supportsStrictMcpConfig;
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

export function providerDefaultAllowedToolsWithoutEdit(
  provider: ProviderType | undefined,
): string[] | undefined {
  if (provider === undefined) {
    return undefined;
  }

  const tools = getProvider(provider).getDefaultAllowedToolsWithoutEdit?.();
  return tools === undefined ? undefined : [...tools];
}
