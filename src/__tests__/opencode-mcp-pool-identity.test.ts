import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSectionSchema } from '../infra/config/runtime-provider/mcp-schema.js';
import { resolveMcpAssignment } from '../infra/config/runtime-provider/mcp-assignment.js';
import { createOpenCodeMcpAdapter } from '../infra/providers/mcp/opencode.js';
import { acquireOpenCodeClient, resetSharedServerPool } from '../infra/opencode/server-pool.js';
import { readOpenCodeModelContextWindow } from '../infra/opencode/model-context-window.js';
import { startOpenCodeServer } from '../infra/opencode/server-process.js';
import type { ManagedOpenCodeTransport } from '../infra/opencode/transport.js';

const temporaryDirectories: string[] = [];

vi.mock('../infra/opencode/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/opencode/runtime.js')>();
  return {
    ...actual,
    resolveOpenCodeRuntime: vi.fn(async () => ({
      ...actual.openCodeRuntimeSelection(),
      version: actual.openCodeRuntimeSelection().generation === 'v1' ? '1.18.2' : '2.0.0',
    })),
  };
});

vi.mock('../infra/opencode/server-process.js', () => ({ startOpenCodeServer: vi.fn() }));

function transport(): ManagedOpenCodeTransport {
  return {
    sdkState: { directory: '/test/managed/opencode', stale: false },
    getModelOutputLimit: vi.fn(async () => 32_000),
    session: {
      create: vi.fn(), get: vi.fn(), messages: vi.fn(), promptAsync: vi.fn(),
      abort: vi.fn(), summarize: vi.fn(),
    },
    event: { subscribe: vi.fn() },
    permission: { reply: vi.fn() },
    question: { reply: vi.fn(), reject: vi.fn() },
  };
}

async function prepare(headers: Record<string, string>) {
  const section = McpSectionSchema.parse({
    servers: { datadog: {
      type: 'http', url: 'https://example.com/mcp',
      headers,
    } },
    defaults: { servers: ['datadog'] },
  });
  const servers = resolveMcpAssignment(section, {
    persona: 'coder', tags: [], stepQualifiedName: 'default/implement',
    isWorkflowCallNode: false, isInternalAgent: false,
  });
  return createOpenCodeMcpAdapter().prepare(servers, {
    cwd: '/test/project', abortSignal: new AbortController().signal,
  });
}

