import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// New modules under test (implemented in the following `implement` step).
import { createMcpAdapter, type ResolvedMcpServers, type ProviderMcpContext } from '../infra/providers/mcp/index.js';
import { createTaskStateMcpServers } from '../features/interactive/taskStateMcp.js';
import { McpSectionSchema } from '../infra/config/runtime-provider/mcp-schema.js';
import { resolveMcpAssignment } from '../infra/config/runtime-provider/mcp-assignment.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-CODEX` (要件40,41,42,43,44,45)
 *   - `codex` が `CodexOptions.config` から Codex CLI の `mcp_servers` へ変換して渡す
 *   - stdio は command/args/env、Streamable HTTP は url/header/auth
 *   - 既存 MCP tool call event 処理を維持する
 *   - runtime 割当 server が thread 開始時の実効設定になる
 *   - 未割当 server が有効にならないよう実効 config を検証する
 * - `MCP-OPENCODE` (要件46,47,48,49,50)
 *   - `opencode` が `createOpencode` server config へ解決済み server を渡す
 *   - 共通 stdio/HTTP を local/remote schema へ変換
 *   - 異なる集合が同じ shared server を共有しない
 *   - server 再起動/invalidation/session resume 時の一貫性
 * - `MCP-CURSOR` (要件51,52,53,54,55)
 *   - ユーザー `.cursor/mcp.json` を破壊せず runtime 指定 MCP server を利用
 *   - 並列実行で衝突しない
 *   - 安全に隔離できない version は fail-fast
 * - `MCP-COPILOT` (要件56,57,58,59,60)
 *   - `--additional-mcp-config` 経由で渡す
 *   - `~/.copilot/mcp-config.json` を変更しない
 *   - 一時ファイルを全経路 cleanup
 *   - permission mode と矛盾しない
 * - `MCP-KIRO` (要件61,62,63,64,65)
 *   - 既存設定を破壊せず `--require-mcp-startup` 付きで利用
 *   - 一時設定を全経路 cleanup
 * - `MCP-MOCK` (要件66,67,68)
 *   - 解決された server 名/transport を test hook で検査可能
 *   - deterministic local MCP fixture の tool call/result を模擬可能
 */

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: {
      'common-tools': { type: 'stdio', command: 'common-srv', args: ['--flag'], env: { K: 'v' } },
      'remote-tools': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
    serverNames: ['common-tools', 'remote-tools'],
    identity: 'common-tools:stdio,remote-tools:http',
  };
}

function baseContext(overrides: Partial<ProviderMcpContext> = {}): ProviderMcpContext {
  return {
    cwd: '/tmp/test',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('Codex adapter (MCP-CODEX)', () => {
  it('Given the codex adapter, When prepared with stdio+http servers, Then CodexOptions.config contains mcp_servers for both', async () => {
    const adapter = createMcpAdapter('codex');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    expect(config).toBeDefined();
    const mcpServers = config?.mcp_servers as Record<string, unknown>;
    expect(mcpServers['common-tools']).toBeDefined();
    expect(mcpServers['remote-tools']).toBeDefined();
    await prepared.dispose();
  });

  it('Given the codex adapter and a stdio server, When prepared, Then mcp_servers entry has command/args/env (要件41)', async () => {
    const adapter = createMcpAdapter('codex');
    const stdioOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'common-tools': { type: 'stdio', command: 'srv', args: ['--flag'], env: { K: 'v' } } },
      serverNames: ['common-tools'],
      identity: 'common-tools:stdio',
    };
    const prepared = await adapter.prepare(stdioOnly, baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    const entry = config?.mcp_servers?.['common-tools'] as Record<string, unknown>;
    expect(entry.command).toBe('srv');
    expect(entry.args).toEqual(['--flag']);
    expect(entry.env).toEqual({ K: 'v' });
    await prepared.dispose();
  });

  it('Given the codex adapter and an http server, When prepared, Then mcp_servers entry has url/http_headers (要件42)', async () => {
    const adapter = createMcpAdapter('codex');
    const httpOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'remote-tools': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } },
      serverNames: ['remote-tools'],
      identity: 'remote-tools:http',
    };
    const prepared = await adapter.prepare(httpOnly, baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    const entry = config?.mcp_servers?.['remote-tools'] as Record<string, unknown>;
    expect(entry.url).toBe('https://example.com/mcp');
    expect(entry.http_headers).toEqual({ Authorization: 'Bearer x' });
    expect(entry.headers).toBeUndefined();
    await prepared.dispose();
  });

  it('Given the codex adapter, When prepared with empty servers, Then config has no mcp_servers (要件45: 未割当 server が有効にならない)', async () => {
    const adapter = createMcpAdapter('codex');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    // No mcp_servers must be set when no servers are assigned — do not enable unassigned native servers.
    expect(config?.mcp_servers).toBeUndefined();
    await prepared.dispose();
  });
});

