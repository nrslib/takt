import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallDevin } = vi.hoisted(() => ({
  mockCallDevin: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockResolveDevinCliPath } = vi.hoisted(() => ({
  mockResolveDevinCliPath: vi.fn((): string | undefined => undefined),
}));

vi.mock('../infra/devin/index.js', () => ({
  callDevin: mockCallDevin,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveDevinCliPath: mockResolveDevinCliPath,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { DevinProvider } from '../infra/providers/devin.js';
import { ProviderRegistry } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

describe('DevinProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDevinCliPath.mockReturnValue(undefined);
  });

  it('Given Devin provider, When inspected, Then structured output and native image input are disabled and no MCP transports are declared', () => {
    const provider = new DevinProvider();
    expect(provider.supportsStructuredOutput).toBe(false);
    expect(provider.supportsNativeImageInput).toBe(false);
    expect(provider.supportedMcpTransports).toBeDefined();
    expect(provider.supportedMcpTransports?.size).toBe(0);
  });

  it('Given resolved CLI path, When agent is called, Then passes cwd/model/session/permission to callDevin', async () => {
    mockResolveDevinCliPath.mockReturnValue('/custom/bin/devin');
    mockCallDevin.mockResolvedValue(doneResponse('coder'));

    const provider = new DevinProvider();
    const agent = provider.setup({ name: 'coder' });
    const onActivity = vi.fn();

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'swe-2-max',
      sessionId: 'rare-boater',
      permissionMode: 'full',
      onActivity,
    });

    expect(mockCallDevin).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        model: 'swe-2-max',
        sessionId: 'rare-boater',
        permissionMode: 'full',
        onActivity,
        devinCliPath: '/custom/bin/devin',
      }),
    );
  });

  it('Given system prompt, When agent is called, Then forwards it through Devin call options', async () => {
    mockCallDevin.mockResolvedValue(doneResponse('reviewer'));

    const provider = new DevinProvider();
    const agent = provider.setup({
      name: 'reviewer',
      systemPrompt: 'You are a strict reviewer.',
    });

    await agent.call('review this', {
      cwd: '/tmp/work',
    });

    expect(mockCallDevin).toHaveBeenCalledWith(
      'reviewer',
      'review this',
      expect.objectContaining({
        cwd: '/tmp/work',
        systemPrompt: 'You are a strict reviewer.',
      }),
    );
  });

  it('Given strict-readonly isolation, When agent is called, Then forwards it to callDevin', async () => {
    mockCallDevin.mockResolvedValue(doneResponse('verifier'));

    const provider = new DevinProvider();
    const agent = provider.setup({ name: 'verifier' });

    await agent.call('inspect', {
      cwd: '/tmp/work',
      permissionMode: 'readonly',
      internalAgentIsolation: 'strict-readonly',
    });

    expect(mockCallDevin).toHaveBeenCalledWith(
      'verifier',
      'inspect',
      expect.objectContaining({
        permissionMode: 'readonly',
        internalAgentIsolation: 'strict-readonly',
      }),
    );
  });

  it('Given unsupported provider options, When agent is called, Then does not pass them to callDevin', async () => {
    mockCallDevin.mockResolvedValue(doneResponse('coder'));

    const provider = new DevinProvider();
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

    const options = mockCallDevin.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.allowedTools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.outputSchema).toBeUndefined();
    expect(options.imageAttachments).toBeUndefined();
    expect(options.permissionMode).toBe('edit');
    expect(mockLogger.info).toHaveBeenCalled();
  });

});

describe('ProviderRegistry with Devin', () => {
  it('Given provider registry, When retrieving devin, Then returns DevinProvider', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('devin');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(DevinProvider);
  });
});
