import * as process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../../core/models/index.js';
import { TAKT_MCP_READ_ONLY_TOOL_NAMES } from '../mcp/server.js';
import { createMcpAdapter, type ResolvedMcpServers } from '../../infra/providers/mcp/index.js';
import { markConversationMcpServers, markTaskStateMcpServers } from '../../infra/providers/mcp/task-state.js';
import { providerSupportsMcpServers } from '../../infra/providers/provider-capabilities.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { getGlobalConfigDir, getProjectConfigDir } from '../../infra/config/paths.js';
import { resolveInvocationRuntimeProviderFileWithOrigins } from '../../infra/config/runtime-provider/invocation.js';
import { resolveInternalAgentMcpServers } from '../../infra/config/runtime-provider/mcp-assignment.js';

/**
 * The interactive assistant may inspect task state, but it must never receive
 * the enqueue or intervention-writing tools. The compiled MCP entrypoint is
 * resolved relative to this module so a globally installed `takt` does not
 * depend on the caller's PATH.
 */
export function createTaskStateMcpServers(): Record<string, McpServerConfig> {
  const entrypoint = resolve(fileURLToPath(new URL('../../app/mcp/index.js', import.meta.url)));
  return markTaskStateMcpServers({
    takt: {
      type: 'stdio',
      command: process.execPath,
      args: [entrypoint, '--tool-set', 'read-only', '--include-reference-markers'],
    },
  }, TAKT_MCP_READ_ONLY_TOOL_NAMES);
}

function resolveTaskStateMcpServers(
  servers: Record<string, McpServerConfig>,
): ResolvedMcpServers {
  return {
    enabled: true,
    servers,
    serverNames: Object.keys(servers).sort(),
    identity: buildMcpServerSetIdentity(servers),
  };
}

export interface TaskStateMcpResolution {
  readonly servers?: Record<string, McpServerConfig>;
  readonly taskStateServers?: Record<string, McpServerConfig>;
  readonly unavailableNotice?: string;
}

/**
 * Resolve the assistant's read-only task-state server once per conversation
 * plan. Unsupported providers keep the conversation usable and receive a
 * visible capability notice instead of reaching the provider call first.
 */
export function resolveTaskStateMcp(
  cwd: string,
  provider: ProviderType,
  lang: 'en' | 'ja',
  includeAssistantMcpServers: boolean,
): TaskStateMcpResolution {
  if (providerSupportsMcpServers(provider) !== true) {
    return {
      unavailableNotice: getLabel(
        'interactive.mcpUnavailable',
        lang,
        { provider, error: `Provider "${provider}" does not support MCP servers` },
      ),
    };
  }

  const taskStateServers = createTaskStateMcpServers();
  if (!includeAssistantMcpServers) {
    createMcpAdapter(provider).validate(resolveTaskStateMcpServers(taskStateServers));
    return { servers: taskStateServers, taskStateServers };
  }
  const { runtimeFile } = resolveInvocationRuntimeProviderFileWithOrigins({
    globalConfigDir: getGlobalConfigDir(), projectConfigDir: getProjectConfigDir(cwd),
  });
  const assigned = resolveInternalAgentMcpServers(runtimeFile?.mcp, 'assistant').servers;
  const userEntries = Object.entries(assigned).filter(([name]) => name !== 'takt');
  const servers = userEntries.length === 0
    ? taskStateServers
    : markConversationMcpServers({ ...Object.fromEntries(userEntries), ...taskStateServers });

  // A provider that declares MCP support must fail during plan creation when
  // this generated configuration is invalid. Only unsupported providers are
  // converted into a capability notice.
  createMcpAdapter(provider).validate(resolveTaskStateMcpServers(servers));
  return { servers, taskStateServers };
}
