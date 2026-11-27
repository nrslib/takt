import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod/v4';

export const CURSOR_MCP_CONFIG_PATH = join('.cursor', 'mcp.json');

// Native normalization and field order participate in Cursor's approval hash.
const nativeStdioServer = z.object({
    type: z.literal('stdio').optional(), command: z.string(), args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(), envFile: z.string().optional(), cwd: z.string().optional(),
    enabledTools: z.array(z.string()).optional(), startupTimeoutSec: z.number().int().optional().catch(undefined),
  });
const nativeServer = z.union([
  nativeStdioServer,
  z.object({
    type: z.enum(['http', 'sse']).optional(), url: z.string(), headers: z.record(z.string(), z.string()).optional(),
    auth: z.object({ CLIENT_ID: z.string(), CLIENT_SECRET: z.string().optional(), scopes: z.array(z.string()).optional() }).optional(),
    tls: z.strictObject({ caBundle: z.string().trim().min(1).max(131072) }).optional(),
    placement: z.enum(['server', 'client']).optional(), enabledTools: z.array(z.string()).optional(),
  }),
]);
const nativeConfig = z.object({ mcpServers: z.record(z.string(), nativeServer) });
type NativeServer = z.infer<typeof nativeServer>;

function expand(value: unknown, environment: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g,
      (original: string, providerName: string | undefined, name: string | undefined, fallback: string | undefined) => {
        if (providerName !== undefined) return environment[providerName] ?? original;
        return name === undefined ? original : environment[name] ?? fallback ?? original;
      });
  }
  if (Array.isArray(value)) return value.map((child: unknown) => expand(child, environment));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, expand(child, environment)]));
  }
  return value;
}

export async function readCursorProjectServers(root: string, environment: NodeJS.ProcessEnv): Promise<Record<string, NativeServer>> {
  try {
    const jsonc = await readFile(join(root, CURSOR_MCP_CONFIG_PATH), 'utf8');
    // Preserve quoted strings while removing JSONC comments and trailing commas.
    const withoutComments = jsonc.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      (token) => token.startsWith('"') ? token : ' ');
    const json = withoutComments.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g,
      (token, closing: string | undefined) => closing ?? token);
    const input: unknown = JSON.parse(json.replace(/^\uFEFF/, ''));
    // The native loader ignores an invalid config as a whole. Keep references
    // in the copied file; expanded values are used only to validate and hash.
    if (!nativeConfig.safeParse(expand(input, environment)).success) return {};
    return nativeConfig.parse(input).mcpServers;
  } catch {
    return {};
  }
}

export function cursorApprovalKey(name: string, server: unknown, root: string, environment: NodeJS.ProcessEnv): string {
  const effective = nativeServer.parse(expand(server, environment));
  return `${name}-${createHash('sha256').update(JSON.stringify({ path: root, server: effective })).digest('hex').slice(0, 16)}`;
}

export function relocateCursorProjectServer(server: NativeServer, cwd: string, environment: NodeJS.ProcessEnv): NativeServer {
  if (!('command' in server)) return server;
  const effective = nativeStdioServer.parse(expand(server, environment));
  const localEnvironment = Object.fromEntries(Object.entries(effective.env ?? {}).map(([name, value]) => [name,
    expand(value, { ...environment, ...effective.env, [name]: environment[name] }),
  ])) as NodeJS.ProcessEnv;
  const effectiveCwd = expand(effective.cwd, { ...environment, ...localEnvironment });
  return {
    ...server,
    cwd: server.cwd === undefined ? cwd
      : typeof effectiveCwd === 'string' && isAbsolute(effectiveCwd) ? server.cwd : resolve(cwd, server.cwd),
  };
}
