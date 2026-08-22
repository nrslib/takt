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
}).strict();

const McpSseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();

const McpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
}).strict();

export const McpServerEntrySchema = z.union([
  McpStdioServerSchema,
  McpSseServerSchema,
  McpHttpServerSchema,
]);

export const McpServersMapSchema = z.record(z.string(), McpServerEntrySchema);

/** `defaults.servers` is a plain string array referencing server names. */
const McpDefaultsSchema = z.object({
  servers: z.array(z.string()),
}).strict();

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

function assertKnownServer(
  serverName: string,
  knownServers: ReadonlySet<string>,
  context: string,
): void {
  if (!knownServers.has(serverName)) {
    throw new Error(
      `MCP target ${context} references unknown server "${serverName}". Defined servers: ${[...knownServers].sort().join(', ') || '(none)'}`,
    );
  }
}

function validateTargetMap(
  targetMap: Record<string, McpTargetEntry> | undefined,
  selector: 'personas' | 'tags' | 'steps',
  knownServers: ReadonlySet<string>,
): void {
  for (const [targetName, target] of Object.entries(targetMap ?? {})) {
    for (const serverName of target.servers ?? []) {
      assertKnownServer(serverName, knownServers, `${selector}.${targetName}.servers`);
    }
    for (const serverName of target.exclude ?? []) {
      assertKnownServer(serverName, knownServers, `${selector}.${targetName}.exclude`);
    }
  }
}

/** Validate every server reference before any agent target is selected. */
export function validateMcpSectionReferences(section: McpSection): void {
  const knownServers = new Set(Object.keys(section.servers ?? {}));
  for (const serverName of section.defaults?.servers ?? []) {
    assertKnownServer(serverName, knownServers, 'defaults.servers');
  }
  validateTargetMap(section.targets?.personas, 'personas', knownServers);
  validateTargetMap(section.targets?.tags, 'tags', knownServers);
  validateTargetMap(section.targets?.steps, 'steps', knownServers);
  for (const serverName of section.targets?.internal_agents?.selector?.exclude ?? []) {
    assertKnownServer(serverName, knownServers, 'internal_agents.selector.exclude');
  }
}

const ENV_REF_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ORIGINAL_MCP_SERVER = new WeakMap<object, McpServerConfig>();

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
  const originalServer = ORIGINAL_MCP_SERVER.get(server) ?? server;
  let resolvedServer: McpServerConfig;
  if (isStdio(server)) {
    resolvedServer = {
      type: 'stdio',
      command: interpolateString(server.command, env),
      args: interpolateArray(server.args, env),
      env: interpolateRecord(server.env, env),
    };
  } else if (isSse(server)) {
    resolvedServer = {
      type: 'sse',
      url: interpolateString(server.url, env),
      headers: interpolateRecord(server.headers, env),
    };
  } else {
    resolvedServer = {
      type: 'http',
      url: interpolateString((server as McpHttpServerConfig).url, env),
      headers: interpolateRecord((server as McpHttpServerConfig).headers, env),
    };
  }
  ORIGINAL_MCP_SERVER.set(resolvedServer, originalServer);
  return resolvedServer;
}

/** Placeholder used in place of secret values in log-safe representations. */
const REDACTED = '<redacted>';

const SECRET_ARGUMENT_NAME = /(?:token|secret|password|passphrase|api[-_]?key|authorization|credential)/i;

function redactMcpArgs(args: string[] | undefined): string[] | undefined {
  if (args === undefined) {
    return undefined;
  }
  const result: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      result.push(REDACTED);
      redactNext = false;
      continue;
    }
    const delimiter = arg.search(/[=:]/);
    const argumentName = delimiter >= 0 ? arg.slice(0, delimiter) : arg;
    if (!SECRET_ARGUMENT_NAME.test(argumentName)) {
      result.push(arg);
      continue;
    }
    if (delimiter >= 0) {
      result.push(arg.slice(0, delimiter + 1) + REDACTED);
    } else {
      result.push(arg);
      redactNext = true;
    }
  }
  return result;
}

function redactMcpUrl(url: string): string {
  // Remove URL userinfo without changing the endpoint path. The original
  // interpolation source is already safe, but literal credentials must also
  // never reach logs or session/cache identities.
  return url.replace(/(\/\/)[^/?#@]+@/, (_match, prefix: string) => prefix + REDACTED + '@');
}

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
 * Return a log-safe representation of a server entry. Environment/header values,
 * URL userinfo, and authentication argument values are redacted (order.md:110).
 */
export function redactMcpServerForLog(server: McpServerConfig): Record<string, unknown> {
  const logSafeSource = ORIGINAL_MCP_SERVER.get(server) ?? server;
  if (isStdio(logSafeSource)) {
    return {
      type: 'stdio',
      command: logSafeSource.command,
      args: redactMcpArgs(logSafeSource.args),
      env: redactRecord(logSafeSource.env),
    };
  }
  const remote = isSse(logSafeSource) ? logSafeSource : (logSafeSource as McpHttpServerConfig);
  return {
    type: remote.type,
    url: redactMcpUrl(remote.url),
    headers: redactRecord(remote.headers),
  };
}

/**
 * Build a deterministic identity for a resolved server. The identity includes
 * the server name and non-secret command/args or URL, while excluding env and
 * headers. Interpolated servers use their pre-interpolation structure so a
 * secret rotation does not change the identity (order.md:270,335).
 */
export function buildMcpServerIdentity(
  serverName: string,
  server: McpServerConfig,
): string {
  const identitySource = ORIGINAL_MCP_SERVER.get(server) ?? server;
  if (isStdio(identitySource)) {
    return JSON.stringify([
      serverName,
      {
        type: 'stdio',
        command: identitySource.command,
        args: redactMcpArgs(identitySource.args) ?? [],
      },
    ]);
  }
  const remote = isSse(identitySource)
    ? identitySource
    : (identitySource as McpHttpServerConfig);
  return JSON.stringify([
    serverName,
    { type: remote.type, url: redactMcpUrl(remote.url) },
  ]);
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