describe('Codex runtime header environment references', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_HEADER_ACCESS', 'synthetic-access-fragment.signature-fragment');
    vi.stubEnv('MCP_HEADER_KEY', 'synthetic-key-fragment');
    vi.stubEnv('MCP_HEADER_TENANT', 'tenant-a');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function runtimeServers(
    headers: Record<string, string>,
    serverNames: string[] = ['datadog', 'github'],
  ): ResolvedMcpServers {
    const section = McpSectionSchema.parse({
      servers: {
        datadog: { type: 'http', url: 'https://example.com/mcp', headers },
        github: { type: 'stdio', command: 'github-mcp' },
      },
      defaults: { servers: serverNames },
    });
    return resolveMcpAssignment(section, {
      persona: 'coder', tags: [], stepQualifiedName: 'default/implement',
      isWorkflowCallNode: false, isInternalAgent: false,
    });
  }

  function expectNoSecretValues(value: unknown): void {
    if (typeof value === 'string') {
      for (const fragment of ['synthetic-access-fragment', 'signature-fragment', 'synthetic-key-fragment']) {
        expect(value).not.toContain(fragment);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) expectNoSecretValues(child);
    }
  }

  it('converts runtime bearer and arbitrary header references into native Codex environment names', async () => {
    const servers = runtimeServers({
      Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}',
      'X-Tenant': '${MCP_HEADER_TENANT}', 'X-Static': 'fixed',
    });
    const adapter = createMcpAdapter('codex');
    adapter.validate(servers);
    const prepared = await adapter.prepare(servers, baseContext());
    try {
      expect(prepared.config?.mcp_servers?.datadog).toEqual({
        url: 'https://example.com/mcp', bearer_token_env_var: 'MCP_HEADER_ACCESS',
        env_http_headers: { 'X-Key': 'MCP_HEADER_KEY' },
        http_headers: { 'X-Tenant': 'tenant-a', 'X-Static': 'fixed' },
      });
      expect(prepared.config?.mcp_servers?.github).toEqual({ command: 'github-mcp' });
      expectNoSecretValues(prepared.config);
    } finally {
      await prepared.dispose();
    }
  });

  it('does not reinterpret legacy interpolation output as a provider reference', async () => {
    vi.stubEnv('MCP_HEADER_TEXT', '${env:MCP_HEADER_ACCESS}');
    const adapter = createMcpAdapter('codex');
    const prepared = await adapter.prepare(runtimeServers({ 'X-Text': '${MCP_HEADER_TEXT}' }), baseContext());
    try {
      expect(prepared.config?.mcp_servers?.datadog).toEqual({
        url: 'https://example.com/mcp', http_headers: { 'X-Text': '${env:MCP_HEADER_ACCESS}' },
      });
    } finally {
      await prepared.dispose();
    }
  });

  it('warns and drops only the server whose header cannot be represented by Codex', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = runtimeServers({ Authorization: 'Token ${env:MCP_HEADER_ACCESS}' });
    const adapter = createMcpAdapter('codex');
    adapter.validate(servers);
    const prepared = await adapter.prepare(servers, baseContext());
    try {
      expect(prepared.config?.mcp_servers?.datadog).toBeUndefined();
      expect(prepared.config?.mcp_servers?.github).toEqual({ command: 'github-mcp' });
      expect(prepared.excludedServerNames).toEqual(['datadog']);
      expect(prepared.config?.shell_environment_policy?.filters).toEqual({ MCP_HEADER_ACCESS: 'exclude' });
      const messages = [...output.mock.calls, ...warnings.mock.calls].map((args) => args.join(' '));
      expect(messages.some((message) => /codex/i.test(message) && message.includes('datadog')
        && /support|represent|対応|表現/i.test(message))).toBe(true);
      expectNoSecretValues(messages);
      expectNoSecretValues(prepared.config);
      expect(servers).toMatchObject({
        enabled: true, serverNames: ['datadog', 'github'],
        servers: {
          datadog: { type: 'http', headers: { Authorization: 'Token ${env:MCP_HEADER_ACCESS}' } },
          github: { type: 'stdio', command: 'github-mcp' },
        },
      });
    } finally {
      await prepared.dispose();
    }
  });

  it('excludes Codex servers whose header names differ only by case', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = runtimeServers({ 'X-Key': '${env:MCP_HEADER_KEY}', 'x-key': 'literal' });
    const prepared = await createMcpAdapter('codex').prepare(servers, baseContext());

    try {
      expect(prepared.config?.mcp_servers?.datadog).toBeUndefined();
      expect(prepared.config?.mcp_servers?.github).toEqual({ command: 'github-mcp' });
      expect(prepared.excludedServerNames).toEqual(['datadog']);
      expect(prepared.config?.shell_environment_policy?.filters).toEqual({ MCP_HEADER_KEY: 'exclude' });
      const messages = [...output.mock.calls, ...warnings.mock.calls].map((args) => args.join(' '));
      expect(messages.some((message) => message.includes('header names that differ only by case'))).toBe(true);
    } finally {
      await prepared.dispose();
    }
  });

  it('keeps literal and legacy headers unchanged when no provider reference is present', async () => {
    const prepared = await createMcpAdapter('codex').prepare(runtimeServers({
      'X-Tenant': '${MCP_HEADER_TENANT}', 'X-Static': 'fixed',
    }), baseContext());
    try {
      expect(prepared.config?.mcp_servers?.datadog).toEqual({
        url: 'https://example.com/mcp', http_headers: { 'X-Tenant': 'tenant-a', 'X-Static': 'fixed' },
      });
    } finally {
      await prepared.dispose();
    }
  });

  it('prepares an empty effective MCP set when every assigned server has an unrepresentable header', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const servers = runtimeServers({ Authorization: 'Token ${env:MCP_HEADER_ACCESS}' }, ['datadog']);
    const adapter = createMcpAdapter('codex');
    adapter.validate(servers);
    const prepared = await adapter.prepare(servers, baseContext());
    try {
      expect(prepared.config?.mcp_servers).toBeUndefined();
      expect(prepared.excludedServerNames).toEqual(['datadog']);
      expect(prepared.config?.shell_environment_policy?.filters).toEqual({ MCP_HEADER_ACCESS: 'exclude' });
      const messages = [...output.mock.calls, ...warnings.mock.calls].map((args) => args.join(' '));
      expect(messages.some((message) => /codex/i.test(message) && message.includes('datadog'))).toBe(true);
      expectNoSecretValues(messages);
      expectNoSecretValues(prepared.config);
    } finally {
      await prepared.dispose();
    }
  });

  it('converts references for measured OpenCode runtimes without exposing values in config JSON', async () => {
    const prepared = await createMcpAdapter('opencode').prepare(runtimeServers({
      Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}', 'X-Tenant': '${MCP_HEADER_TENANT}',
    }), baseContext());
    try {
      expect(prepared.serverConfig?.datadog).toEqual({ type: 'remote', url: 'https://example.com/mcp', headers: {
        Authorization: 'Bearer {env:MCP_HEADER_ACCESS}', 'X-Key': '{env:MCP_HEADER_KEY}', 'X-Tenant': 'tenant-a',
      } });
      expectNoSecretValues([prepared.serverConfig, prepared.identity]);
    } finally { await prepared.dispose(); }
  });

  it('keeps OpenCode identity independent of provider reference values', async () => {
    const adapter = createMcpAdapter('opencode');
    const headers = { Authorization: '${MCP_HEADER_TENANT} ${env:MCP_HEADER_ACCESS}' };
    const a = await adapter.prepare(runtimeServers(headers), baseContext());
    vi.stubEnv('MCP_HEADER_ACCESS', 'rotated-secret-fragment');
    const b = await adapter.prepare(runtimeServers(headers), baseContext());
    try {
      expect(a.identity).toBe(b.identity);
      expect(b.serverConfig?.datadog).toMatchObject({ headers: {
        Authorization: 'tenant-a {env:MCP_HEADER_ACCESS}',
      } });
      expectNoSecretValues([a.identity, b.identity]);
      for (const fragment of ['tenant-a', 'rotated-secret-fragment']) {
        expect(a.identity).not.toContain(fragment);
        expect(b.identity).not.toContain(fragment);
      }
    } finally { await a.dispose(); await b.dispose(); }
  });

  it('distinguishes legacy interpolation changes without exposing the expanded value', async () => {
    const adapter = createMcpAdapter('opencode');
    const headers = { Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}', 'X-Tenant': '${MCP_HEADER_TENANT}' };
    const a = await adapter.prepare(runtimeServers(headers), baseContext());
    vi.stubEnv('MCP_HEADER_TENANT', 'tenant-b');
    const b = await adapter.prepare(runtimeServers(headers), baseContext());
    try {
      expect(a.identity).not.toBe(b.identity);
      expect(b.serverConfig?.datadog).toMatchObject({ headers: { 'X-Tenant': 'tenant-b' } });
      expect(a.identity).not.toContain('tenant-a');
      expect(b.identity).not.toContain('tenant-b');
    } finally { await a.dispose(); await b.dispose(); }
  });

  it('preserves legacy interpolation output as literal header text', async () => {
    const adapter = createMcpAdapter('opencode');
    vi.stubEnv('MCP_HEADER_TEXT', '${env:MCP_HEADER_ACCESS}');
    const a = await adapter.prepare(runtimeServers({ 'X-Text': '${MCP_HEADER_TEXT}' }), baseContext());
    const b = await adapter.prepare(runtimeServers({ 'X-Text': 'fixed' }), baseContext());
    try {
      expect(a.serverConfig?.datadog).toMatchObject({ headers: { 'X-Text': '${env:MCP_HEADER_ACCESS}' } });
      expect(a.identity).not.toBe(b.identity);
      expect(a.identity).not.toContain('MCP_HEADER_ACCESS');
    } finally { await a.dispose(); await b.dispose(); }
  });

  it('distinguishes fixed headers even without provider references', async () => {
    const adapter = createMcpAdapter('opencode');
    const a = await adapter.prepare(runtimeServers({ 'X-Tenant': 'tenant-a' }), baseContext());
    const b = await adapter.prepare(runtimeServers({ 'X-Tenant': 'tenant-b' }), baseContext());
    try {
      expect(a.identity).not.toBe(b.identity);
      expect(a.identity).not.toContain('tenant-a');
      expect(b.identity).not.toContain('tenant-b');
    } finally { await a.dispose(); await b.dispose(); }
  });

  it('canonicalizes OpenCode server and header order while preserving each reference position', async () => {
    const adapter = createMcpAdapter('opencode');
    const aServers = runtimeServers({
      Authorization: '${env:MCP_HEADER_ACCESS}:${env:MCP_HEADER_KEY}', 'X-Key': '${env:MCP_HEADER_KEY}',
    });
    const reversedServers = runtimeServers({
      'X-Key': '${env:MCP_HEADER_KEY}', Authorization: '${env:MCP_HEADER_ACCESS}:${env:MCP_HEADER_KEY}',
    });
    const a = await adapter.prepare(aServers, baseContext());
    const b = await adapter.prepare({ ...reversedServers,
      servers: Object.fromEntries(Object.entries(reversedServers.servers).reverse()),
    }, baseContext());
    const swapped = await adapter.prepare(runtimeServers({
      Authorization: '${env:MCP_HEADER_KEY}:${env:MCP_HEADER_ACCESS}', 'X-Key': '${env:MCP_HEADER_KEY}',
    }), baseContext());
    const moved = await adapter.prepare(runtimeServers({
      Authorization: '${env:MCP_HEADER_KEY}', 'X-Key': '${env:MCP_HEADER_ACCESS}:${env:MCP_HEADER_KEY}',
    }), baseContext());
    try {
      expect(a.identity).toBe(b.identity);
      expect(a.identity).not.toBe(swapped.identity);
      expect(a.identity).not.toBe(moved.identity);
    } finally { await a.dispose(); await b.dispose(); await swapped.dispose(); await moved.dispose(); }
  });

  it.each(['claude-sdk', 'claude-headless', 'claude-terminal', 'cursor', 'copilot', 'mock'] as const)(
    'warns once and keeps unrelated servers when %s cannot resolve provider header references', async (provider) => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const servers = runtimeServers({ Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}' });
      const adapter = createMcpAdapter(provider);
      adapter.validate(servers);
      const workspace = provider === 'cursor' ? mkdtempSync(join(tmpdir(), 'cursor-runtime-')) : undefined;
      if (workspace !== undefined) {
        vi.stubEnv('HOME', workspace);
        vi.stubEnv('USERPROFILE', workspace);
        vi.stubEnv('CURSOR_DATA_DIR', join(workspace, 'data'));
      }
      const prepared = await adapter.prepare(servers, baseContext(workspace === undefined ? {} : { cwd: workspace }));
      try {
        let material: unknown;
        if (provider === 'claude-sdk') material = prepared.sdkOptions?.mcpServers;
        else if (provider === 'mock') material = prepared.resolvedServers?.servers;
        else material = JSON.parse(readFileSync(prepared.path ?? join(prepared.configRoot!, '.cursor/mcp.json'), 'utf8')).mcpServers;
        expect(material).toHaveProperty('github');
        expect(material).not.toHaveProperty('datadog');
        const messages = [...output.mock.calls, ...warnings.mock.calls].map((args) => args.join(' '));
        expect(messages.filter((message) => message.includes('datadog') && message.includes(provider))).toHaveLength(1);
        expectNoSecretValues([material, messages]);
        expect(servers.serverNames).toEqual(['datadog', 'github']);
      } finally {
        await prepared.dispose();
        if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it('passes an explicit empty Claude SDK server set after all runtime references are excluded', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prepared = await createMcpAdapter('claude-sdk').prepare(runtimeServers({
      Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}',
    }, ['datadog']), baseContext());
    try { expect(prepared.sdkOptions).toEqual({ strictMcpConfig: true, mcpServers: {} }); }
    finally { await prepared.dispose(); }
  });

  it.each([true, false])('keeps Copilot disable arguments when all servers are excluded=%s', async (allExcluded) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prepared = await createMcpAdapter('copilot').prepare(runtimeServers({
      Authorization: 'Bearer ${env:MCP_HEADER_ACCESS}',
    }, allExcluded ? ['datadog'] : ['datadog', 'github']), baseContext());
    try {
      expect(prepared.args?.slice(0, 2)).toEqual(['--disable-mcp-server', 'datadog']);
      if (allExcluded) expect(prepared.args).toHaveLength(2);
      else expect(JSON.parse(readFileSync(prepared.path!, 'utf8')).mcpServers).toEqual({ github: { command: 'github-mcp' } });
    } finally { await prepared.dispose(); }
  });

  it.each([true, false])('consumes runtime SSE headers in Claude SDK selection (reference=%s)', async (reference) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const section = McpSectionSchema.parse({ servers: {
      datadog: { type: 'sse', url: 'https://example.com/sse', headers: {
        Authorization: reference ? 'Bearer ${env:MCP_HEADER_ACCESS}' : 'fixed',
      } }, github: { command: 'github-mcp' },
    }, defaults: { servers: ['datadog', 'github'] } });
    const servers = resolveMcpAssignment(section, {
      persona: 'coder', tags: [], stepQualifiedName: 'default/implement',
      isWorkflowCallNode: false, isInternalAgent: false,
    });
    const adapter = createMcpAdapter('claude-sdk');
    adapter.validate(servers);
    const prepared = await adapter.prepare(servers, baseContext());
    try {
      expect(prepared.sdkOptions?.mcpServers).toHaveProperty('github');
      if (reference) expect(prepared.sdkOptions?.mcpServers).not.toHaveProperty('datadog');
      else expect(prepared.sdkOptions?.mcpServers?.datadog).toMatchObject({ type: 'sse', headers: { Authorization: 'fixed' } });
      const messages = [...output.mock.calls, ...warnings.mock.calls].map((args) => args.join(' '));
      expect(messages.filter((message) => message.includes('datadog') && message.includes('claude-sdk') && message.includes('not been verified'))).toHaveLength(reference ? 1 : 0);
    } finally { await prepared.dispose(); }
  });
});

