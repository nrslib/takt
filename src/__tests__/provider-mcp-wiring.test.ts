import { describe, expect, it, vi, beforeEach } from 'vitest';
import { redactMcpServerForLog } from '../infra/config/runtime-provider/mcp-schema.js';
import type { PreparedProviderMcp } from '../infra/providers/mcp/types.js';
import type { AgentResponse } from '../core/models/index.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ADAPTER-WIRING` (要件40-68, ARCH-NEW-1, SEC-NEW-mcp-adapter-silent-drop-non-claude-providers)
 *   - 各 provider `toXxxOptions` が `PreparedProviderMcp` フィールドを消費する
 *   - codex/opencode/cursor/copilot/kiro/mock が `mcpServers` を silent drop しない
 *
 * このテストは source grep ではなく、各 provider の `setup().call()` 経路を通じて
 * `ProviderCallOptions.preparedMcp` → `XxxCallOptions.preparedMcp` の伝播を振る舞いとして
 * 検証する。Policy「設定値・ログ・スナップショットのみで振る舞いを承認 → REJECT」に準拠。
 * `redactMcpServerForLog` の振る舞い検証は下位 describe ブロックで行う。
 */

const fakeAgentResponse: AgentResponse = {
  persona: 'test',
  status: 'done',
  content: '',
  timestamp: new Date(),
};

function fakePreparedMcp(): PreparedProviderMcp {
  return {
    dispose: async () => {},
    sdkOptions: { mcpServers: { 'test-server': { type: 'stdio' } }, strictMcpConfig: true },
    args: ['--mcp-config', '/tmp/fake.json', '--strict-mcp-config'],
    config: { mcp_servers: { 'test-server': { type: 'stdio' } } },
    serverConfig: { 'test-server': { type: 'stdio' } },
    identity: 'test-server:stdio',
    configRoot: '/tmp/fake-configroot',
    resolvedServers: {
      enabled: true,
      servers: { 'test-server': { type: 'stdio', command: 'srv' } },
      serverNames: ['test-server'],
      identity: 'test-server:stdio',
    },
  };
}

const preparedMcp = fakePreparedMcp();

