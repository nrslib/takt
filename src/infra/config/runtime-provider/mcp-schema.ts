/**
 * Zod schema for the runtime.yaml `mcp` section (issue #1137).
 *
 * The `mcp` section is a top-level sibling of `provider` (order.md:36). It owns
 * `servers`, `defaults`, and `targets`. `targets` exposes only the four
 * documented selectors (`personas` / `tags` / `steps` / `internal_agents`); the
 * `internal_agents` target carries a single `selector.exclude` list that applies
 * a common exclude to both internal agents (order.md:76-80).
 *
 * Env interpolation, secret redaction, and identity construction live here so
 * every consumer (loader, assignment resolver, provider adapters) shares a
 * single source of truth for the resolved server shape.
 */

import { z } from 'zod';
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSseServerConfig,
  McpHttpServerConfig,
} from '../../../core/models/workflow-provider-options.js';

/** MCP transport types accepted by the common schema. */
export type McpTransport = 'stdio' | 'sse' | 'http';

function isStdio(server: McpServerConfig): server is McpStdioServerConfig {
  return server.type === 'stdio' || server.type === undefined;
}

function isSse(server: McpServerConfig): server is McpSseServerConfig {
  return server.type === 'sse';
}

const McpStdioServerSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpSseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

export const McpServerEntrySchema = z.union([
  McpStdioServerSchema,
  McpSseServerSchema,
  McpHttpServerSchema,
]);

export const McpServersMapSchema = z.record(z.string(), McpServerEntrySchema);

/** `defaults.servers` is a plain string array referencing server names. */
const McpDefaultsSchema = z.object({
  servers: z.array(z.string()),
});

/** `personas`/`tags`/`steps` targets share the same `servers`/`exclude` shape. */
const McpTargetEntrySchema = z.object({
  servers: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).strict();

/**
 * `internal_agents` differs from the other three selectors: it only carries a
 * `selector.exclude` list (order.md:76-80). Any other field is rejected.
 */
const McpInternalAgentsSchema = z.object({
  selector: z.object({
    exclude: z.array(z.string()).optional(),
  }).strict(),
}).strict();

const McpTargetsSchema = z.object({
  personas: z.record(z.string(), McpTargetEntrySchema).optional(),
  tags: z.record(z.string(), McpTargetEntrySchema).optional(),
  steps: z.record(z.string(), McpTargetEntrySchema).optional(),
  internal_agents: McpInternalAgentsSchema.optional(),
}).strict();

export const McpSectionSchema = z.object({
  servers: McpServersMapSchema.optional(),
  defaults: McpDefaultsSchema.optional(),
  targets: McpTargetsSchema.optional(),
}).strict();

export type McpSection = z.infer<typeof McpSectionSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
export type McpDefaults = z.infer<typeof McpDefaultsSchema>;
export type McpTargets = z.infer<typeof McpTargetsSchema>;
export type McpTargetEntry = z.infer<typeof McpTargetEntrySchema>;

const ENV_REF_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function interpolateString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REF_PATTERN, (match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new Error(
        `MCP server configuration references undefined environment variable "${name}"`,
      );
    }
    return resolved;
  });
}

function interpolateRecord(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (record === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = interpolateString(value, env);
  }
  return result;
}

function interpolateArray(
  list: string[] | undefined,
  env: NodeJS.ProcessEnv,
): string[] | undefined {
  if (list === undefined) {
    return undefined;
  }
  return list.map((value) => interpolateString(value, env));
}

/**
 * Resolve `${VAR}` references in a server entry against `process.env` (or an
 * explicit env source). Fails fast when a required env var is undefined; never
 * silently substitutes an empty string (order.md:110).
 */
export function interpolateMcpEnv(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  if (isStdio(server)) {
    return {
      type: 'stdio',
      command: interpolateString(server.command, env),
      args: interpolateArray(server.args, env),
      env: interpolateRecord(server.env, env),
    };
  }
  if (isSse(server)) {
    return {
      type: 'sse',
      url: interpolateString(server.url, env),
      headers: interpolateRecord(server.headers, env),
    };
  }
  return {
    type: 'http',
    url: interpolateString((server as McpHttpServerConfig).url, env),
    headers: interpolateRecord((server as McpHttpServerConfig).headers, env),
  };
}

/** Placeholder used in place of secret values in log-safe representations. */
const REDACTED = '<redacted>';

function redactRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (record === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    result[key] = REDACTED;
  }
  return result;
}

/**
 * Return a log-safe representation of a server entry. `env` and `headers` values
 * are replaced with `<redacted>`; structural fields (`command`, `args`, `url`,
 * `type`) are preserved because they are not secret (order.md:110).
 */
export function redactMcpServerForLog(server: McpServerConfig): Record<string, unknown> {
  if (isStdio(server)) {
    return {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: redactRecord(server.env),
    };
  }
  const remote = isSse(server) ? server : (server as McpHttpServerConfig);
  return {
    type: remote.type,
    url: remote.url,
    headers: redactRecord(remote.headers),
  };
}

/**
 * Build a deterministic identity for a resolved server. The identity carries
 * only the server name and transport — never token/header/env resolved values
 * (order.md:270,335). Two servers with the same name+transport but different
 * secrets share the same identity so sessions remain stable across secret
 * rotations.
 */
export function buildMcpServerIdentity(
  serverName: string,
  server: McpServerConfig,
): string {
  const transport = server.type ?? 'stdio';
  return `${serverName}:${transport}`;
}

/**
 * Build a sorted, order-independent identity for a set of resolved servers.
 * Used by session/cache/pool keys to ensure different MCP sets never share a
 * session (order.md:269,333).
 */
export function buildMcpServerSetIdentity(
  servers: Record<string, McpServerConfig>,
): string {
  const identities = Object.entries(servers)
    .map(([name, server]) => buildMcpServerIdentity(name, server))
    .sort();
  return identities.join(',');
}