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
import { validateTransports, onceDispose, noopDispose, classifyMcpFailure } from './adapter.js';
import { isTrustedConversationMcpServers, isTrustedTaskStateMcpServers } from './task-state.js';
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
        return { dispose: noopDispose, args: [] };
      }
      // Only conversation-owned records and the generated task-state record
      // may bypass the general readonly restriction.
      const hasTrustedTaskStateServers = context.permissionMode === 'readonly'
        && context.taskStateMcpServers === servers.servers
        && isTrustedTaskStateMcpServers(context.taskStateMcpServers);
      if (context.permissionMode === 'readonly' && !hasTrustedTaskStateServers
        && !isTrustedConversationMcpServers(servers.servers)) {
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
        args: [`--additional-mcp-config=@${configPath}`, ...toCopilotMcpToolAllowances(context)],
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

/**
 * The client passes no allow-all flag in readonly or without a permission mode,
 * so the approved MCP tools are named with `--allow-tool`, which the GitHub
 * Copilot CLI documentation describes as allowing a specific tool without
 * asking for approval. A bare server name covers every tool of that server and
 * `server(tool)` covers one tool
 * (https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli).
 * `edit` and `full` already allow every tool, and workflow steps carry no
 * approvals, so nothing is added for them.
 */
function toCopilotMcpToolAllowances(context: ProviderMcpContext): string[] {
  if (context.permissionMode !== undefined && context.permissionMode !== 'readonly') {
    return [];
  }
  const wholeServers = (context.approvedServerNames ?? []).map((name) => `--allow-tool=${name}`);
  const individualTools = Object.entries(context.toolApprovalAllowlist ?? {})
    .flatMap(([server, tools]) => tools.map((tool) => `--allow-tool=${server}(${tool})`));
  return [...wholeServers, ...individualTools];
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
    type: server.type,
    url: server.url,
    ...(server.headers !== undefined ? { headers: server.headers } : {}),
  };
}
