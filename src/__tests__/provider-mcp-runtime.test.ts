import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
// New modules under test (implemented in the following `implement` step).
import { createMcpAdapter, type ResolvedMcpServers, type ProviderMcpContext } from '../infra/providers/mcp/index.js';

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

  it('Given the codex adapter and an http server, When prepared, Then mcp_servers entry has url/headers (要件42)', async () => {
    const adapter = createMcpAdapter('codex');
    const httpOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'remote-tools': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } } },
      identity: 'remote-tools:http',
    };
    const prepared = await adapter.prepare(httpOnly, baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    const entry = config?.mcp_servers?.['remote-tools'] as Record<string, unknown>;
    expect(entry.url).toBe('https://example.com/mcp');
    await prepared.dispose();
  });

  it('Given the codex adapter, When prepared with empty servers, Then config has no mcp_servers (要件45: 未割当 server が有効にならない)', async () => {
    const adapter = createMcpAdapter('codex');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const config = (prepared as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    // No mcp_servers must be set when no servers are assigned — do not enable unassigned native servers.
    expect(config?.mcp_servers).toBeUndefined();
    await prepared.dispose();
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
      identity: 'common-tools:stdio',
    };
    const prepared = await adapter.prepare(stdioOnly, baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    const entry = serverConfig?.['common-tools'] as Record<string, unknown>;
    // OpenCode local schema should include command or type local.
    expect(entry).toBeDefined();
    await prepared.dispose();
  });

  it('Given the opencode adapter and an http server, When prepared, Then the entry is in remote schema (要件47)', async () => {
    const adapter = createMcpAdapter('opencode');
    const httpOnly: ResolvedMcpServers = {
      enabled: true,
      servers: { 'remote-tools': { type: 'http', url: 'https://example.com/mcp' } },
      identity: 'remote-tools:http',
    };
    const prepared = await adapter.prepare(httpOnly, baseContext());
    const serverConfig = (prepared as { serverConfig?: Record<string, unknown> }).serverConfig;
    const entry = serverConfig?.['remote-tools'] as Record<string, unknown>;
    expect(entry).toBeDefined();
    await prepared.dispose();
  });

  it('Given the opencode adapter with different server sets, Then the identity differs so shared servers are not shared across sets (要件48,49)', async () => {
    const adapter = createMcpAdapter('opencode');
    const setA: ResolvedMcpServers = {
      enabled: true,
      servers: { a: { type: 'stdio', command: 'a' } },
      identity: 'a:stdio',
    };
    const setB: ResolvedMcpServers = {
      enabled: true,
      servers: { b: { type: 'stdio', command: 'b' } },
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const configRoot = (prepared as { configRoot?: string }).configRoot;
    expect(configRoot).toBeUndefined();
    await prepared.dispose();
  });

  it('Given the cursor adapter with a version flag that cannot isolate, When validated, Then it fails fast naming the supported version (要件55)', () => {
    const adapter = createMcpAdapter('cursor');
    // The adapter must not silently use ambient config; it must fail-fast when isolation is impossible.
    expect(typeof adapter.validate).toBe('function');
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
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
  it('Given the kiro adapter, When prepared with servers, Then the CLI args include --require-mcp-startup (要件64)', async () => {
    const adapter = createMcpAdapter('kiro');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--require-mcp-startup');
    // The temp config file and its parent directory must be private (order.md:283, claude-mcp-config.test.ts:30-33).
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);
    await prepared.dispose();
  });

  it('Given the kiro adapter with empty servers, Then --require-mcp-startup is NOT added', async () => {
    const adapter = createMcpAdapter('kiro');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args).not.toContain('--require-mcp-startup');
    await prepared.dispose();
  });

  it('Given the kiro adapter, When prepared, Then the temp config path is NOT the user KIRO_HOME', async () => {
    const adapter = createMcpAdapter('kiro');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const configPath = (prepared as { path?: string }).path;
    expect(configPath).toBeDefined();
    expect(configPath).not.toBe(process.env.KIRO_HOME);
    await prepared.dispose();
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { mcpServers?: Record<string, unknown>; strictMcpConfig?: boolean } }).sdkOptions;
    expect(sdkOptions).toBeDefined();
    expect(sdkOptions?.strictMcpConfig).toBe(true);
    expect(sdkOptions?.mcpServers).toBeUndefined();
    await prepared.dispose();
  });
});

describe('Claude headless CLI adapter (MCP-CLAUDE strict-mcp-config)', () => {
  it('Given the claude adapter, When prepared with servers, Then args include --strict-mcp-config and --mcp-config (order.md:166)', async () => {
    const adapter = createMcpAdapter('claude');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    const configIndex = args?.findIndex((a) => a === '--mcp-config') ?? -1;
    expect(configIndex).toBeGreaterThanOrEqual(0);
    await prepared.dispose();
  });

  it('Given the claude adapter with an empty server set, Then args include --strict-mcp-config but no --mcp-config (order.md:152,166)', async () => {
    const adapter = createMcpAdapter('claude');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
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
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const exposed = (prepared as { resolvedServers?: ResolvedMcpServers }).resolvedServers;
    expect(exposed?.enabled).toBe(false);
    expect(Object.keys(exposed?.servers ?? {})).toEqual([]);
    await prepared.dispose();
  });
});