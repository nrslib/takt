import type { McpServerConfig } from '../../../core/models/workflow-provider-options.js';

export const MCP_HEADER_ENV_REFS = '__taktMcpHeaderEnvRefs' as const;
export type McpHeaderPart = string | { readonly env: string };
export type McpHeaderEnvRefs = Record<string, McpHeaderPart[]>;

type ServerWithHeaderRefs = McpServerConfig & { [MCP_HEADER_ENV_REFS]?: McpHeaderEnvRefs };

export function getMcpHeaderEnvRefs(server: McpServerConfig): McpHeaderEnvRefs {
  return (server as ServerWithHeaderRefs)[MCP_HEADER_ENV_REFS] ?? {};
}

export function interpolateMcpHeaders(
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): { headers: Record<string, string> | undefined; refs: McpHeaderEnvRefs } {
  // Preserve original reference locations; legacy interpolation output must not
  // become a new provider reference when adapters consume the resolved headers.
  const refs: McpHeaderEnvRefs = {};
  if (headers === undefined) return { headers, refs };
  const resolved = Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const parts: McpHeaderPart[] = [];
    let start = 0;
    let scanned = 0;
    let depth = 0;
    for (const match of value.matchAll(/\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      for (; scanned < match.index; scanned++) {
        if (value.startsWith('${', scanned)) { depth++; scanned++; }
        else if (value[scanned] === '}') depth = Math.max(0, depth - 1);
      }
      if (match[1] !== undefined && depth > 0) continue;
      parts.push(value.slice(start, match.index));
      const name = match[2]!;
      if (env[name] === undefined || (match[1] !== undefined && !Object.hasOwn(env, name))) {
        throw new Error(`MCP server configuration references undefined environment variable "${name}"`);
      }
      parts.push(match[1] === undefined ? String(env[name]) : { env: name });
      start = match.index + match[0].length;
      scanned = start;
    }
    parts.push(value.slice(start));
    if (parts.some((part) => typeof part !== 'string')) refs[key] = parts;
    return [key, parts.map((part) => typeof part === 'string' ? part : `\${env:${part.env}}`).join('')];
  }));
  return { headers: resolved, refs };
}

export function attachMcpHeaderEnvRefs(server: McpServerConfig, refs: McpHeaderEnvRefs): McpServerConfig {
  if (Object.keys(refs).length === 0) return server;
  // Match log-safe-source metadata: survive map copies, then strip/project at
  // the provider serialization boundary.
  return { ...server, [MCP_HEADER_ENV_REFS]: refs } as ServerWithHeaderRefs;
}
