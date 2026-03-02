import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSetup } from '../infra/providers/types.js';

const {
  mockCallClaude,
  mockResolveAnthropicApiKey,
} = vi.hoisted(() => ({
  mockCallClaude: vi.fn(),
  mockResolveAnthropicApiKey: vi.fn(),
}));

vi.mock('../infra/claude/client.js', () => ({
  callClaude: mockCallClaude,
  callClaudeCustom: vi.fn(),
  callClaudeAgent: vi.fn(),
  callClaudeSkill: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveAnthropicApiKey: mockResolveAnthropicApiKey,
  resolveClaudeCliPath: vi.fn(() => undefined),
  loadProjectConfig: vi.fn(() => ({})),
}));

import { ClaudeProvider } from '../infra/providers/claude.js';

describe('ClaudeProvider abortSignal wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAnthropicApiKey.mockReturnValue(undefined);
    mockCallClaude.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'ok',
      timestamp: new Date(),
    });
  });

  it('ProviderCallOptions.abortSignal を Claude call options に渡す', async () => {
    const provider = new ClaudeProvider();
    const setup: AgentSetup = { name: 'coder' };
    const agent = provider.setup(setup);
    const controller = new AbortController();

    await agent.call('test prompt', {
      cwd: '/tmp/project',
      abortSignal: controller.signal,
    });

    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    const callOptions = mockCallClaude.mock.calls[0]?.[2];
    expect(callOptions).toHaveProperty('abortSignal', controller.signal);
  });
});