describe.each(['v1', 'v2'] as const)('OpenCode %s MCP pool identity', (generation) => {
  beforeEach(() => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', generation);
    vi.stubEnv('TAKT_OPENCODE_PATH', 'opencode-test');
    vi.stubEnv('PROJECT_A_TOKEN', 'synthetic-project-a');
    vi.stubEnv('PROJECT_B_TOKEN', 'synthetic-project-b');
    vi.mocked(startOpenCodeServer).mockImplementation(async () => ({
      client: transport(), close: vi.fn(async () => {}), onError: () => () => {},
    }));
  });

  afterEach(() => {
    resetSharedServerPool();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['PROJECT_A_TOKEN', true],
    ['PROJECT_B_TOKEN', false],
  ] as const)('selects %s after releasing A (reuse=%s)', async (reference, reuse) => {
    const preparedA = await prepare({ Authorization: 'Bearer ${env:PROJECT_A_TOKEN}' });
    const preparedB = await prepare({ Authorization: `Bearer \${env:${reference}}` });
    try {
      const a = await acquireOpenCodeClient('opencode/model', undefined, undefined, undefined, undefined, preparedA);
      a.release();
      const b = await acquireOpenCodeClient('opencode/model', undefined, undefined, undefined, undefined, preparedB);
      try {
        expect(b.client === a.client).toBe(reuse);
        expect(startOpenCodeServer).toHaveBeenCalledTimes(reuse ? 1 : 2);
        const startup = vi.mocked(startOpenCodeServer).mock.calls.at(-1)![0];
        const mcp = startup.config.mcp as Record<string, unknown>;
        const servers = (generation === 'v1' ? mcp : mcp.servers) as Record<string, unknown>;
        expect(servers.datadog).toMatchObject({
          type: 'remote', url: 'https://example.com/mcp',
          headers: { Authorization: `Bearer {env:${reference}}` },
        });
      } finally { b.release(); }
    } finally {
      await preparedA.dispose();
      await preparedB.dispose();
    }
  });

  it.each([
    ['same headers in reverse order', { 'X-Tenant': 'tenant-a', Authorization: 'Bearer ${env:PROJECT_A_TOKEN}' }, true],
    ['different fixed tenant', { Authorization: 'Bearer ${env:PROJECT_A_TOKEN}', 'X-Tenant': 'tenant-b' }, false],
    ['different reference prefix', { Authorization: 'Token ${env:PROJECT_A_TOKEN}', 'X-Tenant': 'tenant-a' }, false],
    ['different reference position', { Authorization: '${env:PROJECT_A_TOKEN} Bearer', 'X-Tenant': 'tenant-a' }, false],
  ] as const)('applies %s after releasing A', async (_name, headers, reuse) => {
    const preparedA = await prepare({ Authorization: 'Bearer ${env:PROJECT_A_TOKEN}', 'X-Tenant': 'tenant-a' });
    const preparedB = await prepare(headers);
    try {
      const a = await acquireOpenCodeClient('opencode/model', undefined, undefined, undefined, undefined, preparedA);
      a.release();
      const b = await acquireOpenCodeClient('opencode/model', undefined, undefined, undefined, undefined, preparedB);
      try {
        expect(b.client === a.client).toBe(reuse);
        expect(startOpenCodeServer).toHaveBeenCalledTimes(reuse ? 1 : 2);
        const startup = vi.mocked(startOpenCodeServer).mock.calls.at(-1)![0];
        const mcp = startup.config.mcp as Record<string, unknown>;
        const servers = (generation === 'v1' ? mcp : mcp.servers) as Record<string, unknown>;
        expect(servers.datadog).toMatchObject(preparedB.serverConfig!.datadog!);
        expect(preparedB.identity).not.toContain('tenant-');
        expect(preparedB.identity).not.toContain('synthetic-project-a');
      } finally { b.release(); }
    } finally { await preparedA.dispose(); await preparedB.dispose(); }
  });

  it('uses a separate shared server for each external context allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-opencode-pool-identity-'));
    temporaryDirectories.push(root);
    const contextA = join(root, 'context-a');
    const contextB = join(root, 'context-b');
    mkdirSync(contextA);
    mkdirSync(contextB);
    const canonicalContextA = realpathSync(contextA);
    const canonicalContextB = realpathSync(contextB);
    const a = await acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, [contextA],
    );
    a.release();
    const b = await acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, [contextB],
    );

    try {
      expect(b.client).not.toBe(a.client);
      expect(startOpenCodeServer).toHaveBeenCalledTimes(2);
      const firstConfig = vi.mocked(startOpenCodeServer).mock.calls[0]![0].config;
      const secondConfig = vi.mocked(startOpenCodeServer).mock.calls[1]![0].config;
      if (generation === 'v1') {
        expect(firstConfig.permission).toMatchObject({
          external_directory: { '*': 'deny', [join(canonicalContextA, '*')]: 'allow' },
        });
        expect(secondConfig.permission).toMatchObject({
          external_directory: { '*': 'deny', [join(canonicalContextB, '*')]: 'allow' },
        });
      } else {
        expect(firstConfig.permissions).toContainEqual({
          action: 'external_directory', resource: join(canonicalContextA, '*'), effect: 'allow',
        });
        expect(secondConfig.permissions).toContainEqual({
          action: 'external_directory', resource: join(canonicalContextB, '*'), effect: 'allow',
        });
      }
    } finally {
      b.release();
    }
  });

  it('isolates different context windows while retaining the model and native settings', async () => {
    const a = await acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, 'same-session', undefined, false, undefined, undefined, 300_000, '/test/project',
    );
    a.release();
    const b = await acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, 'same-session', undefined, false, undefined, undefined, 500_000, '/test/project',
    );
    try {
      expect(b.client).not.toBe(a.client);
      expect(startOpenCodeServer).toHaveBeenCalledTimes(generation === 'v1' ? 4 : 2);
      const first = vi.mocked(startOpenCodeServer).mock.calls[generation === 'v1' ? 1 : 0]![0].config;
      const second = vi.mocked(startOpenCodeServer).mock.calls[generation === 'v1' ? 3 : 1]![0].config;
      if (generation === 'v1') {
        expect(first).toMatchObject({ model: 'opencode/model', provider: { opencode: { models: { model: { limit: { context: 300_000, output: 32_000 } } } } } });
        expect(second).toMatchObject({ model: 'opencode/model', provider: { opencode: { models: { model: { limit: { context: 500_000, output: 32_000 } } } } } });
        expect(vi.mocked(startOpenCodeServer).mock.calls[0]![0].config.provider).toBeUndefined();
        expect(vi.mocked(startOpenCodeServer).mock.calls[2]![0].config.provider).toBeUndefined();
      } else {
        expect(first).toMatchObject({ model: 'opencode/model', providers: { opencode: { models: { model: { limit: { context: 300_000 } } } } } });
        expect(second).toMatchObject({ model: 'opencode/model', providers: { opencode: { models: { model: { limit: { context: 500_000 } } } } } });
      }
    } finally {
      b.release();
    }
  });

  it('keeps the v1 output limit for each project and closes every metadata probe', async () => {
    if (generation !== 'v1') return;
    const closed = vi.fn(async () => {});
    vi.mocked(startOpenCodeServer).mockImplementation(async () => ({
      client: {
        ...transport(),
        getModelOutputLimit: vi.fn(async ({ directory }) => directory === '/test/a' ? 16_000 : 32_000),
      },
      close: closed,
      onError: () => () => {},
    }));
    const childProcessEnv = { PROJECT_A_TOKEN: 'synthetic-project-a' };
    const a = await acquireOpenCodeClient(
      'opencode/model', undefined, childProcessEnv, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/a',
    );
    a.release();
    const b = await acquireOpenCodeClient(
      'opencode/model', undefined, childProcessEnv, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/b',
    );
    try {
      expect(b.client).not.toBe(a.client);
      expect(startOpenCodeServer).toHaveBeenCalledTimes(4);
      expect(closed).toHaveBeenCalledTimes(2);
      const startups = vi.mocked(startOpenCodeServer).mock.calls;
      expect(startups[0]![0].childProcessEnv).toEqual(childProcessEnv);
      expect(startups[1]![0].childProcessEnv).toEqual(childProcessEnv);
      expect(startups[1]![0].config).toMatchObject({ provider: { opencode: { models: { model: { limit: { context: 500_000, output: 16_000 } } } } } });
      expect(startups[3]![0].config).toMatchObject({ provider: { opencode: { models: { model: { limit: { context: 500_000, output: 32_000 } } } } } });
    } finally {
      b.release();
    }
  });

  it('closes a v1 metadata probe and rejects an unknown output limit', async () => {
    if (generation !== 'v1') return;
    const closed = vi.fn(async () => {});
    vi.mocked(startOpenCodeServer).mockResolvedValue({
      client: { ...transport(), getModelOutputLimit: vi.fn(async () => { throw new Error('output metadata unavailable'); }) },
      close: closed,
      onError: () => () => {},
    });
    await expect(acquireOpenCodeClient(
      'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/project',
    )).rejects.toThrow('output metadata unavailable');
    expect(startOpenCodeServer).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('closes a v1 metadata probe when lookup times out', async () => {
    if (generation !== 'v1') return;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new Error('synthetic timeout')));
    const closed = vi.fn(async () => {});
    vi.mocked(startOpenCodeServer).mockResolvedValue({
      client: { ...transport(), getModelOutputLimit: vi.fn(() => new Promise<number>(() => {})) },
      close: closed,
      onError: () => () => {},
    });
    try {
      await expect(acquireOpenCodeClient(
        'opencode/model', undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, 500_000, '/test/project',
      )).rejects.toThrow('OpenCode v1 provider metadata lookup timed out');
      expect(startOpenCodeServer).toHaveBeenCalledOnce();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it('closes a v1 metadata probe when the call is aborted', async () => {
    if (generation !== 'v1') return;
    const controller = new AbortController();
    const closed = vi.fn(async () => {});
    vi.mocked(startOpenCodeServer).mockResolvedValue({
      client: { ...transport(), getModelOutputLimit: vi.fn(() => {
        controller.abort(new Error('synthetic cancellation'));
        return new Promise<number>(() => {});
      }) },
      close: closed,
      onError: () => () => {},
    });
    await expect(acquireOpenCodeClient(
      'opencode/model', undefined, undefined, controller.signal, undefined, undefined, false, undefined, undefined, 500_000, '/test/project',
    )).rejects.toThrow('synthetic cancellation');
    expect(startOpenCodeServer).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('does not start an extra server for auto limits with prepared MCP', async () => {
    const prepared = await prepare({ Authorization: 'Bearer ${env:PROJECT_A_TOKEN}' });
    try {
      expect(await readOpenCodeModelContextWindow({
        cwd: '/test/project', model: 'opencode/model', preparedMcp: prepared,
      })).toBeUndefined();
      expect(startOpenCodeServer).not.toHaveBeenCalled();
      const acquired = await acquireOpenCodeClient(
        'opencode/model', undefined, undefined, undefined, 'same-session', prepared,
      );
      acquired.release();
      expect(startOpenCodeServer).toHaveBeenCalledOnce();
    } finally {
      await prepared.dispose();
    }
  });
});
