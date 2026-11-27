import type { McpServerConfig } from './types.js';

/**
 * Server records created by the interactive task-state integration are kept
 * in a private identity set. Provider adapters must not infer this capability
 * from a server name or from command arguments supplied by a caller.
 */
const trustedTaskStateMcpServerRecords = new WeakSet<object>();
const trustedTaskStateMcpToolNames = new WeakMap<object, readonly string[]>();
const trustedConversationMcpServerRecords = new WeakSet<object>();

export function markConversationMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  trustedConversationMcpServerRecords.add(servers);
  return servers;
}

export function isTrustedConversationMcpServers(value: unknown): boolean {
  return typeof value === 'object' && value !== null && trustedConversationMcpServerRecords.has(value);
}

export function markTaskStateMcpServers(
  servers: Record<string, McpServerConfig>,
  readOnlyToolNames: readonly string[],
): Record<string, McpServerConfig> {
  trustedTaskStateMcpServerRecords.add(servers);
  trustedTaskStateMcpToolNames.set(servers, readOnlyToolNames);
  return servers;
}

export function isTrustedTaskStateMcpServers(value: unknown): value is Record<string, McpServerConfig> {
  return typeof value === 'object' && value !== null && trustedTaskStateMcpServerRecords.has(value);
}

/**
 * Resolve the raw (server-local) names of the trusted task-state read-only
 * tools. Provider adapters that approve tools per server (for example Codex)
 * consume these names directly.
 */
export function resolveTrustedTaskStateMcpToolNames(
  value: unknown,
): readonly string[] | undefined {
  if (!isTrustedTaskStateMcpServers(value)) {
    return undefined;
  }
  return trustedTaskStateMcpToolNames.get(value);
}

/**
 * Resolve the provider-facing names for the trusted task-state read-only
 * tools. The returned names use the Claude-compatible MCP convention because
 * that is the common allowlist format accepted by the provider boundary.
 */
export function resolveTrustedTaskStateMcpAllowedTools(
  value: unknown,
): readonly string[] | undefined {
  return resolveTrustedTaskStateMcpToolNames(value)?.map((toolName) => `mcp__takt__${toolName}`);
}
