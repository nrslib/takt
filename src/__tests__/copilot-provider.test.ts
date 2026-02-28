/**
 * Tests for Copilot provider implementation
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallCopilot,
  mockCallCopilotCustom,
} = vi.hoisted(() => ({
  mockCallCopilot: vi.fn(),
  mockCallCopilotCustom: vi.fn(),
}));

const {
  mockResolveCopilotGithubToken,
  mockResolveCopilotCliPath,
  mockLoadProjectConfig,
} = vi.hoisted(() => ({
  mockResolveCopilotGithubToken: vi.fn(() => undefined),
  mockResolveCopilotCliPath: vi.fn(() => undefined),
  mockLoadProjectConfig: vi.fn(() => ({})),
}));

vi.mock('../infra/copilot/index.js', () => ({
  callCopilot: mockCallCopilot,
  callCopilotCustom: mockCallCopilotCustom,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveCopilotGithubToken: mockResolveCopilotGithubToken,
  resolveCopilotCliPath: mockResolveCopilotCliPath,
  loadProjectConfig: mockLoadProjectConfig,
}));

import { CopilotProvider } from '../infra/providers/copilot.js';
import { ProviderRegistry } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

describe('CopilotProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCopilotGithubToken.mockReturnValue(undefined);
    mockResolveCopilotCliPath.mockReturnValue(undefined);
    mockLoadProjectConfig.mockReturnValue({});
  });

  it('should throw when claudeAgent is specified', () => {
    const provider = new CopilotProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow('Claude Code agent calls are not supported by the Copilot provider');
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new CopilotProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow('Claude Code skill calls are not supported by the Copilot provider');
  });

  it('should pass model/session/permission and resolved token to callCopilot', async () => {
    mockResolveCopilotGithubToken.mockReturnValue('resolved-token');
    mockCallCopilot.mockResolvedValue(doneResponse('coder'));

    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'claude-sonnet-4.6',
      sessionId: 'sess-1',
      permissionMode: 'full',
    });

    expect(mockCallCopilot).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        model: 'claude-sonnet-4.6',
        sessionId: 'sess-1',
        permissionMode: 'full',
        copilotGithubToken: 'resolved-token',
      }),
    );
  });

  it('should prefer explicit copilotGithubToken over resolver', async () => {
    mockResolveCopilotGithubToken.mockReturnValue('resolved-token');
    mockCallCopilot.mockResolvedValue(doneResponse('coder'));

    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      copilotGithubToken: 'explicit-token',
    });

    expect(mockCallCopilot).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        copilotGithubToken: 'explicit-token',
      }),
    );
  });

  it('should delegate to callCopilotCustom when systemPrompt is specified', async () => {
    mockCallCopilotCustom.mockResolvedValue(doneResponse('reviewer'));

    const provider = new CopilotProvider();
    const agent = provider.setup({
      name: 'reviewer',
      systemPrompt: 'You are a strict reviewer.',
    });

    await agent.call('review this', {
      cwd: '/tmp/work',
    });

    expect(mockCallCopilotCustom).toHaveBeenCalledWith(
      'reviewer',
      'review this',
      'You are a strict reviewer.',
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
  });

  it('should pass resolved copilotCliPath to callCopilot', async () => {
    mockResolveCopilotCliPath.mockReturnValue('/custom/bin/copilot');
    mockCallCopilot.mockResolvedValue(doneResponse('coder'));

    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    expect(mockCallCopilot).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        copilotCliPath: '/custom/bin/copilot',
      }),
    );
  });

  it('should pass undefined copilotCliPath when resolver returns undefined', async () => {
    mockResolveCopilotCliPath.mockReturnValue(undefined);
    mockCallCopilot.mockResolvedValue(doneResponse('coder'));

    const provider = new CopilotProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    const opts = mockCallCopilot.mock.calls[0]?.[2];
    expect(opts.copilotCliPath).toBeUndefined();
  });
});

describe('ProviderRegistry with Copilot', () => {
  it('should return Copilot provider from registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('copilot');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(CopilotProvider);
  });
});
