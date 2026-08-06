/**
 * GitHub Copilot CLI MCP adapter (issue #1137).
 *
 * Generates a temp MCP JSON file and passes it via
 * `--additional-mcp-config=@<path>` (order.md:216-219). The user's
 * `~/.copilot/mcp-config.json` is never modified. The temp file is removed on
 * `dispose` (success/failure/abort/timeout).
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

export function createCopilotMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('copilot', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: () => Promise.resolve(), args: [] };
      }
      // MCP tool approval must not contradict TAKT's permission mode
      // (order.md:220). A readonly execution must not enable MCP servers
      // because MCP tools can have side effects the permission mode forbids.
      if (context.permissionMode === 'readonly') {
        throw new Error(
          'Copilot MCP adapter cannot prepare MCP servers under readonly permission mode: MCP tools may have side effects that contradict the permission mode (order.md:220)',
        );
      }
      const tempDir = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-copilot-mcp-'));
      const configPath = join(tempDir, 'additional-mcp-config.json');
      try {
        await chmod(tempDir, 0o700);
        const payload = toCopilotMcpJson(servers.servers);
        await writeFile(configPath, JSON.stringify(payload), { mode: 0o600 });
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        throw error;
      }
      return {
        args: [`--additional-mcp-config=@${configPath}`],
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

function toCopilotMcpJson(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = toCopilotServer(server);
  }
  return { mcpServers: result };
}

function toCopilotServer(server: McpServerConfig): unknown {
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