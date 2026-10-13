import type { CodexOptions } from '@openai/codex-sdk';
import { z } from 'zod/v4';
import { delimiter } from 'node:path';
import { resolveCodexSdkCli } from './cli-runtime.js';
import { runCodexMcpList } from './mcp-list.js';
import type { CodexCallOptions } from './types.js';

const serverListSchema = z.array(z.object({ name: z.string().min(1), enabled: z.boolean() }));

function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join(', ')}}`;
  }
  throw new Error('Unsupported Codex config override value');
}

function serializeCodexConfig(config: Record<string, unknown>): string[] {
  const overrides: string[] = [];
  const flatten = (value: unknown, path: string[]): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
      && Object.keys(value).every((key) => /^[A-Za-z0-9_-]+$/.test(key))) {
      for (const [key, child] of Object.entries(value)) {
        if (child !== undefined) flatten(child, [...path, key]);
      }
    } else {
      overrides.push(`${path.join('.')}=${tomlValue(value)}`);
    }
  };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) flatten(value, [key]);
  }
  return overrides;
}

function buildCodexIsolatedMcpServers(json: string, ownServers: Record<string, unknown>): Record<string, unknown> {
  let servers: z.infer<typeof serverListSchema>;
  try {
    servers = serverListSchema.parse(JSON.parse(json) as unknown);
  } catch {
    throw new Error('Invalid effective Codex MCP server list');
  }
  if (servers.some((server) => Object.hasOwn(ownServers, server.name))) {
    throw new Error('TAKT MCP server name conflicts with an existing Codex MCP server');
  }
  return { ...Object.fromEntries(servers.map(({ name }) => [name, { enabled: false }])), ...ownServers };
}

export async function prepareCodexMcpIsolation(
  options: CodexCallOptions,
  codexConfig: NonNullable<CodexOptions['config']>,
  environment: Record<string, string>,
): Promise<{ codexPathOverride: string; env: Record<string, string>; configOverrides: string[] }> {
  const codexEnvironment = { ...environment };
  if (!codexEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    codexEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
  }
  if (options.openaiApiKey) codexEnvironment.CODEX_API_KEY = options.openaiApiKey;
  const runtime = resolveCodexSdkCli(options.codexPathOverride);
  const codexPathOverride = runtime.executablePath;
  if (runtime.pathDirs.length > 0) {
    const pathKeys = Object.keys(codexEnvironment).filter((key) => key.toLowerCase() === 'path');
    const pathKey = process.platform === 'win32'
      ? pathKeys.includes('Path') ? 'Path' : pathKeys.at(-1) ?? 'PATH'
      : 'PATH';
    if (process.platform === 'win32') {
      for (const key of pathKeys) {
        if (key !== pathKey) delete codexEnvironment[key];
      }
    }
    const existingPaths = (codexEnvironment[pathKey] ?? '').split(delimiter)
      .filter((entry) => entry.length > 0 && !runtime.pathDirs.includes(entry));
    codexEnvironment[pathKey] = [...runtime.pathDirs, ...existingPaths].join(delimiter);
  }
  // Enumerate before adding TAKT's definitions so recursive TOML merging cannot hide a name collision.
  const ambientConfig = { ...codexConfig };
  delete ambientConfig.mcp_servers;
  const isolationConfig: NonNullable<CodexOptions['config']> = {
    ...ambientConfig,
    sandbox_mode: 'read-only', approval_policy: 'never',
    sandbox_workspace_write: { network_access: false }, web_search: 'disabled', notify: [],
    ...(options.baseUrl === undefined ? {} : { openai_base_url: options.baseUrl }),
    ...(options.model === undefined ? {} : { model: options.model }),
    features: {
      ...(ambientConfig.features as Record<string, boolean> | undefined),
      apps: false, browser_use: false, browser_use_external: false,
      computer_use: false, image_generation: false, plugins: false, hooks: false,
    },
  };
  const sessionOverrides = serializeCodexConfig(isolationConfig);
  const json = await runCodexMcpList({
    executablePath: codexPathOverride, cwd: options.cwd, env: codexEnvironment,
    configOverrides: sessionOverrides, abortSignal: options.abortSignal,
  });
  const ownServers = options.preparedMcp?.config?.mcp_servers ?? {};
  // CLI paths split on dots without parsing quoted keys. Serialize unusual names as one table,
  // including TAKT's servers, since a later override of the whole table would replace earlier ones.
  const configOverrides = [
    ...sessionOverrides, ...serializeCodexConfig({ mcp_servers: buildCodexIsolatedMcpServers(json, ownServers) }),
  ];
  return { codexPathOverride, env: codexEnvironment, configOverrides };
}
