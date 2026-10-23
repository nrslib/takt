/**
 * Cursor CLI MCP adapter (issue #1137).
 *
 * Cursor CLI reads workspace `.cursor/mcp.json`. The adapter writes an
 * isolated config root so the user's `.cursor/mcp.json` is never touched
 * (order.md:203-207). When no servers are assigned, no config root is created.
 */

import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { filterMcpHeaderEnvServers } from './header-env.js';
import { prepareCursorMcpExclusions } from './cursor-settings.js';
import { CURSOR_MCP_CONFIG_PATH } from './cursor-native-config.js';
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
import { buildEnvWithNestedObservabilitySnapshot } from '../../../shared/telemetry/index.js';

export function createCursorMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('cursor', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      const selected = filterMcpHeaderEnvServers('cursor', servers, true);
      servers = selected;
      const excludedNames = selected.excludedServerNames ?? [];
      if (excludedNames.length > 0 && Object.keys(servers.servers).length === 0) {
        const dataRoot = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-cursor-data-'));
        try {
          const env = await prepareCursorMcpExclusions(context.cwd, dataRoot, excludedNames,
            buildEnvWithNestedObservabilitySnapshot(process.env, context.childProcessEnv));
          return {
            env,
            excludedServerNames: excludedNames,
            dispose: onceDispose(async () => { await rm(dataRoot, { recursive: true, force: true }); }),
          };
        } catch (error) {
          await rm(dataRoot, { recursive: true, force: true });
          throw error;
        }
      }
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: () => Promise.resolve() };
      }
      const configRoot = await mkdtemp(join(ensureCurrentTmpDirExists(), 'takt-cursor-mcp-'));
      let env: Readonly<Record<string, string>> | undefined;
      try {
        await chmod(configRoot, 0o700);
        const configPath = join(configRoot, CURSOR_MCP_CONFIG_PATH);
        await mkdir(dirname(configPath), { recursive: true });
        const payload = toCursorMcpJson(servers.servers);
        await writeFile(configPath, JSON.stringify(payload), { mode: 0o600 });
        if (excludedNames.length > 0) {
          env = await prepareCursorMcpExclusions(context.cwd, join(configRoot, 'data'), excludedNames,
            buildEnvWithNestedObservabilitySnapshot(process.env, context.childProcessEnv), configRoot);
        }
      } catch (error) {
        await rm(configRoot, { recursive: true, force: true });
        throw error;
      }
      return {
        configRoot,
        ...(env === undefined ? {} : { env, excludedServerNames: excludedNames }),
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
