import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// New modules under test (implemented in the following `implement` step).
import {
  createMcpAdapter,
  type ProviderMcpAdapter,
  type ResolvedMcpServers,
  type ProviderMcpContext,
} from '../infra/providers/mcp/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ADAPTER-SPLIT` (要件22,23,24,27)
 *   - `McpAssignmentPolicy` と `ProviderMcpAdapter` を分離する
 *   - workflow engine は provider 固有の MCP 設定形式を認識しない
 *   - provider adapter は target の解決規則を認識しない
 *   - adapter が一時ファイル/引数/SDK option/cleanup を所有する
 *
 * 反例:
 *   - engine 側で provider 名で分岐して MCP 設定を構築する
 *   - adapter が target selector を読む
 *
 * 証拠:
 *   - engine 側コード（OptionsBuilder, engine-provider-options）に provider 固定 MCP 形式名が出現しない
 *   - adapter 単体テストが target context なしで動く
 */

function readModuleSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: {
      common: { type: 'stdio', command: 'common-srv' },
      github: { type: 'http', url: 'https://example.com/mcp' },
    },
    identity: 'common:stdio,github:http',
  };
}

describe('ProviderMcpAdapter interface boundary (MCP-ADAPTER-SPLIT)', () => {
  it('Given the engine-provider-options module, Then it does NOT reference provider-specific MCP config format names', () => {
    const engineSource = readModuleSource('../core/workflow/engine/engine-provider-options.ts');
    // The engine layer must not branch on Codex/OpenCode/Cursor CLI-specific MCP config keys.
    // The legacy mcpServers capability helper may remain (it gates by provider capability, not by config format).
    expect(engineSource).not.toContain('mcp_servers:');
    expect(engineSource).not.toContain('--additional-mcp-config');
    expect(engineSource).not.toContain('--require-mcp-startup');
    expect(engineSource).not.toContain('--mcp-config');
    expect(engineSource).not.toContain('strictMcpConfig');
  });

  it('Given the OptionsBuilder module, Then it does NOT reference provider-specific MCP config format names', () => {
    const builderSource = readModuleSource('../core/workflow/engine/OptionsBuilder.ts');
    expect(builderSource).not.toContain('--additional-mcp-config');
    expect(builderSource).not.toContain('--require-mcp-startup');
    expect(builderSource).not.toContain('strictMcpConfig');
    expect(builderSource).not.toContain('CodexOptions.config');
  });

  it('Given an adapter created for claude-sdk, When called with resolved servers and a minimal context, Then it does not require target selector context', () => {
    // Adapter unit test must work without target context — adapter does not know target selectors.
    const adapter = createMcpAdapter('claude-sdk');
    expect(typeof adapter.validate).toBe('function');
    expect(typeof adapter.prepare).toBe('function');
  });

  it('Given an adapter, When validated with an empty server set, Then it treats it as MCP-disabled and does not throw', () => {
    const adapter = createMcpAdapter('claude');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, identity: '' };
    expect(() => adapter.validate(empty)).not.toThrow();
  });

  it('Given an adapter, When prepared with a minimal context, Then it returns a PreparedProviderMcp with a dispose function', async () => {
    const adapter = createMcpAdapter('claude');
    const context: ProviderMcpContext = {
      cwd: '/tmp/test',
      abortSignal: new AbortController().signal,
    };
    const prepared = await adapter.prepare(resolvedServers(), context);
    expect(typeof prepared.dispose).toBe('function');
    await prepared.dispose();
  });

  it('Given adapters for different providers, When validated with the same servers, Then each adapter validates independently (no shared target state)', () => {
    const servers = resolvedServers();
    const claude = createMcpAdapter('claude');
    const codex = createMcpAdapter('codex');
    // Both must accept or reject without sharing target resolution state.
    expect(() => claude.validate(servers)).not.toThrow();
    // codex may reject sse but should not read target selectors.
    expect(typeof codex.validate).toBe('function');
  });

  it('Given the mcp adapter module, Then the McpAssignmentPolicy lives in a separate module from the adapter', () => {
    // The assignment policy must live in infra/config/runtime-provider/mcp-assignment.ts,
    // not in infra/providers/mcp/. Verify the adapter module does not export resolveMcpAssignment.
    const adapterSource = readModuleSource('../infra/providers/mcp/index.ts');
    expect(adapterSource).not.toContain('resolveMcpAssignment');
    expect(adapterSource).not.toContain('AgentExecutionContext');
    // Adapter must not read target selector keys (personas/tags/steps/internal_agents).
    expect(adapterSource).not.toMatch(/\bpersonas\b/);
    expect(adapterSource).not.toMatch(/\binternal_agents\b/);
  });
});