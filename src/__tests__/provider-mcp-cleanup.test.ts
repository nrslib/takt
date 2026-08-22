import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// New modules under test (implemented in the following `implement` step).
import { createMcpAdapter, type ResolvedMcpServers, type ProviderMcpContext } from '../infra/providers/mcp/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-CLEANUP` (要件28)
 *   - agent 実行後、失敗・abort・timeout を含むすべての経路で cleanup する
 *   - 一時ファイル、引数、環境変数、SDK option を adapter が所有する
 *
 * 反例:
 *   - 成功時だけ cleanup する
 *   - abort 時に一時ディレクトリが残存する
 *
 * 検証方針:
 *   - prepare で一時ディレクトリが作られる provider で、dispose 呼出後にパスが消えることを確認
 *   - abort / timeout を模擬した dispose 呼出でも cleanup される
 */

let workDir: string;

function resolvedServers(): ResolvedMcpServers {
  return {
    enabled: true,
    servers: {
      'common-tools': { type: 'stdio', command: 'srv', env: { TOKEN: 'x' } },
    },
    serverNames: ['common-tools'],
    identity: 'common-tools:stdio',
  };
}

function baseContext(overrides: Partial<ProviderMcpContext> = {}): ProviderMcpContext {
  return {
    cwd: workDir,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('ProviderMcpAdapter cleanup (MCP-CLEANUP)', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'takt-mcp-cleanup-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('Given a prepared claude adapter, When dispose is called, Then the temporary config directory is removed', async () => {
    const adapter = createMcpAdapter('claude');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    expect(typeof prepared.dispose).toBe('function');
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared claude-terminal adapter, When dispose is called after abort, Then temp config is removed', async () => {
    const adapter = createMcpAdapter('claude-terminal');
    const controller = new AbortController();
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ abortSignal: controller.signal }));
    controller.abort();
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared copilot adapter, When dispose is called, Then the temporary additional-mcp-config file is removed', async () => {
    const adapter = createMcpAdapter('copilot');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared copilot adapter, When abort fires before dispose, Then dispose still removes the temp file', async () => {
    const adapter = createMcpAdapter('copilot');
    const controller = new AbortController();
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ abortSignal: controller.signal }));
    controller.abort();
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared kiro adapter, When dispose is called, Then the temporary kiro mcp config is removed', async () => {
    const adapter = createMcpAdapter('kiro');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared kiro adapter, When abort fires, Then dispose still removes the temp config', async () => {
    const adapter = createMcpAdapter('kiro');
    const controller = new AbortController();
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ abortSignal: controller.signal }));
    controller.abort();
    const path = (prepared as { path?: string }).path;
    expect(path).toBeDefined();
    await prepared.dispose();
    expect(existsSync(path!)).toBe(false);
  });

  it('Given a prepared cursor adapter, When dispose is called, Then the temporary config root directory is removed', async () => {
    const adapter = createMcpAdapter('cursor');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    const configRoot = (prepared as { configRoot?: string }).configRoot;
    expect(configRoot).toBeDefined();
    await prepared.dispose();
    expect(existsSync(configRoot!)).toBe(false);
  });

  it('Given a prepared cursor adapter, When abort fires before dispose, Then dispose still removes the config root', async () => {
    const adapter = createMcpAdapter('cursor');
    const controller = new AbortController();
    const prepared = await adapter.prepare(resolvedServers(), baseContext({ abortSignal: controller.signal }));
    const configRoot = (prepared as { configRoot?: string }).configRoot;
    expect(configRoot).toBeDefined();
    controller.abort();
    await prepared.dispose();
    expect(existsSync(configRoot!)).toBe(false);
  });

  it('Given a prepared cursor adapter, When dispose is called twice, Then the second call does not throw', async () => {
    const adapter = createMcpAdapter('cursor');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    await prepared.dispose();
    await expect(prepared.dispose()).resolves.toBeUndefined();
  });

  it('Given a prepared claude-sdk adapter (no temp file), When dispose is called, Then it does not throw', async () => {
    const adapter = createMcpAdapter('claude-sdk');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    await expect(prepared.dispose()).resolves.toBeUndefined();
  });

  it('Given a prepared adapter, When dispose is called twice, Then the second call does not throw', async () => {
    const adapter = createMcpAdapter('claude');
    const prepared = await adapter.prepare(resolvedServers(), baseContext());
    await prepared.dispose();
    await expect(prepared.dispose()).resolves.toBeUndefined();
  });

  it('Given an MCP-disabled server set, When prepared, Then no temp artifacts are created and dispose is a no-op', async () => {
    const adapter = createMcpAdapter('claude');
    const empty: ResolvedMcpServers = { enabled: false, servers: {}, serverNames: [], identity: '' };
    const prepared = await adapter.prepare(empty, baseContext());
    const path = (prepared as { path?: string }).path;
    expect(path).toBeUndefined();
    await expect(prepared.dispose()).resolves.toBeUndefined();
  });
});
