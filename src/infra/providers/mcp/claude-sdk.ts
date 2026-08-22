/**
 * Claude Agent SDK MCP adapter (issue #1137).
 *
 * Passes resolved servers to the SDK's `mcpServers` option with
 * `strictMcpConfig: true` so project/user/plugin MCP config is not silently
 * loaded (order.md:159-161).
 */

import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
  McpServerConfig,
} from './types.js';
import { isStdioServer } from './types.js';
import { validateTransports, noopDispose, classifyMcpFailure } from './adapter.js';

export function createClaudeSdkMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('claude-sdk', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        // Empty set: MCP is disabled (order.md:152) so no `mcpServers` option
        // is passed, but `strictMcpConfig: true` is still emitted so ambient
        // project/user/plugin MCP config is not silently loaded
        // (order.md:160). The adapter does not know whether runtime MCP mode
        // is active; the runner boundary decides whether to call `prepare`
        // at all for an empty set.
        return { dispose: noopDispose, sdkOptions: { strictMcpConfig: true } };
      }
      const mcpServers = toSdkMcpServers(servers.servers);
      return {
        dispose: noopDispose,
        sdkOptions: { mcpServers, strictMcpConfig: true },
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toSdkMcpServers(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toSdkServer(server);
  }
  return result;
}

function toSdkServer(server: McpServerConfig): unknown {
  if (isStdioServer(server)) {
    return {
      type: 'stdio',
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    };
  }
  return {
    type: server.type,
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
  };
}