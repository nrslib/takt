import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallKiro } = vi.hoisted(() => ({
  mockCallKiro: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

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
      model: 'claude-3-opus',
      sessionId: 'sess-1',
      permissionMode: 'full',
    });

    expect(mockCallKiro).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        model: 'claude-3-opus',
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

  it('Given providerOptions.kiro.agent, When agent is called, Then passes the Kiro agent name to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('planner'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'planner' });

    await agent.call('plan the feature', {
      cwd: '/tmp/work',
      providerOptions: {
        kiro: { agent: 'planner-agent' },
      },
    });

    expect(mockCallKiro).toHaveBeenCalledWith(
      'planner',
      'plan the feature',
      expect.objectContaining({
        agent: 'planner-agent',
      }),
    );
  });

  it('Given no providerOptions, When agent is called, Then passes undefined agent to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.agent).toBeUndefined();
  });

  it('Given providerOptions without a kiro entry, When agent is called, Then passes undefined agent to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      providerOptions: {
        opencode: { variant: 'high' },
      },
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.agent).toBeUndefined();
  });

  it('Given a model, When agent is called, Then passes it through to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'claude-3-opus',
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.model).toBe('claude-3-opus');
    expect(mockLogger.info).not.toHaveBeenCalledWith('Kiro provider does not support model CLI flag; ignoring');
  });

  it('Given no model, When agent is called, Then passes undefined model to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.model).toBeUndefined();
  });

  it('Given unsupported provider options, When agent is called, Then does not pass them to callKiro', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      allowedTools: ['Read', 'Write'],
      mcpServers: {
        docs: {
          type: 'stdio',
          command: 'docs-mcp',
        },
      },
      maxTurns: 5,
      outputSchema: { type: 'object' },
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
      permissionMode: 'edit',
    });

    const options = mockCallKiro.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.allowedTools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.outputSchema).toBeUndefined();
    expect(options.imageAttachments).toBeUndefined();
    expect(options.permissionMode).toBe('edit');
    expect(mockLogger.info).toHaveBeenCalledWith('Kiro provider does not support imageAttachments; ignoring');
  });

  it('Given empty or missing image attachments, When agent is called, Then does not log unsupported image attachments', async () => {
    mockCallKiro.mockResolvedValue(doneResponse('coder'));

    const provider = new KiroProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      imageAttachments: [],
    });
    await agent.call('implement', {
      cwd: '/tmp/work',
    });

    expect(mockLogger.info).not.toHaveBeenCalledWith('Kiro provider does not support imageAttachments; ignoring');
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
