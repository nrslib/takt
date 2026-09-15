import type { McpServerConfig } from './types.js';

/**
 * Server records created by the interactive task-state integration are kept
 * in a private identity set. Provider adapters must not infer this capability
 * from a server name or from command arguments supplied by a caller.
 */
const trustedTaskStateMcpServerRecords = new WeakSet<object>();

export function markTaskStateMcpServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  trustedTaskStateMcpServerRecords.add(servers);
  return servers;
}

export function isTrustedTaskStateMcpServers(value: unknown): value is Record<string, McpServerConfig> {
  return typeof value === 'object' && value !== null && trustedTaskStateMcpServerRecords.has(value);
}
