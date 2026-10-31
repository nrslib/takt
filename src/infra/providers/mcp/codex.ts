/**
 * Codex SDK MCP adapter (issue #1137).
 *
 * Converts resolved servers into the Codex CLI `mcp_servers` config object
 * passed via `CodexOptions.config` (order.md:177-182). stdio servers become
 * `command`/`args`/`env`; Streamable HTTP servers become `url`/`http_headers`.
 * SSE is not supported by Codex and fails fast in `validate`.
 */

import { filterMcpHeaderEnvServers, getCodexHeaderEnvRef } from './header-env.js';
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

export function createCodexMcpAdapter(): ProviderMcpAdapter {
  return {
    validate(servers, context) {
      validateTransports('codex', servers, context);
    },
    async prepare(
      servers: ResolvedMcpServers,
      context: ProviderMcpContext,
    ): Promise<PreparedProviderMcp> {
      if (!servers.enabled || Object.keys(servers.servers).length === 0) {
        return { dispose: noopDispose, config: {} };
      }
      const names = new Set(Object.values(servers.servers).flatMap((server) =>
        Object.values(getMcpHeaderEnvRefs(server)).flatMap((parts) =>
          parts.flatMap((part) => typeof part === 'string' ? [] : [part.env]))));
      const selected = filterMcpHeaderEnvServers('codex', servers, true);
      const excludedServerNames = selected.excludedServerNames ?? [];
      const mcpServers = toCodexMcpServers(selected.servers, context.toolApprovalAllowlist, context.approvedServerNames);
      return {
        dispose: noopDispose,
        ...(excludedServerNames.length === 0 ? {} : { excludedServerNames }),
        config: {
          ...(Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
          ...(names.size === 0 ? {} : { shell_environment_policy: {
            filters: Object.fromEntries([...names].map((name) => [name, 'exclude' as const])),
          } }),
        },
      };
    },
    classifyFailure(error) {
      return classifyMcpFailure(error);
    },
  };
}

function toCodexMcpServers(
  servers: Record<string, ResolvedMcpServers['servers'][string]>,
  toolApprovalAllowlist: ProviderMcpContext['toolApprovalAllowlist'],
  approvedServerNames: ProviderMcpContext['approvedServerNames'],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const tools = toolApprovalAllowlist !== undefined && Object.hasOwn(toolApprovalAllowlist, name)
      ? toolApprovalAllowlist[name] : undefined;
    result[name] = {
      ...toCodexServer(server),
      ...(approvedServerNames?.includes(name) ? { default_tools_approval_mode: 'approve' } : {}),
      ...(tools === undefined ? {} : { tools: Object.fromEntries(tools.map((tool) => [tool, { approval_mode: 'approve' }])) }),
    };
  }
  return result;
}

function toCodexServer(server: McpServerConfig): Record<string, unknown> {
  if (isStdioServer(server)) {
    return {
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    };
  }
  const refs = getMcpHeaderEnvRefs(server);
  const headers = { ...server.headers };
  const envHeaders: Record<string, string> = {};
  let bearerName: string | undefined;
  for (const [header, parts] of Object.entries(refs)) {
    const ref = getCodexHeaderEnvRef(parts);
    if (ref === undefined) throw new Error('Unsupported Codex MCP header reference');
    if (ref.bearer) bearerName = ref.name;
    else envHeaders[header] = ref.name;
    delete headers[header];
  }
  return {
    url: server.url,
    ...(server.headers === undefined || (Object.keys(headers).length === 0 && Object.keys(refs).length > 0)
      ? {} : { http_headers: headers }),
    ...(bearerName === undefined ? {} : { bearer_token_env_var: bearerName }),
    ...(Object.keys(envHeaders).length === 0 ? {} : { env_http_headers: envHeaders }),
  };
}
