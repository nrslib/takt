/**
 * Codex SDK MCP adapter (issue #1137).
 *
 * Converts resolved servers into the Codex CLI `mcp_servers` config object
 * passed via `CodexOptions.config` (order.md:177-182). stdio servers become
 * `command`/`args`/`env`; Streamable HTTP servers become `url`/`headers`. SSE
 * is not supported by Codex and fails fast in `validate`.
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

export function createCodexMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('codex', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: noopDispose, config: {} };
      }
      const mcpServers = toCodexMcpServers(servers.servers);
      return { dispose: noopDispose, config: { mcp_servers: mcpServers } };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toCodexMcpServers(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toCodexServer(server);
  }
  return result;
}

function toCodexServer(server: McpServerConfig): unknown {
  if (isStdioServer(server)) {
    return {
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    };
  }
  return {
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
  };
}