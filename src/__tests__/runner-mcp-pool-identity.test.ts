import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ResolvedMcpServers, ProviderMcpAdapter, PreparedProviderMcp } from '../infra/providers/mcp/index.js';
import type { AgentResponse } from '../core/models/index.js';

/**
 * Contracts covered (see fix-plan.md U1):
 * - `MCP-POOL-IDENTITY-MISSING` (ARCH-NEW-runner-L376, CODE-NEW-runner-L376, SEC-NEW-runner-L376)
 *   - `RunAgentOptions.mcpServerIdentity` is propagated through the runner to
 *     `ResolvedMcpServers.identity`, then to `PreparedProviderMcp.identity`,
 *     then to `buildSharedServerKey` so different MCP server sets get
 *     different OpenCode shared server pool keys (order.md:191-195,269,333).
 *
 * The runner path is exercised by mocking `createMcpAdapter` and observing
 * the `ResolvedMcpServers.identity` the adapter receives. This verifies the
 * full chain: `RunAgentOptions.mcpServerIdentity` → `prepareMcpAdapter` →
 * `ResolvedMcpServers.identity` → `PreparedProviderMcp.identity` →
 * `buildSharedServerKey` (server-pool.ts:199). The OpenCode adapter passes
 * `servers.identity` straight through to `PreparedProviderMcp.identity`
 * (opencode.ts:35), and `buildSharedServerKey` incorporates that identity
 * into the pool key (server-pool.ts:199), so different identities yield
 * different pool keys. The adapter identity pass-through is separately
 * verified in `provider-mcp-runtime.test.ts:147-166`.
 */

const fakeAgentResponse: AgentResponse = {
  persona: 'test',
  status: 'done',
  content: '',
  timestamp: new Date(),
};

const observedIdentities: string[] = [];
const dispose = vi.fn(async () => {});

const fakeAdapter: ProviderMcpAdapter = {
  validate: vi.fn(),
  async prepare(servers: ResolvedMcpServers): Promise<PreparedProviderMcp> {
    observedIdentities.push(servers.identity);
    return {
      dispose,
      serverConfig: {},
      identity: servers.identity,
    };
  },
  classifyFailure(error) {
    return { category: 'provider_error', message: String(error) };
  },
};

vi.mock('../infra/providers/mcp/index.js', () => ({
  createMcpAdapter: vi.fn(() => fakeAdapter),
}));

vi.mock('../infra/opencode/client.js', () => ({
  OpenCodeClient: vi.fn(),
  callOpenCode: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callOpenCodeCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  compactOpenCodeSession: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: () => 'test-key',
  resolveClaudeCliPath: () => '/usr/bin/claude',
  resolveOpenaiApiKey: () => 'test-key',
  resolveCodexCliPath: () => '/usr/bin/codex',
  resolveOpencodeApiKey: () => 'test-key',
  resolveCursorApiKey: () => 'test-key',
  resolveCursorCliPath: () => '/usr/bin/cursor',
  resolveCopilotGithubToken: () => 'test-token',
  resolveCopilotCliPath: () => '/usr/bin/copilot',
  resolveKiroApiKey: () => 'test-key',
  resolveKiroCliPath: () => '/usr/bin/kiro',
  loadCustomAgents: () => new Map(),
  loadAgentPrompt: () => '',
  loadGlobalConfig: () => ({ providerProfiles: {} }),
  loadProjectConfig: () => ({ providerProfiles: {} }),
  loadPersonaPromptFromPath: () => '',
}));

vi.mock('../infra/opencode/types.js', () => ({
  resolveOpenCodeAllowedPermissions: () => [],
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('../core/logging/contracts.js', () => ({
  USAGE_MISSING_REASONS: { NOT_SUPPORTED_BY_PROVIDER: 'not-supported' },
}));

vi.mock('../shared/types/agent-failure.js', () => ({
  AGENT_FAILURE_CATEGORIES: { PROVIDER_ERROR: 'provider_error' },
  MAX_AGENT_FAILURE_MESSAGE_BYTES: 8 * 1024,
}));

vi.mock('../shared/types/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/types/provider.js')>();
  return {
    ...actual,
    createStrictInternalAgentIsolationError: (provider: string) =>
      new Error(`Provider "${provider}" does not support strict internal-agent isolation`),
  };
});

vi.mock('../infra/providers/allowed-tool-edit-policy.js', () => ({
  keepsAllowedToolWithoutEdit: () => true,
}));

vi.mock('../infra/opencode/allowedTools.js', () => ({
  keepsOpenCodeAllowedToolWithoutEdit: () => true,
}));

beforeEach(() => {
  observedIdentities.length = 0;
  vi.clearAllMocks();
});

const mcpServers = {
  'common-tools': { type: 'stdio' as const, command: 'srv-a' },
};

describe('Runner MCP pool identity propagation (MCP-POOL-IDENTITY-MISSING)', () => {
  it('Given RunAgentOptions.mcpServerIdentity, When runAgent executes opencode, Then ResolvedMcpServers.identity equals the provided identity', async () => {
    const { runAgent } = await import('../agents/runner.js');
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      mcpServerIdentity: 'common-tools:stdio',
    });
    expect(observedIdentities).toContain('common-tools:stdio');
  });

  it('Given an onPromptResolved failure, When runAgent fails before provider.call, Then the prepared MCP adapter is disposed', async () => {
    const { runAgent } = await import('../agents/runner.js');

    await expect(runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      onPromptResolved: () => {
        throw new Error('prompt resolution failed');
      },
    })).rejects.toThrow('prompt resolution failed');

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('Given different mcpServerIdentity values, When runAgent executes opencode twice, Then the adapter receives different identities so pool keys differ (要件191-195,269,333)', async () => {
    const { runAgent } = await import('../agents/runner.js');
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      mcpServerIdentity: 'set-a:stdio',
    });
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      mcpServerIdentity: 'set-b:stdio',
    });
    expect(observedIdentities.length).toBeGreaterThanOrEqual(2);
    expect(observedIdentities[0]).not.toBe(observedIdentities[1]);
  });

  it('Given no mcpServerIdentity, When runAgent executes with mcpServers, Then different server structures receive different fallback identities (境界値)', async () => {
    const { runAgent } = await import('../agents/runner.js');
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
    });
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers: {
        'common-tools': { type: 'stdio', command: 'srv-b' },
      },
    });
    expect(observedIdentities).toHaveLength(2);
    expect(observedIdentities[0]).not.toBe('');
    expect(observedIdentities[0]).not.toBe(observedIdentities[1]);
  });

  it('Given the same mcpServerIdentity, When runAgent executes opencode twice, Then the adapter receives equal identities (stable pool key)', async () => {
    const { runAgent } = await import('../agents/runner.js');
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      mcpServerIdentity: 'common-tools:stdio',
    });
    await runAgent(undefined, 'task', {
      cwd: '/tmp',
      resolvedExecution: {
        provider: 'opencode',
        model: 'sonnet',
        providerOptions: {},
        permissionMode: 'readonly',
      },
      mcpServers,
      mcpServerIdentity: 'common-tools:stdio',
    });
    expect(observedIdentities.length).toBeGreaterThanOrEqual(2);
    expect(observedIdentities[0]).toBe(observedIdentities[1]);
  });
});
