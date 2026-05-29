import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallKiro } = vi.hoisted(() => ({
  mockCallKiro: vi.fn(),
}));

const {
  mockResolveKiroApiKey,
  mockResolveKiroCliPath,
} = vi.hoisted(() => ({
  mockResolveKiroApiKey: vi.fn(() => undefined),
  mockResolveKiroCliPath: vi.fn(() => undefined),
}));

vi.mock('../infra/kiro/index.js', () => ({
  callKiro: mockCallKiro,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveKiroApiKey: mockResolveKiroApiKey,
  resolveKiroCliPath: mockResolveKiroCliPath,
}));

import { KiroProvider } from '../infra/providers/kiro.js';
import { ProviderRegistry } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

describe('KiroProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveKiroApiKey.mockReturnValue(undefined);
    mockResolveKiroCliPath.mockReturnValue(undefined);
  });

  it('Given Kiro provider, When inspected, Then structured output is disabled', () => {
    const provider = new KiroProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(false);
  });

  it('Given resolved config values, When agent is called, Then passes Kiro key/path/session/permission to callKiro', async () => {
    mockResolveKiroApiKey.mockReturnValue('resolved-key');
    mockResolveKiroCliPath.mockReturnValue('/custom/bin/kiro-cli');
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'gpt-ignored',
      sessionId: 'sess-1',
      permissionMode: 'full',
    });

    expect(mockCallKiro).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        sessionId: 'sess-1',
        permissionMode: 'full',
        kiroApiKey: 'resolved-key',
        kiroCliPath: '/custom/bin/kiro-cli',
      }),
    );
  });

  it('Given explicit Kiro API key, When agent is called, Then explicit key wins over resolver', async () => {
    mockResolveKiroApiKey.mockReturnValue('resolved-key');
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      kiroApiKey: 'explicit-key',
    });

    expect(mockCallKiro).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        kiroApiKey: 'explicit-key',
      }),
    );
  });

  it('Given system prompt, When agent is called, Then forwards it through Kiro call options', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('reviewer'));

    const provider = new KiroProvider();
    const agent = provider.setup({
      name: 'reviewer',
      systemPrompt: 'You are a strict reviewer.',
    });

    await agent.call('review this', {
      cwd: '/tmp/work',
    });

    expect(mockCallKiro).toHaveBeenCalledWith(
      'reviewer',
      'review this',
      expect.objectContaining({
        cwd: '/tmp/work',
        systemPrompt: 'You are a strict reviewer.',
      }),
    );
  });

  it('Given unsupported provider options, When agent is called, Then does not pass model, allowedTools, mcpServers, maxTurns, or outputSchema to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'gpt-ignored',
      allowedTools: ['Read', 'Write'],
      mcpServers: {
        docs: {
          type: 'stdio',
          command: 'docs-mcp',
        },
      },
      maxTurns: 5,
      outputSchema: { type: 'object' },
      permissionMode: 'edit',
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.model).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.outputSchema).toBeUndefined();
    expect(options.permissionMode).toBe('edit');
  });
});

describe('ProviderRegistry with Kiro', () => {
  it('Given provider registry, When retrieving kiro, Then returns KiroProvider', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('kiro');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(KiroProvider);
  });
});
