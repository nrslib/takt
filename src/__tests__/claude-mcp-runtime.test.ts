import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
// New modules under test (implemented in the following `implement` step).
import { createMcpAdapter, type ResolvedMcpServers, type ProviderMcpContext } from '../infra/providers/mcp/index.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-CLAUDE-SDK` (要件31,32,33)
 *   - `claude-sdk` が SDK の `mcpServers` option へ解決済み server を渡す
 *   - `strictMcpConfig: true` を設定する
 *   - stdio/SSE/Streamable HTTP の変換と validation を行う
 * - `MCP-CLAUDE-HEADLESS` (要件34,35,36)
 *   - `claude` が既存の一時 `--mcp-config` 生成を runtime resolver へ接続する
 *   - `--strict-mcp-config` を併用する
 *   - 一時ディレクトリと設定ファイルを成功・失敗・abort 時に削除する
 * - `MCP-CLAUDE-TERMINAL` (要件37,38,39)
 *   - `claude-terminal` が既存の一時 `--mcp-config` 生成を runtime resolver へ接続する
 *   - `--strict-mcp-config` を併用する
 *   - terminal session の開始失敗や中断を含めて cleanup する
 *
 * 反例:
 *   - runtime MCP でも `strictMcpConfig` を付けない
 *   - abort 時に一時ファイルが残存する
 */

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: {
      'common-tools': { type: 'stdio', command: 'srv' },
      github: { type: 'http', url: 'https://example.com/mcp' },
    },
    serverNames: ['common-tools', 'github'],
    identity: 'common-tools:stdio,github:http',
  };
}

function baseContext(overrides: Partial<ProviderMcpContext> = {}): ProviderMcpContext {
  return {
    cwd: '/tmp/test',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('Claude Agent SDK adapter (MCP-CLAUDE-SDK)', () => {
  it('Given the claude-sdk adapter, When prepared with servers, Then the SDK options include strictMcpConfig: true and mcpServers', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { strictMcpConfig?: boolean; mcpServers?: unknown } }).sdkOptions;
    expect(sdkOptions).toBeDefined();
    expect(sdkOptions?.strictMcpConfig).toBe(true);
    expect(sdkOptions?.mcpServers).toBeDefined();
    await prepared.dispose();
  });

  it('Given the claude-sdk adapter, When prepared with stdio+http servers, Then both are converted to SDK format', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { mcpServers?: Record<string, unknown> } }).sdkOptions;
    const servers = sdkOptions?.mcpServers as Record<string, unknown>;
    expect(servers['common-tools']).toBeDefined();
    expect(servers['github']).toBeDefined();
    await prepared.dispose();
  });

  it('Given the claude-sdk adapter, When prepared with empty servers, Then mcpServers is undefined but strictMcpConfig stays true (order.md:152,160)', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { strictMcpConfig?: boolean; mcpServers?: unknown } }).sdkOptions;
    // Empty server set is MCP-disabled so no mcpServers option is passed, but
    // strictMcpConfig remains true to suppress ambient project/user/plugin
    // MCP config (order.md:152,160).
    expect(sdkOptions?.mcpServers).toBeUndefined();
    expect(sdkOptions?.strictMcpConfig).toBe(true);
    await prepared.dispose();
  });

  it('Given the claude-sdk adapter, When prepared with an sse server, Then it is converted to SDK format', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const sseServers: ResolvedMcpServers = {
      enabled: true,
      servers: { events: { type: 'sse', url: 'http://x/sse' } },
      serverNames: ['events'],
      identity: 'events:sse',
    };
    const prepared = await adapter.prepare(sseServers, baseContext());
    const sdkOptions = (prepared as { sdkOptions?: { mcpServers?: Record<string, unknown> } }).sdkOptions;
    expect(sdkOptions?.mcpServers?.events).toBeDefined();
    await prepared.dispose();
  });

});

describe('Claude headless CLI adapter (MCP-CLAUDE-HEADLESS)', () => {
  it('Given the claude adapter, When prepared with servers, Then the CLI args include --mcp-config and --strict-mcp-config', async () => {
    const adapter = createMcpAdapter('claude');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    const mcpConfigIndex = args?.indexOf('--mcp-config');
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    await prepared.dispose();
  });

  it('Given the claude adapter, When prepared with servers, Then the --mcp-config path points to a temp file that exists', async () => {
    const adapter = createMcpAdapter('claude');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    const mcpConfigIndex = args?.indexOf('--mcp-config') ?? -1;
    const path = mcpConfigIndex >= 0 ? args?.[mcpConfigIndex + 1] : undefined;
    expect(path).toBeDefined();
    if (path === undefined) {
      throw new Error('Expected a Claude MCP config path');
    }
    expect(existsSync(path)).toBe(true);
    await prepared.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it('Given a resolved server carrying log-safe-source metadata, When prepared, Then the temp config contains only the public server fields', async () => {
    const adapter = createMcpAdapter('claude');
    const interpolated = interpolateMcpEnv(
      { type: 'stdio', command: '${MCP_TEST_CMD}' },
      { MCP_TEST_CMD: 'srv' } as NodeJS.ProcessEnv,
    );
    const servers: ResolvedMcpServers = {
      enabled: true,
      servers: { 'common-tools': interpolated },
      serverNames: ['common-tools'],
      identity: 'common-tools:stdio',
    };
    const prepared = await adapter.prepare(servers, baseContext());
    try {
      const path = (prepared as { path?: string }).path;
      if (path === undefined) {
        throw new Error('Expected a Claude MCP config path');
      }
      const raw = readFileSync(path, 'utf-8');
      expect(raw).not.toContain('__taktMcpSafeSource');
      const payload = JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(payload.mcpServers['common-tools']).toEqual({ type: 'stdio', command: 'srv' });
    } finally {
      await prepared.dispose();
    }
  });

  it('Given the claude adapter, When prepared with empty servers, Then --mcp-config is NOT added but --strict-mcp-config is (order.md:152,166)', async () => {
    const adapter = createMcpAdapter('claude');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args).not.toContain('--mcp-config');
    // strictMcpConfig is a separate axis from MCP-disabled empty set; it
    // stays on to suppress ambient project/user/plugin MCP config
    // (order.md:152,166).
    expect(args).toContain('--strict-mcp-config');
    await prepared.dispose();
  });
});

describe('Claude terminal adapter (MCP-CLAUDE-TERMINAL)', () => {
  it('Given the claude-terminal adapter, When prepared with servers, Then the CLI args include --mcp-config and --strict-mcp-config', async () => {
    const adapter = createMcpAdapter('claude-terminal');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const args = (prepared as { args?: string[] }).args;
    expect(args).toBeDefined();
    expect(args).toContain('--strict-mcp-config');
    const mcpConfigIndex = args?.indexOf('--mcp-config');
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    await prepared.dispose();
  });

  it('Given the claude-terminal adapter, When prepared with empty servers, Then --mcp-config is NOT added but --strict-mcp-config is (order.md:152,172)', async () => {
    const adapter = createMcpAdapter('claude-terminal');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const args = (prepared as { args?: string[] }).args ?? [];
    expect(args).not.toContain('--mcp-config');
    // strictMcpConfig stays on to suppress ambient project/user/plugin MCP
    // config even for an empty set (order.md:152,172).
    expect(args).toContain('--strict-mcp-config');
    await prepared.dispose();
  });
});
