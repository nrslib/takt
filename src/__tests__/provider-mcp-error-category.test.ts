import { describe, expect, it } from 'vitest';
import { createMcpAdapter, type ResolvedMcpServers, type ProviderMcpContext } from '../infra/providers/mcp/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ERROR-CATEGORY` (要件76)
 *   - startup failure/tool failure/abort/timeout を provider error category へ正しく変換する
 *
 * 反例:
 *   - MCP 起動失敗を generic error に変換する
 *   - abort を無視する
 *
 * 補足:
 *   各 provider adapter は MCP 起動失敗を provider の failure category へ分類する。
 *   識別可能な failure category は AgentFailureCategory に従う:
 *     - external_abort, part_timeout, provider_error, stream_idle_timeout
 */

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: { 'common-tools': { type: 'stdio', command: 'srv' } },
    serverNames: ['common-tools'],
    identity: 'common-tools:stdio',
  };
}

function baseContext(overrides: Partial<ProviderMcpContext> = {}): ProviderMcpContext {
  return {
    cwd: '/tmp/test',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('ProviderMcpAdapter error category mapping (MCP-ERROR-CATEGORY)', () => {
  it('Given a codex adapter and an MCP startup failure, When classifyFailure is called, Then it returns provider_error category', () => {
    const adapter = createMcpAdapter('codex');
    const result = adapter.classifyFailure(new Error('MCP server failed to start'));
    expect(result.category).toBe('provider_error');
  });

  it('Given a claude adapter and an abort signal, When classifyFailure is called, Then it returns external_abort category', () => {
    const adapter = createMcpAdapter('claude');
    const result = adapter.classifyFailure(new DOMException('Aborted', 'AbortError'));
    expect(result.category).toBe('external_abort');
  });

  it('Given a codex adapter and a timeout, When classifyFailure is called, Then it returns part_timeout category', () => {
    const adapter = createMcpAdapter('codex');
    const result = adapter.classifyFailure(new Error('Part timeout after 30000ms'));
    expect(result.category).toBe('part_timeout');
  });

  it('Given an opencode adapter and a tool failure, When classifyFailure is called, Then it returns provider_error (not generic)', () => {
    const adapter = createMcpAdapter('opencode');
    const result = adapter.classifyFailure(new Error('MCP tool call failed'));
    // Tool failures must map to provider_error, not be silently swallowed.
    expect(result.category).toBe('provider_error');
  });

  it('Given a kiro adapter with --require-mcp-startup and a connection failure, When classifyFailure is called, Then it returns provider_error', () => {
    const adapter = createMcpAdapter('kiro');
    const result = adapter.classifyFailure(new Error('MCP startup required but connection failed'));
    expect(result.category).toBe('provider_error');
  });

  it('Given an adapter and no failure classifier, When prepare succeeds, Then the prepared object still has dispose (no silent error swallowing)', async () => {
    const adapter = createMcpAdapter('mock');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    expect(typeof prepared.dispose).toBe('function');
    await prepared.dispose();
  });
});