vi.mock('../infra/claude/client.js', () => ({
  callClaude: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callClaudeCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/claude-headless/client.js', () => ({
  callClaudeHeadless: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/claude-terminal/client.js', () => ({
  callClaudeTerminal: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/codex/client.js', () => ({
  CodexClient: vi.fn(),
  callCodex: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callCodexCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/codex/isolated-structured-client.js', () => ({
  callCodexIsolatedStructured: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/opencode/client.js', () => ({
  OpenCodeClient: vi.fn(),
  callOpenCode: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callOpenCodeCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  compactOpenCodeSession: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('../infra/cursor/client.js', () => ({
  CursorClient: vi.fn(),
  callCursor: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callCursorCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/copilot/client.js', () => ({
  CopilotClient: vi.fn(),
  callCopilot: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callCopilotCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/kiro/client.js', () => ({
  KiroClient: vi.fn(),
  callKiro: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
}));

vi.mock('../infra/mock/client.js', () => ({
  MockClient: vi.fn(),
  callMock: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
  callMockCustom: vi.fn(async (): Promise<AgentResponse> => fakeAgentResponse),
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
}));

vi.mock('../shared/types/provider.js', () => ({
  createStrictInternalAgentIsolationError: (provider: string) =>
    new Error(`Provider "${provider}" does not support strict internal-agent isolation`),
}));

vi.mock('../infra/providers/allowed-tool-edit-policy.js', () => ({
  keepsAllowedToolWithoutEdit: () => true,
}));

vi.mock('../infra/opencode/allowedTools.js', () => ({
  keepsOpenCodeAllowedToolWithoutEdit: () => true,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

type AnyCallOptions = Record<string, unknown> & { preparedMcp?: PreparedProviderMcp };

function getLastCallOptions(mockFn: { mock: { calls: unknown[][] } }): AnyCallOptions {
  const calls = mockFn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1];
  if (lastCall === undefined) {
    throw new Error('Expected at least one provider call');
  }
  const options = lastCall.at(-1);
  if (options === undefined) {
    throw new Error('Expected provider call options as the final argument');
  }
  return options as AnyCallOptions;
}

describe('Provider toXxxOptions preparedMcp wiring (MCP-ADAPTER-WIRING)', () => {
  it('Given claude-sdk provider, When ProviderCallOptions.preparedMcp is set, Then callClaude receives preparedMcp in ClaudeCallOptions', async () => {
    const { ClaudeProvider } = await import('../infra/providers/claude.js');
    const { callClaude } = await import('../infra/claude/client.js');
    const provider = new ClaudeProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callClaude as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given claude-headless provider, When ProviderCallOptions.preparedMcp is set, Then callClaudeHeadless receives preparedMcp in ClaudeHeadlessCallOptions', async () => {
    const { ClaudeHeadlessProvider } = await import('../infra/providers/claude-headless.js');
    const { callClaudeHeadless } = await import('../infra/claude-headless/client.js');
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callClaudeHeadless as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given claude-terminal provider, When ProviderCallOptions.preparedMcp is set, Then callClaudeTerminal receives preparedMcp in ClaudeTerminalCallOptions', async () => {
    const { ClaudeTerminalProvider } = await import('../infra/providers/claude-terminal.js');
    const { callClaudeTerminal } = await import('../infra/claude-terminal/client.js');
    const provider = new ClaudeTerminalProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callClaudeTerminal as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given codex provider, When ProviderCallOptions.preparedMcp is set, Then callCodex receives preparedMcp in CodexCallOptions', async () => {
    const { CodexProvider } = await import('../infra/providers/codex.js');
    const { callCodex } = await import('../infra/codex/client.js');
    const provider = new CodexProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callCodex as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given opencode provider, When ProviderCallOptions.preparedMcp is set, Then callOpenCode receives preparedMcp in OpenCodeCallOptions', async () => {
    const { OpenCodeProvider } = await import('../infra/providers/opencode.js');
    const { callOpenCode } = await import('../infra/opencode/client.js');
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
      preparedMcp,
    });
    const options = getLastCallOptions(callOpenCode as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given cursor provider, When ProviderCallOptions.preparedMcp is set, Then callCursor receives preparedMcp in CursorCallOptions', async () => {
    const { CursorProvider } = await import('../infra/providers/cursor.js');
    const { callCursor } = await import('../infra/cursor/client.js');
    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callCursor as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given copilot provider, When ProviderCallOptions.preparedMcp is set, Then callCopilot receives preparedMcp in CopilotCallOptions', async () => {
    const { CopilotProvider } = await import('../infra/providers/copilot.js');
    const { callCopilot } = await import('../infra/copilot/client.js');
    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callCopilot as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given kiro provider, When ProviderCallOptions.preparedMcp is set, Then callKiro receives preparedMcp in KiroCallOptions', async () => {
    const { KiroProvider } = await import('../infra/providers/kiro.js');
    const { callKiro } = await import('../infra/kiro/client.js');
    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callKiro as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given mock provider, When ProviderCallOptions.preparedMcp is set, Then callMock receives preparedMcp in MockCallOptions', async () => {
    const { MockProvider } = await import('../infra/providers/mock.js');
    const { callMock } = await import('../infra/mock/client.js');
    const provider = new MockProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
      preparedMcp,
    });
    const options = getLastCallOptions(callMock as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBe(preparedMcp);
  });

  it('Given a provider with no preparedMcp, Then XxxCallOptions.preparedMcp is undefined (not silently dropped or defaulted)', async () => {
    const { CodexProvider } = await import('../infra/providers/codex.js');
    const { callCodex } = await import('../infra/codex/client.js');
    const provider = new CodexProvider();
    const agent = provider.setup({ name: 'test' });
    await agent.call('prompt', {
      cwd: '/tmp',
    });
    const options = getLastCallOptions(callCodex as unknown as { mock: { calls: unknown[][] } });
    expect(options.preparedMcp).toBeUndefined();
  });
});

describe('Runner MCP secret redaction wiring (ARCH-NEW-6)', () => {
  it('Given redactMcpServerForLog, When a stdio server has env secrets, Then the returned record has <redacted> for env values', () => {
    const redacted = redactMcpServerForLog({
      type: 'stdio',
      command: 'srv',
      args: ['--flag'],
      env: { API_TOKEN: 'secret-value', OTHER: 'other-value' },
    });
    expect(redacted.env).toEqual({ API_TOKEN: '<redacted>', OTHER: '<redacted>' });
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
    expect(JSON.stringify(redacted)).not.toContain('other-value');
  });

  it('Given redactMcpServerForLog, When an http server has header secrets, Then the returned record has <redacted> for header values', () => {
    const redacted = redactMcpServerForLog({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(redacted.headers).toEqual({ Authorization: '<redacted>' });
    expect(JSON.stringify(redacted)).not.toContain('secret-token');
  });

  it('Given redactMcpServerForLog applied to a stdio server with secrets, When the runner logs the MCP adapter, Then the log payload contains only redacted values (not raw env secrets)', () => {
    // Reproduce the exact transform the runner uses (runner.ts:390-392) and
    // verify no raw secret survives. This exercises the redaction contract
    // through the same call shape the runner employs, without needing to
    // import the runner (which would require mocking its full dependency
    // graph).
    const mcpServers = {
      'secret-server': {
        type: 'stdio' as const,
        command: 'srv',
        env: { API_TOKEN: 'leak-me', OTHER: 'also-leak' },
      },
    };
    const redactedServers = Object.fromEntries(
      Object.entries(mcpServers).map(([name, server]) => [name, redactMcpServerForLog(server)]),
    );
    const logPayload = JSON.stringify(redactedServers);
    expect(logPayload).not.toContain('leak-me');
    expect(logPayload).not.toContain('also-leak');
    expect(redactedServers['secret-server']?.env).toEqual({
      API_TOKEN: '<redacted>',
      OTHER: '<redacted>',
    });
  });
});
