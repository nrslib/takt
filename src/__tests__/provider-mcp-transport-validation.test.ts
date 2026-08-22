import { describe, expect, it } from 'vitest';
// New modules under test (implemented in the following `implement` step).
import { createMcpAdapter, type ResolvedMcpServers } from '../infra/providers/mcp/index.js';
import { getProvider } from '../infra/providers/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-TRANSPORT-VALIDATE` (要件29,30,69,70,108)
 *   - 空の server 集合は MCP 無効として扱う
 *   - 未対応 provider/transport は fail-fast（provider名/server名/transport/対応transport/runtime.yaml path 含む）
 *   - 推測変換・黙除外しない
 *   - cursor/kiro/copilot の log.info 無視を廃止
 *
 * 反例:
 *   - 未対応 transport を stdio へ推測変換する
 *   - 未対応 provider で mcpServers を log.info 無視する
 *   - サーバを黙って除外する
 */

function serversWith(overrides: ResolvedMcpServers['servers']): ResolvedMcpServers {
  return {
    enabled: true,
    servers: overrides,
    serverNames: Object.keys(overrides).sort(),
    identity: Object.keys(overrides).sort().join(','),
  };
}

describe('ProviderMcpAdapter transport validation (MCP-TRANSPORT-VALIDATE)', () => {
  it('Given an empty server set, When validated, Then it is MCP-disabled and does not throw (要件29)', () => {
    const adapter = createMcpAdapter('claude-sdk');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    expect(() => adapter.validate(empty)).not.toThrow();
  });

  it('Given a codex adapter and an sse server, When validated, Then it fails fast naming provider/server/transport and supported transports', () => {
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      'legacy-events': { type: 'sse', url: 'http://legacy.local/sse' },
    });
    expect(() => adapter.validate(servers)).toThrow(/codex/);
    expect(() => adapter.validate(servers)).toThrow(/legacy-events/);
    expect(() => adapter.validate(servers)).toThrow(/sse/);
    // Error must list the supported transports so the user knows what to switch to.
    expect(() => adapter.validate(servers)).toThrow(/stdio|http/);
  });

  it('Given a codex adapter and an sse server, When validated, Then the error includes the runtime.yaml source path', () => {
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      'legacy-events': { type: 'sse', url: 'http://legacy.local/sse' },
    });
    // The adapter must receive a source path in context and include it in the error.
    expect(() =>
      adapter.validate(servers, { sourcePath: '<project>/.takt/runtime.yaml' }),
    ).toThrow(/runtime\.yaml/);
  });

  it('Given a codex adapter and a stdio server, When validated, Then it does not throw (要件41)', () => {
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      'local-tools': { type: 'stdio', command: 'srv' },
    });
    expect(() => adapter.validate(servers)).not.toThrow();
  });

  it('Given a codex adapter and an http server, When validated, Then it does not throw (要件42)', () => {
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      'remote-tools': { type: 'http', url: 'https://example.com/mcp' },
    });
    expect(() => adapter.validate(servers)).not.toThrow();
  });

  it('Given an opencode adapter and an sse server, When validated, Then it fails fast (opencode supports local/remote only)', () => {
    const adapter = createMcpAdapter('opencode');
    const servers = serversWith({
      'legacy-events': { type: 'sse', url: 'http://legacy.local/sse' },
    });
    expect(() => adapter.validate(servers)).toThrow(/opencode/);
    expect(() => adapter.validate(servers)).toThrow(/sse/);
  });

  it('Given a claude-sdk adapter and all three transports, When validated, Then it accepts them (要件31,33)', () => {
    const adapter = createMcpAdapter('claude-sdk');
    const servers = serversWith({
      stdio: { type: 'stdio', command: 'srv' },
      sse: { type: 'sse', url: 'http://x/sse' },
      http: { type: 'http', url: 'https://x/mcp' },
    });
    expect(() => adapter.validate(servers)).not.toThrow();
  });

  it('Given a codex adapter, When an unsupported server is mixed with supported servers, Then it fails for the unsupported one and does NOT silently drop it', () => {
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      supported: { type: 'stdio', command: 'srv' },
      unsupported: { type: 'sse', url: 'http://x/sse' },
    });
    expect(() => adapter.validate(servers)).toThrow(/unsupported/);
  });

  it.each(['cursor', 'kiro', 'copilot'] as const)('Given the %s provider adapter, When a stdio server is assigned, Then validation accepts it and preparation materializes it instead of dropping it (要件30,108)', async (provider) => {
    const adapter = createMcpAdapter(provider);
    const servers = serversWith({
      'common-tools': { type: 'stdio', command: 'srv' },
    });
    expect(() => adapter.validate(servers)).not.toThrow();
    const prepared = await adapter.prepare(servers, { cwd: '/tmp/provider-mcp-transport-validation' });
    expect(prepared.args ?? prepared.sdkOptions ?? prepared.config ?? prepared.serverConfig ?? prepared.configRoot).toBeDefined();
    await prepared.dispose();
  });

  it('Given a provider that does not declare a transport in its capability, When validating that transport, Then the adapter fails fast rather than guessing a different transport (要件70)', () => {
    const codexProvider = getProvider('codex');
    const supported = codexProvider.supportedMcpTransports;
    expect(supported?.has('sse')).toBe(false);
    // The adapter must reject sse, not convert it to http silently.
    const adapter = createMcpAdapter('codex');
    const servers = serversWith({
      'legacy-events': { type: 'sse', url: 'http://legacy.local/sse' },
    });
    expect(() => adapter.validate(servers)).toThrow(/sse/);
  });

  it('Given an MCP-incompatible provider, When validating an assigned server, Then the unified error names provider/server/transport/source', () => {
    const adapter = createMcpAdapter('pi');
    const servers = serversWith({
      'local-tools': { type: 'stdio', command: 'srv' },
    });
    const validate = (): void => adapter.validate(servers, {
      sourcePath: '<project>/.takt/runtime.yaml',
    });
    expect(validate).toThrow(/Provider "pi"/);
    expect(validate).toThrow(/local-tools/);
    expect(validate).toThrow(/stdio/);
    expect(validate).toThrow(/Supported transports: \(none\)/);
    expect(validate).toThrow(/runtime\.yaml/);
  });
});
