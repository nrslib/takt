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

const { mockResolveCursorApiKey } = vi.hoisted(() => ({
  mockResolveCursorApiKey: vi.fn(() => undefined),
}));

vi.mock('../infra/cursor/index.js', () => ({
  callCursor: mockCallCursor,
  callCursorCustom: mockCallCursorCustom,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveCursorApiKey: mockResolveCursorApiKey,
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
