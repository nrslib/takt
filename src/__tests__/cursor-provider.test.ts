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

  it('should throw when claudeAgent is specified', () => {
    const provider = new CursorProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow('Claude Code agent calls are not supported by the Cursor provider');
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new CursorProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow('Claude Code skill calls are not supported by the Cursor provider');
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

  it('should pass undefined cursorCliPath when resolver returns undefined', async () => {
    mockResolveCursorCliPath.mockReturnValue(undefined);
    mockCallCursor.mockResolvedValue(doneResponse('coder'));

    const provider = new CursorProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    const opts = mockCallCursor.mock.calls[0]?.[2];
    expect(opts.cursorCliPath).toBeUndefined();
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