describe('OpenCode adapter (MCP-OPENCODE)', () => {
  it('Given the opencode adapter, When prepared with stdio+http servers, Then server config contains local+remote entries', async () => {
    const adapter = createMcpAdapter('opencode');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    expect(serverConfig).toBeDefined();
    expect(serverConfig?.['common-tools']).toBeDefined();
    expect(serverConfig?.['remote-tools']).toBeDefined();
    await prepared.dispose();
  });

  it('Given the opencode adapter and a stdio server, When prepared, Then the entry is in local schema (要件47)', async () => {
    const adapter = createMcpAdapter('opencode');
    const stdioOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'common-tools': { type: 'stdio', command: 'srv' } },
      serverNames: ['common-tools'],
      identity: 'common-tools:stdio',
    };
    const prepared = await adapter.prepare(stdioOnly, baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    const entry = serverConfig?.['common-tools'] as Record<string, unknown>;
    expect(entry).toEqual({ type: 'local', command: ['srv'] });
    await prepared.dispose();
  });

  it('Given the opencode adapter and an http server, When prepared, Then the entry is in remote schema (要件47)', async () => {
    const adapter = createMcpAdapter('opencode');
    const httpOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'remote-tools': { type: 'http', url: 'https://example.com/mcp' } },
      serverNames: ['remote-tools'],
      identity: 'remote-tools:http',
    };
    const prepared = await adapter.prepare(httpOnly, baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    const entry = serverConfig?.['remote-tools'] as Record<string, unknown>;
    expect(entry).toMatchObject({
      type: 'remote',
      url: 'https://example.com/mcp',
    });
    await prepared.dispose();
  });

  it('Given the opencode adapter with different server sets, Then the identity differs so shared servers are not shared across sets (要件48,49)', async () => {
    const adapter = createMcpAdapter('opencode');
    const setA: ResolvedMcpServers = {
      enabled: true,
      servers: { a: { type: 'stdio', command: 'a' } },
      serverNames: ['a'],
      identity: 'a:stdio',
    };
    const setB: ResolvedMcpServers = {
      enabled: true,
      servers: { b: { type: 'stdio', command: 'b' } },
      serverNames: ['b'],
      identity: 'b:stdio',
    };
    const preparedA = await adapter.prepare(setA, baseContext());
    const preparedB = await adapter.prepare(setB, baseContext());
    const identityA = (preparedA as { identity?: string }).identity;
    const identityB = (preparedB as { identity?: string }).identity;
    expect(identityA).not.toBe(identityB);
    await preparedA.dispose();
    await preparedB.dispose();
  });

  it('Given the opencode adapter with empty servers, Then serverConfig is undefined or empty', async () => {
    const adapter = createMcpAdapter('opencode');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    expect(serverConfig === undefined || Object.keys(serverConfig ?? {}).length === 0).toBe(true);
    await prepared.dispose();
  });
});

