import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callClaudeHeadlessMock } = vi.hoisted(() => ({
  callClaudeHeadlessMock: vi.fn(),
}));

vi.mock('../infra/claude-headless/client.js', () => ({
  callClaudeHeadless: callClaudeHeadlessMock,
}));

import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ProviderRegistry } from '../infra/providers/index.js';

describe('ClaudeHeadlessProvider', () => {
  beforeEach(() => {
    callClaudeHeadlessMock.mockReset();
  });

  it('should throw when claudeAgent is specified', () => {
    const provider = new ClaudeHeadlessProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow(
      'claudeAgent and claudeSkill require provider claude-sdk; headless claude does not support them.',
    );
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new ClaudeHeadlessProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow(
      'claudeAgent and claudeSkill require provider claude-sdk; headless claude does not support them.',
    );
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
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
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
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      permissionMode: 'edit',
      bypassPermissions: true,
      sandbox: {
        allowUnsandboxedCommands: true,
        excludedCommands: ['./gradlew'],
      },
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
