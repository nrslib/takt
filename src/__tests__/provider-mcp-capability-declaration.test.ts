import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
// New modules under test (implemented in the following `implement` step).
import { getProvider, ProviderRegistry } from '../infra/providers/index.js';
import {
  providerSupportsMcpServers,
} from '../infra/providers/provider-capabilities.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-CAPABILITY-DECLARE` (要件25,26,107)
 *   - provider 実装が MCP capability と対応 transport を宣言する
 *   - 固定 provider 名 Set（`MCP_SERVER_PROVIDERS`）を廃止する
 *   - `provider-capabilities.ts` は `getProvider(p).supportedMcpTransports` を参照する
 *
 * 反例:
 *   - `provider-capabilities.ts` に provider 名 Set が残る
 *   - provider が `supportedMcpTransports` を宣言しない
 *
 * 注意:
 *   既存 `provider-capabilities.test.ts` は cursor/kiro/copilot などが mcpServers 未対応
 *   であることを前提としているが、issue #1137 でこれらは runtime MCP assignment を
 *   受け付けるようになる。既存テストは実装ステップで更新される想定。
 *   このファイルは新規の宣言ベース capability 契約を検証する。
 */

function readModuleSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Provider MCP capability declaration (MCP-CAPABILITY-DECLARE)', () => {
  it('Given the provider-capabilities module, Then it does NOT contain a fixed MCP_SERVER_PROVIDERS set', () => {
    const source = readModuleSource('../infra/providers/provider-capabilities.ts');
    expect(source).not.toContain('MCP_SERVER_PROVIDERS');
    expect(source).not.toContain('new Set<ProviderType>([');
  });

  it('Given the provider-capabilities module, Then providerSupportsMcpServers is derived from the provider implementation', () => {
    const source = readModuleSource('../infra/providers/provider-capabilities.ts');
    // The capability must be resolved from the provider instance, not from a fixed set.
    expect(source).toContain('supportedMcpTransports');
    expect(source).toContain('getProvider(');
  });

  it('Given the Provider interface, Then it declares supportedMcpTransports as a readonly set', () => {
    const source = readModuleSource('../infra/providers/types.ts');
    expect(source).toContain('supportedMcpTransports');
    // The transport declaration must be a ReadonlySet (or readonly array) so it is fixed per provider.
    expect(source).toMatch(/supportedMcpTransports.*Readonly/);
  });

  it('Given claude-sdk provider, Then it declares stdio/sse/http transports', () => {
    const provider = getProvider('claude-sdk');
    const transports = provider.supportedMcpTransports;
    expect(transports).toBeDefined();
    expect(transports!.has('stdio')).toBe(true);
    expect(transports!.has('sse')).toBe(true);
    expect(transports!.has('http')).toBe(true);
  });

  it('Given codex provider, Then it declares the transports it actually supports (stdio + http, not sse)', () => {
    const provider = getProvider('codex');
    const transports = provider.supportedMcpTransports;
    expect(transports).toBeDefined();
    expect(transports!.has('stdio')).toBe(true);
    expect(transports!.has('http')).toBe(true);
    // Codex does not support SSE per order.md:178-179 (stdio + Streamable HTTP only).
    expect(transports!.has('sse')).toBe(false);
  });

  it('Given opencode provider, Then it declares stdio + http transports', () => {
    const provider = getProvider('opencode');
    const transports = provider.supportedMcpTransports;
    expect(transports).toBeDefined();
    expect(transports!.has('stdio')).toBe(true);
    expect(transports!.has('http')).toBe(true);
  });

  it('Given cursor provider, Then it declares the transports it supports for the adapter to consume', () => {
    const provider = getProvider('cursor');
    const transports = provider.supportedMcpTransports;
    expect(transports).toBeDefined();
  });

  it('Given mock provider, Then it declares stdio transport for fixture support', () => {
    const provider = getProvider('mock');
    const transports = provider.supportedMcpTransports;
    expect(transports).toBeDefined();
    expect(transports!.has('stdio')).toBe(true);
  });

  it('Given a provider that supports MCP servers, Then providerSupportsMcpServers returns true', () => {
    // After the refactor, providers that declare any transport are MCP-capable.
    expect(providerSupportsMcpServers('claude-sdk')).toBe(true);
    expect(providerSupportsMcpServers('codex')).toBe(true);
    expect(providerSupportsMcpServers('opencode')).toBe(true);
    expect(providerSupportsMcpServers('mock')).toBe(true);
  });

  it('Given cursor/kiro/copilot providers, Then they declare stdio+http transports and providerSupportsMcpServers returns true', () => {
    // cursor/kiro/copilot declare stdio+http (see their provider implementations).
    for (const providerName of ['cursor', 'kiro', 'copilot'] as const) {
      const provider = getProvider(providerName);
      const transports = provider.supportedMcpTransports;
      expect(transports).toBeDefined();
      expect(transports!.has('stdio')).toBe(true);
      expect(transports!.has('http')).toBe(true);
      expect(providerSupportsMcpServers(providerName)).toBe(true);
    }
  });

  it('Given a provider that declares an empty transport set, Then providerSupportsMcpServers returns false (要件29, empty set = MCP disabled)', () => {
    // Inject a fake provider whose `supportedMcpTransports` is an empty set
    // into the registry and call `providerSupportsMcpServers` directly so the
    // resolver's contract (`mcpTransports.size > 0` → false on empty set,
    // order.md:152, 要件29) is exercised through the real function path.
    const emptyTransportsProvider = {
      supportedMcpTransports: new Set<'stdio' | 'sse' | 'http'>([]),
      supportsStructuredOutput: false,
      supportsIsolatedStructuredExecution: false,
      supportsNativeImageInput: false,
      supportsStrictInternalAgentIsolation: false,
      getRuntimeInstructions: () => null,
      keepsAllowedToolWithoutEdit: () => true,
      setup: () => ({ call: async () => ({} as never) }),
      setupIsolatedStructured: () => ({ call: async () => ({} as never) }),
    } as unknown as ReturnType<typeof getProvider>;

    const registry = ProviderRegistry.getInstance();
    const getSpy = vi.spyOn(registry, 'get').mockImplementation(() => emptyTransportsProvider);
    try {
      // Call the real `providerSupportsMcpServers` which goes through
      // `resolveProviderCapabilities` → `getProvider` → the injected empty-set
      // provider. An empty transport set must resolve to MCP-disabled.
      const result = providerSupportsMcpServers('mock');
      expect(result).toBe(false);
    } finally {
      getSpy.mockRestore();
    }
  });
});