import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasCodexMcpServer, runCodexMcpList } from '../infra/codex/mcp-list.js';
import { prepareCodexMcpExclusions, prepareCodexMcpIsolation } from '../infra/codex/mcp-isolation.js';
import { resolveCodexSdkCli } from '../infra/codex/cli-runtime.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';
import { createCodexMcpAdapter } from '../infra/providers/mcp/codex.js';
import { buildCodexSessionConfig } from '../infra/codex/session-config.js';
import { probeMcpHeaders } from './helpers/mcp-env-probe.js';

describe('Codex CLI effective MCP configuration without API calls', () => {
  let cwd: string;
  let env: Record<string, string>;
  let config: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-codex-mcp-'));
    env = { CODEX_HOME: cwd, ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }) };
    vi.stubEnv('CODEX_HOME', cwd);
    vi.stubEnv('HOME', cwd);
    config = '[mcp_servers.unrelated]\ncommand = "node"\nargs = ["never-started.js"]\n'
      + '[mcp_servers."name.with.dots"]\ncommand = "node"\n'
      + '[mcp_servers."another.with.dots"]\ncommand = "node"\n';
    writeFileSync(join(cwd, 'config.toml'), config);
  });

  afterEach(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });

  it.each(['user', 'project'] as const)('disables only excluded ambient servers in normal %s configuration without persisting the decision', async (source) => {
    const workspace = join(cwd, 'workspace');
    mkdirSync(join(workspace, '.codex'), { recursive: true });
    execFileSync('git', ['init', '--quiet', workspace]);
    const definitions = '[mcp_servers.datadog]\nurl="https://example.com/mcp"\n[mcp_servers.github]\ncommand="node"\n';
    const userConfig = source === 'user' ? definitions : `[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n`;
    const projectConfig = source === 'project' ? definitions : '';
    writeFileSync(join(cwd, 'config.toml'), userConfig);
    writeFileSync(join(workspace, '.codex/config.toml'), projectConfig);
    const environment = { ...env, HOME: cwd, MCP_HEADER_ACCESS: 'synthetic-access' };
    for (const excluded of [true, false]) {
      const server = interpolateMcpEnv({ type: 'http', url: 'https://example.com/mcp', headers: {
        Authorization: excluded ? 'Token ${env:MCP_HEADER_ACCESS}' : 'fixed',
      } }, environment);
      const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true, servers: { datadog: server }, serverNames: ['datadog'], identity: 'test' }, { cwd: workspace });
      try {
        const session = buildCodexSessionConfig({ cwd: workspace, childProcessEnv: environment, preparedMcp });
        const overrides = Object.entries((session.config.mcp_servers ?? {}) as Record<string, Record<string, unknown>>)
          .flatMap(([name, value]) => Object.entries(value).map(([key, entry]) => {
            const toml = typeof entry === 'object' && entry !== null
              ? `{${Object.entries(entry).map(([header, text]) => `${JSON.stringify(header)}=${JSON.stringify(text)}`).join(',')}}`
              : JSON.stringify(entry);
            return `mcp_servers.${name}.${key}=${toml}`;
          }));
        overrides.push(...await prepareCodexMcpExclusions({ cwd: workspace, childProcessEnv: environment, preparedMcp }, session.config, session.env));
        const listed = JSON.parse(await runCodexMcpList({ executablePath: resolveCodexSdkCli(undefined).executablePath, cwd: workspace, env: session.env, configOverrides: overrides })) as { name: string; enabled: boolean }[];
        expect(listed).toContainEqual(expect.objectContaining({ name: 'datadog', enabled: !excluded }));
        expect(listed).toContainEqual(expect.objectContaining({ name: 'github', enabled: true }));
      } finally { await preparedMcp.dispose(); }
    }
    expect(readFileSync(join(cwd, 'config.toml'), 'utf8')).toBe(userConfig);
    expect(readFileSync(join(workspace, '.codex/config.toml'), 'utf8')).toBe(projectConfig);
  }, 30_000);

  it.each([undefined, 'review'])('uses the selected profile for exclusions and real execution (profile=%s)', async (configProfile) => {
    const result = await probeMcpHeaders('codex', resolveCodexSdkCli(undefined).executablePath, async (url, environment, probeCwd) => {
      const profileConfig = `[mcp_servers.datadog]\nurl=${JSON.stringify(`${url}/excluded`)}\n[mcp_servers.github]\nurl=${JSON.stringify(url)}\n`;
      const profilePath = join(probeCwd, 'review.config.toml');
      writeFileSync(profilePath, profileConfig);
      const server = interpolateMcpEnv({ type: 'http', url: `${url}/excluded`, headers: {
        Authorization: 'Token ${env:MCP_HEADER_ACCESS}', 'X-Key': 'Token ${env:MCP_HEADER_KEY}',
      } }, environment);
      const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true, servers: { datadog: server }, serverNames: ['datadog'], identity: 'test' }, { cwd: probeCwd });
      try {
        const options = { cwd: probeCwd, preparedMcp, childProcessEnv: environment, configProfile };
        const session = buildCodexSessionConfig(options);
        const configOverrides = await prepareCodexMcpExclusions(options, session.config, session.env);
        expect(readFileSync(profilePath, 'utf8')).toBe(profileConfig);
        return { ...session, configOverrides };
      } finally { await preparedMcp.dispose(); }
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.excludedRequests).toBe(0);
    expect(result.mcpRequests === 0).toBe(configProfile === undefined);
    expect(result.argv.includes('--profile')).toBe(configProfile !== undefined);
    expect(result.shellOutput).toContain('header-secret=unset key-secret=unset');
    expect(result.secretInArtifacts).toBe(false);
  }, 30_000);

  it('does not probe excluded ambient HTTP servers while preparing MCP-only isolation', async () => {
    const result = await probeMcpHeaders('codex', resolveCodexSdkCli(undefined).executablePath, async (url, environment, probeCwd) => {
      const nativeConfig = `[mcp_servers.excluded]\nurl=${JSON.stringify(`${url}/excluded`)}\n[mcp_servers.github]\nurl=${JSON.stringify(url)}\n`;
      const configPath = join(probeCwd, 'config.toml');
      writeFileSync(configPath, nativeConfig);
      const excluded = interpolateMcpEnv({ type: 'http', url: `${url}/excluded`, headers: {
        Authorization: 'Token ${env:MCP_HEADER_ACCESS}', 'X-Key': 'Token ${env:MCP_HEADER_KEY}',
      } }, environment);
      const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true,
        servers: { excluded, retained: { type: 'http', url } }, serverNames: ['excluded', 'retained'], identity: 'test',
      }, { cwd: probeCwd });
      try {
        const options = { cwd: probeCwd, preparedMcp, childProcessEnv: environment, mcpOnlySideEffects: true };
        const session = buildCodexSessionConfig(options);
        const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
        expect(readFileSync(configPath, 'utf8')).toBe(nativeConfig);
        return { config: {}, env: isolated.env, configOverrides: isolated.configOverrides };
      } finally { await preparedMcp.dispose(); }
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.excludedRequests).toBe(0);
    expect(result.shellOutput).toContain('header-secret=unset key-secret=unset');
    expect(result.secretInArtifacts).toBe(false);
  }, 30_000);

  it.each([false, true])('does not treat an excluded ambient name as a retained MCP-only collision (all excluded=%s)', async (allExcluded) => {
    writeFileSync(join(cwd, 'config.toml'), '[mcp_servers.datadog]\ncommand="node"\n');
    const server = interpolateMcpEnv({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Token ${env:X}' } }, { X: 'synthetic' });
    const servers = { datadog: server, ...(allExcluded ? {} : { retained: { command: 'node' } }) };
    const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true, servers, serverNames: Object.keys(servers), identity: 'test' }, { cwd });
    try {
      const options = { cwd, childProcessEnv: env, preparedMcp, mcpOnlySideEffects: true };
      const session = buildCodexSessionConfig(options);
      const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
      const listed = JSON.parse(await runCodexMcpList({ executablePath: isolated.codexPathOverride, cwd, env: isolated.env, configOverrides: isolated.configOverrides })) as { name: string; enabled: boolean }[];
      expect(listed).toContainEqual(expect.objectContaining({ name: 'datadog', enabled: false }));
      expect(listed.filter((entry) => entry.enabled).map((entry) => entry.name)).toEqual(allExcluded ? [] : ['retained']);
    } finally { await preparedMcp.dispose(); }
  }, 30_000);

  it.each([[false, false], [false, true], [true, false], [true, true]])('protects excluded references in the real shell (MCP-only=%s, all-excluded=%s)', async (mcpOnlySideEffects, allExcluded) => {
    const result = await probeMcpHeaders('codex', resolveCodexSdkCli(undefined).executablePath, async (url, environment, probeCwd) => {
      const server = interpolateMcpEnv({ type: 'http', url: `${url}/excluded`, headers: { Authorization: 'Token ${env:MCP_HEADER_ACCESS}', 'X-Key': 'Token ${env:MCP_HEADER_KEY}' } }, environment);
      const servers = { excluded: server, ...(allExcluded ? {} : { retained: { type: 'http' as const, url } }) };
      const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true, servers, serverNames: Object.keys(servers), identity: 'test' }, { cwd: probeCwd });
      try {
        const options = { cwd: probeCwd, childProcessEnv: environment, preparedMcp, mcpOnlySideEffects };
        const session = buildCodexSessionConfig(options);
        if (!mcpOnlySideEffects) return session;
        const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
        return { config: {}, configOverrides: isolated.configOverrides, env: isolated.env };
      } finally { await preparedMcp.dispose(); }
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.received).toBe(false);
    expect(result.providerHasSecrets).toBe(true);
    expect(result.excludedRequests).toBe(0);
    expect(result.mcpRequests === 0).toBe(allExcluded);
    expect(result.shellOutput).toContain('header-secret=unset key-secret=unset');
    expect(result.secretInArtifacts).toBe(false);
  }, 30_000);

  it.each(['review', undefined, 'mcp-only'] as const)('preserves a reference to the internal profile environment name (%s)', async (profile) => {
    const result = await probeMcpHeaders('codex', resolveCodexSdkCli(undefined).executablePath, async (url, environment, probeCwd) => {
      const childProcessEnv = { ...environment, TAKT_CODEX_CONFIG_PROFILE: environment.MCP_HEADER_ACCESS! };
      if (profile === 'review') writeFileSync(join(probeCwd, 'review.config.toml'), 'model_reasoning_effort="low"\n');
      const server = interpolateMcpEnv({ type: 'http', url, headers: { Authorization: 'Bearer ${env:TAKT_CODEX_CONFIG_PROFILE}', 'X-Key': '${env:MCP_HEADER_KEY}', 'X-Access': '${env:MCP_HEADER_ACCESS}' } }, childProcessEnv);
      const preparedMcp = await createCodexMcpAdapter().prepare({ enabled: true, servers: { probe: server }, serverNames: ['probe'], identity: 'test' }, { cwd: probeCwd });
      try {
        const options = { cwd: probeCwd, childProcessEnv, preparedMcp, configProfile: profile === 'review' ? 'review' : undefined, mcpOnlySideEffects: profile === 'mcp-only' };
        const session = buildCodexSessionConfig(options);
        if (!options.mcpOnlySideEffects) return session;
        const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
        return { config: {}, configOverrides: isolated.configOverrides, env: isolated.env };
      } finally { await preparedMcp.dispose(); }
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.received).toBe(true);
    expect(result.argv.includes('--profile')).toBe(profile === 'review');
    if (profile === 'review') expect(result.argv[result.argv.indexOf('--profile') + 1]).toBe('review');
    expect(result.secretInArtifacts).toBe(false);
  }, 30_000);

  it.each([false, true])('sends referenced credentials to MCP while its real tool shell cannot read them (MCP-only=%s)', async (mcpOnlySideEffects) => {
      const result = await probeMcpHeaders('codex', resolveCodexSdkCli(undefined).executablePath, async (url, childProcessEnv, probeCwd) => {
        const server = interpolateMcpEnv({ type: 'http', url, headers: {
          Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}',
        } }, childProcessEnv);
        const adapter = createCodexMcpAdapter();
        const preparedMcp = await adapter.prepare({ enabled: true, servers: { probe: server }, serverNames: ['probe'], identity: 'probe' }, { cwd: probeCwd });
        try {
          const options = { cwd: probeCwd, preparedMcp, childProcessEnv, mcpOnlySideEffects };
          const session = buildCodexSessionConfig(options);
          if (!mcpOnlySideEffects) return session;
          const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
          return { config: {}, configOverrides: isolated.configOverrides, env: isolated.env };
        } finally { await preparedMcp.dispose(); }
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.received).toBe(true);
      expect(result.shellOutput).toContain('header-secret=unset key-secret=unset');
      expect(result.secretInArtifacts).toBe(false);
      for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
        expect(JSON.stringify(result.argv)).not.toContain(fragment);
        expect(result.output).not.toContain(fragment);
      }
  }, 30_000);

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
    await expect(hasCodexMcpServer({ executablePath: runtime.executablePath, cwd, env, configOverrides: [], serverName: 'datadog' }))
      .rejects.toThrow(Error);
  }, 30_000);

  it('preserves native header references and shell exclusions through MCP-only CLI overrides', async () => {
    const secret = 'synthetic-access-fragment.signature-fragment';
    const childProcessEnv = {
      ...env, HOME: cwd, USERPROFILE: cwd, XDG_CONFIG_HOME: cwd,
      MCP_HEADER_ACCESS: secret, MCP_HEADER_KEY: 'synthetic-key-fragment',
    };
    const server = interpolateMcpEnv({
      type: 'http', url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}' },
    }, childProcessEnv);
    const adapter = createCodexMcpAdapter();
    const servers = {
      enabled: true, servers: { datadog: server }, serverNames: ['datadog'], identity: 'datadog:http',
    };
    adapter.validate(servers);
    const preparedMcp = await adapter.prepare(servers, { cwd, childProcessEnv });

    try {
      const options = { cwd, childProcessEnv, mcpOnlySideEffects: true, preparedMcp };
      const session = buildCodexSessionConfig(options);
      const isolated = await prepareCodexMcpIsolation(options, session.config, session.env);
      const listed = JSON.parse(await runCodexMcpList({
        executablePath: isolated.codexPathOverride, cwd,
        env: isolated.env, configOverrides: isolated.configOverrides,
      })) as { name: string; enabled: boolean; transport: Record<string, unknown> }[];

      expect(listed.find((entry) => entry.name === 'datadog')).toMatchObject({
        enabled: true,
        transport: {
          type: 'streamable_http', url: 'https://example.com/mcp',
          bearer_token_env_var: 'MCP_HEADER_ACCESS', env_http_headers: { 'X-Key': 'MCP_HEADER_KEY' },
          http_headers: null,
        },
      });
      expect(listed.filter((entry) => entry.name !== 'datadog').every((entry) => !entry.enabled)).toBe(true);
      expect(session.config).toMatchObject({
        mcp_servers: { datadog: {
          bearer_token_env_var: 'MCP_HEADER_ACCESS', env_http_headers: { 'X-Key': 'MCP_HEADER_KEY' },
        } },
        shell_environment_policy: { filters: { MCP_HEADER_ACCESS: 'exclude', MCP_HEADER_KEY: 'exclude' } },
      });
      expect(isolated.env.MCP_HEADER_ACCESS).toBe(secret);
      expect(isolated.env.MCP_HEADER_KEY).toBe('synthetic-key-fragment');
      expect(isolated.configOverrides).toContain('shell_environment_policy.filters.MCP_HEADER_ACCESS="exclude"');
      expect(isolated.configOverrides).toContain('shell_environment_policy.filters.MCP_HEADER_KEY="exclude"');
      for (const argument of isolated.configOverrides) {
        for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
          expect(argument).not.toContain(fragment);
        }
      }
      expect(readFileSync(join(cwd, 'config.toml'), 'utf8')).toBe(config);
    } finally {
      await preparedMcp.dispose();
    }
  }, 30_000);
});
