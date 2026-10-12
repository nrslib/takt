import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCodexMcpList } from '../infra/codex/mcp-list.js';
import { prepareCodexMcpIsolation } from '../infra/codex/mcp-isolation.js';
import { resolveCodexSdkCli } from '../infra/codex/cli-runtime.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';

describe('Codex CLI effective MCP configuration without API calls', () => {
  let cwd: string;
  let env: Record<string, string>;
  let config: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-codex-mcp-'));
    env = { CODEX_HOME: cwd, ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }) };
    config = '[mcp_servers.unrelated]\ncommand = "node"\nargs = ["never-started.js"]\n'
      + '[mcp_servers."name.with.dots"]\ncommand = "node"\n'
      + '[mcp_servers."another.with.dots"]\ncommand = "node"\n';
    writeFileSync(join(cwd, 'config.toml'), config);
  });

  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('resolves the SDK CLI and disables ambient servers while enabling only the TAKT manager server', async () => {
    const runtime = resolveCodexSdkCli(undefined);
    const before = JSON.parse(await runCodexMcpList({ executablePath: runtime.executablePath, cwd, env, configOverrides: [] })) as { name: string; enabled: boolean }[];
    expect(before.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: 'another.with.dots', enabled: true },
      { name: 'name.with.dots', enabled: true }, { name: 'unrelated', enabled: true },
    ]);
    const managerConfig = { mcp_servers: { [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node', args: ['never-started.js'] } } };
    const isolated = await prepareCodexMcpIsolation({
      cwd, mcpOnlySideEffects: true,
      preparedMcp: { dispose: async () => {}, config: managerConfig },
    }, managerConfig, env);
    expect(isolated.codexPathOverride).toBe(runtime.executablePath);
    const after = JSON.parse(await runCodexMcpList({
      executablePath: isolated.codexPathOverride, cwd, env: isolated.env, configOverrides: isolated.configOverrides,
    })) as { name: string; enabled: boolean }[];
    expect(after.map(({ name, enabled }) => ({ name, enabled })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'another.with.dots', enabled: false },
      { name: 'name.with.dots', enabled: false },
      { name: TAKT_MANAGER_MCP_SERVER_NAME, enabled: true },
      { name: 'unrelated', enabled: false },
    ]);
    expect(readFileSync(join(cwd, 'config.toml'), 'utf8')).toBe(config);
  }, 30_000);

  it('rejects a disabled server with the manager name before recursively merging its environment', async () => {
    config += `[mcp_servers.${TAKT_MANAGER_MCP_SERVER_NAME}]\ncommand = "node"\nenabled = false\n`
      + `env = { USER_DEFINED = "unexpected" }\n`;
    writeFileSync(join(cwd, 'config.toml'), config);
    const managerConfig = { mcp_servers: { [TAKT_MANAGER_MCP_SERVER_NAME]: { command: 'node' } } };
    const listed = JSON.parse(await runCodexMcpList({ executablePath: resolveCodexSdkCli(undefined).executablePath, cwd, env, configOverrides: [] })) as { name: string; enabled: boolean }[];
    expect(listed).toContainEqual(expect.objectContaining({ name: TAKT_MANAGER_MCP_SERVER_NAME, enabled: false }));
    await expect(prepareCodexMcpIsolation({
      cwd, mcpOnlySideEffects: true, preparedMcp: { dispose: async () => {}, config: managerConfig },
    }, managerConfig, env)).rejects.toThrow(/conflicts/);
    expect(readFileSync(join(cwd, 'config.toml'), 'utf8')).toBe(config);
  }, 30_000);

  it('fails closed on a CLI configuration error without exposing config secrets', async () => {
    writeFileSync(join(cwd, 'config.toml'), 'a = "test-secret" broken syntax');
    const runtime = resolveCodexSdkCli(undefined);
    await expect(runCodexMcpList({ executablePath: runtime.executablePath, cwd, env, configOverrides: [] }))
      .rejects.toThrow('Failed to obtain');
  }, 30_000);
});
