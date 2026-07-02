/**
 * Tests for Cursor provider implementation
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallCursor,
  mockCallCursorCustom,
} = vi.hoisted(() => ({
  mockCallCursor: vi.fn(),
  mockCallCursorCustom: vi.fn(),
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
  mockResolveCursorApiKey,
  mockResolveCursorCliPath,
  mockLoadProjectConfig,
} = vi.hoisted(() => ({
  mockResolveCursorApiKey: vi.fn(() => undefined),
  mockResolveCursorCliPath: vi.fn(() => undefined),
  mockLoadProjectConfig: vi.fn(() => ({})),
}));

vi.mock('../infra/cursor/index.js', () => ({
  callCursor: mockCallCursor,
  callCursorCustom: mockCallCursorCustom,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveCursorApiKey: mockResolveCursorApiKey,
  resolveCursorCliPath: mockResolveCursorCliPath,
  loadProjectConfig: mockLoadProjectConfig,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { CursorProvider } from '../infra/providers/cursor.js';
import { ProviderRegistry } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

describe('CursorProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCursorApiKey.mockReturnValue(undefined);
    mockResolveCursorCliPath.mockReturnValue(undefined);
    mockLoadProjectConfig.mockReturnValue({});
  });

  it('should mark supportsStructuredOutput as false', () => {
    const provider = new CursorProvider() as { supportsStructuredOutput?: boolean };
    expect(provider.supportsStructuredOutput).toBe(false);
  });

  it('should pass model/session/permission and resolved cursor key to callCursor', async () => {
    mockResolveCursorApiKey.mockReturnValue('resolved-key');
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'cursor/gpt-5',
      sessionId: 'sess-1',
      permissionMode: 'full',
    });

    expect(mockCallCursor).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        model: 'cursor/gpt-5',
        sessionId: 'sess-1',
        permissionMode: 'full',
        cursorApiKey: 'resolved-key',
      }),
    );
  });

  it('should prefer explicit cursorApiKey over resolver', async () => {
    mockResolveCursorApiKey.mockReturnValue('resolved-key');
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      cursorApiKey: 'explicit-key',
    });

    expect(mockCallCursor).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cursorApiKey: 'explicit-key',
      }),
    );
  });

  it('should delegate to callCursorCustom when systemPrompt is specified', async () => {
    mockCallCursorCustom.mockResolvedValue(doneResponse('reviewer'));

    const provider = new CursorProvider();
    const agent = provider.setup({
      name: 'reviewer',
      systemPrompt: 'You are a strict reviewer.',
    });

    await agent.call('review this', {
      cwd: '/tmp/work',
    });

    expect(mockCallCursorCustom).toHaveBeenCalledWith(
      'reviewer',
      'review this',
      'You are a strict reviewer.',
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
  });

  it('should pass resolved cursorCliPath to callCursor', async () => {
    mockResolveCursorCliPath.mockReturnValue('/custom/bin/cursor-agent');
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    expect(mockCallCursor).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cursorCliPath: '/custom/bin/cursor-agent',
      }),
    );
  });

  it('should pass childProcessEnv to callCursor', async () => {
    mockCallCursor.mockResolvedValue(doneResponse('coder'));
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      childProcessEnv,
    });

    expect(mockCallCursor).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({ childProcessEnv }),
    );
  });

  it('should pass undefined cursorCliPath when resolver returns undefined', async () => {
    mockResolveCursorCliPath.mockReturnValue(undefined);
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    const opts = mockCallCursor.mock.calls[0]?.[2];
    expect(opts.cursorCliPath).toBeUndefined();
  });

  it('should ignore unsupported image attachments and log only when non-empty', async () => {
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      imageAttachments: [{ placeholder: '[Image #1]', path: '/tmp/image-1.png' }],
    });

    const options = mockCallCursor.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.imageAttachments).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith('Cursor provider does not support imageAttachments; ignoring');

    mockLogger.info.mockClear();
    await agent.call('implement', { cwd: '/tmp/work', imageAttachments: [] });
    await agent.call('implement', { cwd: '/tmp/work' });

    expect(mockLogger.info).not.toHaveBeenCalledWith('Cursor provider does not support imageAttachments; ignoring');
  });
});

describe('ProviderRegistry with Cursor', () => {
  it('should return Cursor provider from registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('cursor');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(CursorProvider);
  });
});
