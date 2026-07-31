import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callClaudeHeadlessMock } = vi.hoisted(() => ({
  callClaudeHeadlessMock: vi.fn(),
}));

vi.mock('../infra/claude-headless/client.js', () => ({
  callClaudeHeadless: callClaudeHeadlessMock,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveClaudeCliPath: vi.fn(() => undefined),
  resolveAnthropicApiKey: vi.fn(() => 'sk-ant-from-config'),
}));

import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ProviderRegistry } from '../infra/providers/index.js';

describe('ClaudeHeadlessProvider', () => {
  beforeEach(() => {
    callClaudeHeadlessMock.mockReset();
  });

  it('should mark supportsStructuredOutput as true', () => {
    const provider = new ClaudeHeadlessProvider() as { supportsStructuredOutput?: boolean };

    expect(provider.supportsStructuredOutput).toBe(true);
  });

  it('should return a ProviderAgent when setup with name only', () => {
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });

  it('should return a ProviderAgent when setup with systemPrompt', () => {
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });

  it('should pass mcpServers to the headless client', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'test',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
      sessionId: 'session-id',
    });

    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'sys',
    });

    await agent.call('prompt', {
      cwd: '/tmp',
      mcpServers: {
        sample: {
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('test', 'prompt', expect.objectContaining({
      systemPrompt: 'sys',
      mcpServers: {
        sample: {
          command: 'node',
          args: ['server.js'],
        },
      },
    }));
  });

  it('should pass session and permission-related options to the headless client', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'test',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
      sessionId: 'session-id',
    });

    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'sys',
    });

    await agent.call('prompt', {
      cwd: '/tmp',
      sessionId: 'opaque-session-id-from-report-phase',
      permissionMode: 'edit',
      bypassPermissions: true,
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
            excludedCommands: ['./gradlew'],
          },
        },
      },
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('test', 'prompt', expect.objectContaining({
      systemPrompt: 'sys',
      sessionId: 'opaque-session-id-from-report-phase',
      permissionMode: 'edit',
      bypassPermissions: true,
      anthropicApiKey: 'sk-ant-from-config',
      sandbox: {
        allowUnsandboxedCommands: true,
        excludedCommands: ['./gradlew'],
      },
    }));
  });

  it('should pass strict read-only internal agent isolation to the headless client', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'selector',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
    const agent = new ClaudeHeadlessProvider().setup({
      name: 'selector',
      systemPrompt: 'Select reviewers.',
    });

    await agent.call('prompt', {
      cwd: '/tmp',
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
      providerOptions: {
        claude: {
          skills: { enabled: true },
        },
      },
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('selector', 'prompt', expect.objectContaining({
      internalAgentIsolation: 'strict-readonly',
      permissionMode: 'readonly',
      allowedTools: [],
      mcpServers: {},
      skillsEnabled: false,
    }));
  });

  it('should pass outputSchema to the headless client', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'test',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
      sessionId: 'session-id',
      structuredOutput: { decision: 'approved' },
    });

    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'sys',
    });
    const outputSchema = {
      type: 'object',
      properties: {
        decision: { type: 'string' },
      },
      required: ['decision'],
    };

    const result = await agent.call('prompt', {
      cwd: '/tmp',
      outputSchema,
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('test', 'prompt', expect.objectContaining({
      systemPrompt: 'sys',
      outputSchema,
    }));
    expect(result.structuredOutput).toEqual({ decision: 'approved' });
  });

  it('should pass childProcessEnv to the headless client', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'test',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({ name: 'test' });

    await agent.call('prompt', {
      cwd: '/tmp',
      childProcessEnv,
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('test', 'prompt', expect.objectContaining({
      childProcessEnv,
    }));
  });

  it('Given disabled Claude Skills, When the provider calls the headless client, Then it forwards the resolved false value', async () => {
    callClaudeHeadlessMock.mockResolvedValue({
      persona: 'test',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
    const provider = new ClaudeHeadlessProvider();
    const agent = provider.setup({ name: 'test' });

    await agent.call('prompt', {
      cwd: '/tmp',
      providerOptions: {
        claude: { skills: { enabled: false } },
      } as never,
    });

    expect(callClaudeHeadlessMock).toHaveBeenCalledWith('test', 'prompt', expect.objectContaining({
      skillsEnabled: false,
    }));
  });
});

describe('ProviderRegistry with Claude headless', () => {
  it('should return ClaudeHeadlessProvider for claude', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('claude');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(ClaudeHeadlessProvider);
  });

  it('should setup an agent through the registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('claude');
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});