describe('Cursor adapter (MCP-CURSOR)', () => {
  it('Given the cursor adapter, When prepared with servers, Then the workspace config root is isolated from the user .cursor/mcp.json', async () => {
    const adapter = createMcpAdapter('cursor');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    // The adapter must expose an isolated config root path so it never touches the user's .cursor/mcp.json.
    const configRoot = (prepared as { configRoot?: string }).configRoot;
    expect(configRoot).toBeDefined();
    expect(configRoot).not.toBe('/tmp/test');
    // The config root and the mcp.json file must be private (order.md:283, claude-mcp-config.test.ts:30-33).
    expect(statSync(configRoot!).mode & 0o777).toBe(0o700);
    expect(statSync(join(configRoot!, '.cursor', 'mcp.json')).mode & 0o777).toBe(0o600);
    await prepared.dispose();
  });

  it('Given the cursor adapter, When prepared with empty servers, Then it does not create a config root', async () => {
    const adapter = createMcpAdapter('cursor');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const configRoot = (prepared as { configRoot?: string }).configRoot;
    expect(configRoot).toBeUndefined();
    await prepared.dispose();
  });

  it('Given the cursor adapter with an unsupported SSE server, When validated, Then it fails fast naming the transport (要件55)', () => {
    const adapter = createMcpAdapter('cursor');
    const unsupported: ResolvedMcpServers = {
      enabled: true,
      servers: { events: { type: 'sse', url: 'http://events/sse' } },
      serverNames: ['events'],
      identity: 'events:sse',
    };
    expect(() => adapter.validate(unsupported, { sourcePath: '/tmp/runtime.yaml' }))
      .toThrow(/cursor.*sse/i);
  });

  it('Given the cursor adapter, When prepare is called twice, Then each call yields a distinct isolated configRoot (要件205 並列安全性)', async () => {
    const adapter = createMcpAdapter('cursor');
    const preparedA = await adapter.prepare(resolvedServers(), baseContext());
    const preparedB = await adapter.prepare(resolvedServers(), baseContext());
    const configRootA = (preparedA as { configRoot?: string }).configRoot;
    const configRootB = (preparedB as { configRoot?: string }).configRoot;
    expect(configRootA).toBeDefined();
    expect(configRootB).toBeDefined();
    expect(configRootA).not.toBe(configRootB);
    await preparedA.dispose();
    await preparedB.dispose();
  });
});

