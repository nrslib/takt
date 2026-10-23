import type { ProviderType } from '../../../shared/types/provider.js';
import { warn } from '../../../shared/ui/LogManager.js';
import { buildMcpServerSetIdentity } from '../../config/runtime-provider/mcp-schema.js';
import { getMcpHeaderEnvRefs, type McpHeaderPart } from '../../config/runtime-provider/mcp-header-env.js';
import type { McpServerConfig, ResolvedMcpServers } from './types.js';

export function getCodexHeaderEnvRef(parts: McpHeaderPart[]): { name: string; bearer: boolean } | undefined {
  const variables = parts.filter((part) => typeof part !== 'string');
  if (variables.length !== 1) return undefined;
  const variableIndex = parts.findIndex((part) => typeof part !== 'string');
  const prefix = parts.slice(0, variableIndex).join('');
  const suffix = parts.slice(variableIndex + 1).join('');
  if (suffix !== '' || (prefix !== '' && prefix !== 'Bearer ')) return undefined;
  return { name: variables[0]!.env, bearer: prefix === 'Bearer ' };
}

function unsupportedReason(provider: ProviderType, server: McpServerConfig): string | undefined {
  const refs = Object.entries(getMcpHeaderEnvRefs(server));
  if (refs.length === 0) return undefined;
  if (provider === 'opencode') return undefined;
  if (provider !== 'codex') return 'provider header environment references have not been verified for this execution path';
  for (const [header, parts] of refs) {
    const ref = getCodexHeaderEnvRef(parts);
    if (ref === undefined || (ref.bearer && header.toLowerCase() !== 'authorization')) {
      return 'header environment reference cannot be represented by Codex';
    }
  }
  return undefined;
}

export function filterMcpHeaderEnvServers(
  provider: ProviderType,
  servers: ResolvedMcpServers,
  emitWarnings: boolean,
): ResolvedMcpServers & { excludedServerNames?: string[] } {
  const entries = Object.entries(servers.servers);
  const excludedServerNames: string[] = [];
  const kept = entries.filter(([name, server]) => {
    const reason = unsupportedReason(provider, server);
    if (reason === undefined) return true;
    excludedServerNames.push(name);
    if (emitWarnings) warn(`Provider "${provider}" excluded MCP server "${name}": ${reason}`);
    return false;
  });
  if (kept.length === entries.length) return servers;
  const effective = Object.fromEntries(kept);
  return {
    excludedServerNames,
    enabled: kept.length > 0, servers: effective,
    serverNames: Object.keys(effective).sort(), identity: buildMcpServerSetIdentity(effective),
  };
}
