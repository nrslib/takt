import * as process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../../core/models/index.js';
import { createMcpAdapter, type ResolvedMcpServers } from '../../infra/providers/mcp/index.js';
import { markTaskStateMcpServers } from '../../infra/providers/mcp/task-state.js';
import { providerSupportsMcpServers } from '../../infra/providers/provider-capabilities.js';
import { buildMcpServerSetIdentity } from '../../infra/config/runtime-provider/mcp-schema.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getLabel } from '../../shared/i18n/index.js';

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
  });
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
  readonly unavailableNotice?: string;
}

/**
 * Resolve the assistant's read-only task-state server once per conversation
 * plan. Unsupported providers keep the conversation usable and receive a
 * visible capability notice instead of reaching the provider call first.
 */
export function resolveTaskStateMcp(
  provider: ProviderType,
  lang: 'en' | 'ja',
): TaskStateMcpResolution {
  const servers = createTaskStateMcpServers();
  if (providerSupportsMcpServers(provider) !== true) {
    return {
      unavailableNotice: getLabel(
        'interactive.mcpUnavailable',
        lang,
        { provider, error: `Provider "${provider}" does not support MCP servers` },
      ),
    };
  }

  // A provider that declares MCP support must fail during plan creation when
  // this generated configuration is invalid. Only unsupported providers are
  // converted into a capability notice.
  createMcpAdapter(provider).validate(resolveTaskStateMcpServers(servers));
  return { servers };
}