describe('Copilot adapter (MCP-COPILOT)', () => {
  it('Given the copilot adapter, When prepared with servers, Then the CLI args include --additional-mcp-config=@<path>', async () => {
    const adapter = createMcpAdapter('copilot');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    const additionalIndex = args?.findIndex((a) => a.startsWith('--additional-mcp-config')) ?? -1;
    expect(additionalIndex).toBeGreaterThanOrEqual(0);
    // The temp config file and its parent directory must be private (order.md:283, claude-mcp-config.test.ts:30-33).
    const path = args?.[additionalIndex]?.split('=')[1]?.replace(/^@/, '');
    expect(path).toBeDefined();
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);
    await prepared.dispose();
  });

  it('Given the copilot adapter, When prepared, Then the temp file path is NOT ~/.copilot/mcp-config.json', async () => {
    const adapter = createMcpAdapter('copilot');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args ?? [];
    const additionalArg = args.find((a) => a.startsWith('--additional-mcp-config'));
    const path = additionalArg?.split('=')[1]?.replace(/^@/, '');
    expect(path).toBeDefined();
    expect(path).not.toContain('.copilot/mcp-config.json');
    await prepared.dispose();
  });

  it('Given the copilot adapter with empty servers, Then --additional-mcp-config is NOT added', async () => {
    const adapter = createMcpAdapter('copilot');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args.find((a) => a.startsWith('--additional-mcp-config'))).toBeUndefined();
    await prepared.dispose();
  });

  it('Given the copilot adapter with readonly permission mode, When prepared with servers, Then it fails fast because MCP tools may contradict the permission mode (要件220)', async () => {
    const adapter = createMcpAdapter('copilot');
    await expect(
      adapter.prepare(resolvedServers(), baseContext({ permissionMode: 'readonly' })),
    ).rejects.toThrow(/readonly permission mode/);
  });

  it('Given the generated read-only task-state server, When Copilot prepares it in readonly mode, Then the trusted server is allowed', async () => {
    const adapter = createMcpAdapter('copilot');
    const taskStateMcpServers = createTaskStateMcpServers();
    const servers: ResolvedMcpServers = {
      enabled: true,
      servers: taskStateMcpServers,
      serverNames: Object.keys(taskStateMcpServers),
      identity: 'takt:stdio',
    };
    const prepared = await adapter.prepare(
      servers,
      baseContext({ permissionMode: 'readonly', taskStateMcpServers }),
    );
    try {
      const args = (prepared as { args?: string[] }).args ?? [];
      expect(args.find((a) => a.startsWith('--additional-mcp-config'))).toBeDefined();
    } finally {
      await prepared.dispose();
    }
  });

  it('rejects an untrusted copy of task-state servers in Copilot readonly mode', async () => {
    const adapter = createMcpAdapter('copilot');
    const taskStateMcpServers = createTaskStateMcpServers();
    const copiedServers = { ...taskStateMcpServers };

    await expect(adapter.prepare({
      enabled: true,
      servers: copiedServers,
      serverNames: Object.keys(copiedServers),
      identity: 'takt:stdio',
    }, baseContext({ permissionMode: 'readonly', taskStateMcpServers }))).rejects.toThrow(/readonly permission mode/);
  });

  it('Given the copilot adapter with edit permission mode, When prepared with servers, Then --additional-mcp-config is added (permission-consistent)', async () => {
    const adapter = createMcpAdapter('copilot');
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ permissionMode: 'edit' }));
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args.find((a) => a.startsWith('--additional-mcp-config'))).toBeDefined();
    await prepared.dispose();
  });

  it('Given the copilot adapter with full permission mode, When prepared with servers, Then --additional-mcp-config is added (permission-consistent)', async () => {
    const adapter = createMcpAdapter('copilot');
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ permissionMode: 'full' }));
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args.find((a) => a.startsWith('--additional-mcp-config'))).toBeDefined();
    await prepared.dispose();
  });
});

