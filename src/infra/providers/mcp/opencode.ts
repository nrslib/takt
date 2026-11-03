/**
 * OpenCode SDK MCP adapter (issue #1137).
 *
 * Converts resolved servers into the OpenCode SDK `server` config (local for
 * stdio, remote for http). Different server sets yield different `identity`
 * values so the shared server pool does not mix them (order.md:191-195).
 */

import { createHash } from 'node:crypto';
import { filterMcpHeaderEnvServers } from './header-env.js';
import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
  McpServerConfig,
} from './types.js';
import { isStdioServer } from './types.js';
import { getMcpHeaderEnvRefs } from '../../config/runtime-provider/mcp-header-env.js';
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
      servers = filterMcpHeaderEnvServers('opencode', servers, true);
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: noopDispose };
      }
      const serverConfig = toOpenCodeServerConfig(servers.servers);
      return {
        dispose: noopDispose,
        serverConfig,
        identity: JSON.stringify([
          servers.identity,
          hashOpenCodeHeaders(serverConfig),
        ]),
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function hashOpenCodeHeaders(servers: Record<string, ReturnType<typeof toOpenCodeServer>>): string {
  const headers = Object.keys(servers).sort().flatMap((serverName) => {
    const server = servers[serverName]!;
    if (server.type !== 'remote') return [];
    const values = server.headers ?? {};
    return [[serverName, Object.keys(values).sort().map((name) => [name, values[name]])]];
  });
  return createHash('sha256').update(JSON.stringify(headers)).digest('hex');
}

function toOpenCodeServerConfig(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, ReturnType<typeof toOpenCodeServer>> {
  const result: Record<string, ReturnType<typeof toOpenCodeServer>> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toOpenCodeServer(server);
  }
  return result;
}

function toOpenCodeServer(server: McpServerConfig) {
  if (isStdioServer(server)) {
    return {
      type: 'local' as const,
      command: [server.command, ...(server.args ?? [])],
      ...(server.env !== undefined ? { environment: server.env } : {}),
    };
  }
  const headers = { ...server.headers };
  for (const [name, parts] of Object.entries(getMcpHeaderEnvRefs(server))) {
    headers[name] = parts.map((part) => typeof part === 'string' ? part : `{env:${part.env}}`).join('');
  }
  return {
    type: 'remote' as const,
    url: server.url,
    ...(server.headers !== undefined ? { headers } : {}),
  };
}
