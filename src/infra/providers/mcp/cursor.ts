/**
 * Cursor CLI MCP adapter (issue #1137).
 *
 * Cursor CLI reads workspace `.cursor/mcp.json`. The adapter writes an
 * isolated config root so the user's `.cursor/mcp.json` is never touched
 * (order.md:203-207). When no servers are assigned, no config root is created.
 */

import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
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

export function createCursorMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('cursor', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      _context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: () => Promise.resolve() };
      }
      const configRoot = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-cursor-mcp-'));
      try {
        await chmod(configRoot, 0o700);
        const cursorDir = join(configRoot, '.cursor');
        await mkdir(cursorDir, { recursive: true });
        const configPath = join(cursorDir, 'mcp.json');
        const payload = toCursorMcpJson(servers.servers);
        await writeFile(configPath, JSON.stringify(payload), { mode: 0o600 });
      } catch (error) {
        await rm(configRoot, { recursive: true, force: true });
        throw error;
      }
      return {
        configRoot,
        dispose: onceDispose(async () => {
          await rm(configRoot, { recursive: true, force: true });
        }),
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toCursorMcpJson(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toCursorServer(server);
  }
  return { mcpServers: result };
}

function toCursorServer(server: McpServerConfig): unknown {
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