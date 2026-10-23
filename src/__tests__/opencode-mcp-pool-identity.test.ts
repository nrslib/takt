import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSectionSchema } from '../infra/config/runtime-provider/mcp-schema.js';
import { resolveMcpAssignment } from '../infra/config/runtime-provider/mcp-assignment.js';
import { createOpenCodeMcpAdapter } from '../infra/providers/mcp/opencode.js';
import { acquireOpenCodeClient, resetSharedServerPool } from '../infra/opencode/server-pool.js';
import { startOpenCodeServer } from '../infra/opencode/server-process.js';
import type { ManagedOpenCodeTransport } from '../infra/opencode/transport.js';

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
    session: {
      create: vi.fn(), get: vi.fn(), messages: vi.fn(), promptAsync: vi.fn(),
      abort: vi.fn(), summarize: vi.fn(),
    },
    event: { subscribe: vi.fn() },
    permission: { reply: vi.fn() },
    question: { reply: vi.fn(), reject: vi.fn() },
  };
}

async function prepare(reference: string) {
  const section = McpSectionSchema.parse({
    servers: { datadog: {
      type: 'http', url: 'https://example.com/mcp',
      headers: { Authorization: `Bearer \${env:${reference}}` },
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
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['PROJECT_A_TOKEN', true],
    ['PROJECT_B_TOKEN', false],
  ] as const)('selects %s after releasing A (reuse=%s)', async (reference, reuse) => {
    const preparedA = await prepare('PROJECT_A_TOKEN');
    const preparedB = await prepare(reference);
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
});
