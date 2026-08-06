/**
 * Kiro CLI MCP adapter (issue #1137).
 *
 * Generates a temp Kiro MCP config and passes it with `--require-mcp-startup`
 * so connection failures fail fast (order.md:228-232). The user's existing
 * Kiro settings are never overwritten. The temp config is removed on `dispose`
 * (success/failure/abort/timeout).
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProviderMcpAdapter,
  ProviderMcpContext,
  PreparedProviderMcp,
  ResolvedMcpServers,
  McpServerConfig,
} from './types.js';
import { isStdioServer } from './types.js';
import { validateTransports, onceDispose, classifyMcpFailure } from './adapter.js';
import { ensureCurrentTmpDirExists } from '../../../shared/utils/index.js';

export function createKiroMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('kiro', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: () => Promise.resolve(), args: [] };
      }
      const tempDir = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-kiro-mcp-'));
      const configPath = join(tempDir, 'mcp.json');
      try {
        await chmod(tempDir, 0o700);
        const payload = toKiroMcpJson(servers.servers);
        await writeFile(configPath, JSON.stringify(payload), { mode: 0o600 });
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        throw error;
      }
      return {
        args: ['--require-mcp-startup', '--mcp-config', configPath],
        path: configPath,
        dispose: onceDispose(async () => {
          await rm(tempDir, { recursive: true, force: true });
        }),
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toKiroMcpJson(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toKiroServer(server);
  }
  return { mcpServers: result };
}

function toKiroServer(server: McpServerConfig): unknown {
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