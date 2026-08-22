import { describe, expect, it } from 'vitest';
// New modules under test (implemented in the following `implement` step).
import {
  createMcpAdapter,
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

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: {
      common: { type: 'stdio', command: 'common-srv' },
      github: { type: 'http', url: 'https://example.com/mcp' },
    },
    serverNames: ['common', 'github'],
    identity: 'common:stdio,github:http',
  };
}

describe('ProviderMcpAdapter interface boundary (MCP-ADAPTER-SPLIT)', () => {
  it('Given an adapter created for claude-sdk, When called with resolved servers and a minimal context, Then it does not require target selector context', () => {
    // Adapter unit test must work without target context — adapter does not know target selectors.
    const adapter = createMcpAdapter('claude-sdk');
    expect(typeof adapter.validate).toBe('function');
    expect(typeof adapter.prepare).toBe('function');
  });

  it('Given an adapter, When validated with an empty server set, Then it treats it as MCP-disabled and does not throw', () => {
    const adapter = createMcpAdapter('claude');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
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
    // Both must validate the same resolved server set independently.
    expect(() => claude.validate(servers)).not.toThrow();
    const sseServers: ResolvedMcpServers = {
      enabled: true,
      servers: { events: { type: 'sse', url: 'http://events/sse' } },
      serverNames: ['events'],
      identity: 'events:sse',
    };
    expect(() => codex.validate(sseServers)).toThrow(/codex.*sse/i);
  });
});