describe('Kiro adapter (MCP-KIRO)', () => {
  it('Given the kiro adapter with empty servers, When prepared, Then no MCP args are produced', async () => {
    const adapter = createMcpAdapter('kiro');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    expect((prepared as { args?: string[] }).args ?? []).toEqual([]);
    await prepared.dispose();
  });

  it('Given the kiro adapter with servers, When prepared, Then it rejects instead of emitting --mcp-config', async () => {
    const adapter = createMcpAdapter('kiro');
    await expect(adapter.prepare(resolvedServers(), baseContext())).rejects.toThrow(/Provider "kiro"/);
  });
});

describe('Claude SDK adapter (MCP-CLAUDE-SDK strict-mcp-config)', () => {
  it('Given the claude-sdk adapter, When prepared with servers, Then sdkOptions has strictMcpConfig: true (order.md:160)', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { mcpServers?: Record<string, unknown>; strictMcpConfig?: boolean } }).sdkOptions;
    expect(sdkOptions).toBeDefined();
    expect(sdkOptions?.strictMcpConfig).toBe(true);
    expect(sdkOptions?.mcpServers).toBeDefined();
    await prepared.dispose();
  });

  it('Given the claude-sdk adapter with an empty server set, Then sdkOptions still has strictMcpConfig: true but no mcpServers (order.md:152,160)', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { mcpServers?: Record<string, unknown>; strictMcpConfig?: boolean } }).sdkOptions;
    expect(sdkOptions).toBeDefined();
    expect(sdkOptions?.strictMcpConfig).toBe(true);
    expect(sdkOptions?.mcpServers).toBeUndefined();
    await prepared.dispose();
  });
});

