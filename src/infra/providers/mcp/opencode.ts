/**
 * OpenCode SDK MCP adapter (issue #1137).
 *
 * Converts resolved servers into the OpenCode SDK `server` config (local for
 * stdio, remote for http). Different server sets yield different `identity`
 * values so the shared server pool does not mix them (order.md:191-195).
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

export function createOpenCodeMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('opencode', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: noopDispose };
      }
      const serverConfig = toOpenCodeServerConfig(servers.servers);
      return {
        dispose: noopDispose,
        serverConfig,
        identity: servers.identity,
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toOpenCodeServerConfig(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toOpenCodeServer(server);
  }
  return result;
}

function toOpenCodeServer(server: McpServerConfig): unknown {
  if (isStdioServer(server)) {
    return {
      type: 'local',
      command: [server.command, ...(server.args ?? [])],
      ...(server.env !== undefined ? { environment: server.env } : {}),
    };
  }
  return {
    type: 'remote',
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
  };
}