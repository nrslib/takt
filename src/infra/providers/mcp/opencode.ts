/**
 * OpenCode SDK MCP adapter (issue #1137).
 *
 * Converts resolved servers into the OpenCode SDK `server` config (local for
 * stdio, remote for http). Different server sets yield different `identity`
 * values so the shared server pool does not mix them (order.md:191-195).
 */

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
          Object.keys(servers.servers).sort().map((serverName) => {
            const refs = getMcpHeaderEnvRefs(servers.servers[serverName]!);
            return [serverName, Object.keys(refs).sort().map((headerName) => [
              headerName,
              refs[headerName]!.filter((part) => typeof part !== 'string').map((part) => part.env),
            ])];
          }),
        ]),
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
  const headers = { ...server.headers };
  for (const [name, parts] of Object.entries(getMcpHeaderEnvRefs(server))) {
    headers[name] = parts.map((part) => typeof part === 'string' ? part : `{env:${part.env}}`).join('');
  }
  return {
    type: 'remote',
    url: server.url,
    ...(server.headers !== undefined ? { headers } : {}),
  };
}