describe('Claude headless CLI adapter (MCP-CLAUDE strict-mcp-config)', () => {
  it('Given the claude-headless adapter, When prepared with servers, Then args include --strict-mcp-config and --mcp-config (order.md:166)', async () => {
    const adapter = createMcpAdapter('claude-headless');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    const configIndex = args?.findIndex((a) => a === '--mcp-config') ?? -1;
    expect(configIndex).toBeGreaterThanOrEqual(0);
    await prepared.dispose();
  });

  it('Given the claude-headless adapter with an empty server set, Then args include --strict-mcp-config but no --mcp-config (order.md:152,166)', async () => {
    const adapter = createMcpAdapter('claude-headless');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    expect(args?.find((a) => a === '--mcp-config')).toBeUndefined();
    await prepared.dispose();
  });
});

describe('Claude terminal CLI adapter (MCP-CLAUDE-TERMINAL strict-mcp-config)', () => {
  it('Given the claude-terminal adapter, When prepared with servers, Then args include --strict-mcp-config and --mcp-config (order.md:172)', async () => {
    const adapter = createMcpAdapter('claude-terminal');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    const configIndex = args?.findIndex((a) => a === '--mcp-config') ?? -1;
    expect(configIndex).toBeGreaterThanOrEqual(0);
    await prepared.dispose();
  });

  it('Given the claude-terminal adapter with an empty server set, Then args include --strict-mcp-config but no --mcp-config (order.md:152,172)', async () => {
    const adapter = createMcpAdapter('claude-terminal');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    expect(args?.find((a) => a === '--mcp-config')).toBeUndefined();
    await prepared.dispose();
  });
});

describe('Mock adapter (MCP-MOCK)', () => {
  it('Given the mock adapter, When prepared with servers, Then the resolved server names and transports are exposed for test inspection (要件66)', async () => {
    const adapter = createMcpAdapter('mock');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const exposed = (prepared as { resolvedServers?: ResolvedMcpServers }).resolvedServers;
    expect(exposed).toBeDefined();
    expect(Object.keys(exposed?.servers ?? {}).sort()).toEqual(['common-tools', 'remote-tools']);
    await prepared.dispose();
  });

  it('Given the mock adapter, When prepared with empty servers, Then resolvedServers is empty (要件66)', async () => {
    const adapter = createMcpAdapter('mock');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const exposed = (prepared as { resolvedServers?: ResolvedMcpServers }).resolvedServers;
    expect(exposed?.enabled).toBe(false);
    expect(Object.keys(exposed?.servers ?? {})).toEqual([]);
    await prepared.dispose();
  });
});
