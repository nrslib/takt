import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  callClaude: vi.fn(),
  callClaudeCustom: vi.fn(),
  callCodex: vi.fn(),
  callCodexCustom: vi.fn(),
  resolveAnthropicApiKey: vi.fn(),
  resolveClaudeCliPath: vi.fn(),
  resolveOpenaiApiKey: vi.fn(),
  resolveCodexCliPath: vi.fn(),
}));

vi.mock('../infra/claude/client.js', () => ({
  callClaude: providerMocks.callClaude,
  callClaudeCustom: providerMocks.callClaudeCustom,
}));

vi.mock('../infra/codex/index.js', () => ({
  callCodex: providerMocks.callCodex,
  callCodexCustom: providerMocks.callCodexCustom,
}));

vi.mock('../infra/config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../infra/config/index.js')>('../infra/config/index.js');
  return {
    ...actual,
    resolveAnthropicApiKey: providerMocks.resolveAnthropicApiKey,
    resolveClaudeCliPath: providerMocks.resolveClaudeCliPath,
    resolveOpenaiApiKey: providerMocks.resolveOpenaiApiKey,
    resolveCodexCliPath: providerMocks.resolveCodexCliPath,
  };
});

import { ClaudeProvider } from '../infra/providers/claude.js';
import { ClaudeHeadlessProvider } from '../infra/providers/claude-headless.js';
import { ClaudeTerminalProvider } from '../infra/providers/claude-terminal.js';
import { CodexProvider } from '../infra/providers/codex.js';
import { CopilotProvider } from '../infra/providers/copilot.js';
import { CursorProvider } from '../infra/providers/cursor.js';
import { KiroProvider } from '../infra/providers/kiro.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { Provider } from '../infra/providers/types.js';

const nonOpenCodeProviders: Array<[string, () => Provider]> = [
  ['claude-sdk', () => new ClaudeProvider()],
  ['claude', () => new ClaudeHeadlessProvider()],
  ['claude-terminal', () => new ClaudeTerminalProvider()],
  ['codex', () => new CodexProvider()],
  ['cursor', () => new CursorProvider()],
  ['copilot', () => new CopilotProvider()],
  ['kiro', () => new KiroProvider()],
  ['mock', () => new MockProvider()],
];

describe('provider tool naming addendum boundary', () => {
  beforeEach(() => {
    providerMocks.callClaude.mockReset();
    providerMocks.callClaudeCustom.mockReset();
    providerMocks.callCodex.mockReset();
    providerMocks.callCodexCustom.mockReset();
    providerMocks.resolveAnthropicApiKey.mockReset();
    providerMocks.resolveClaudeCliPath.mockReset();
    providerMocks.resolveOpenaiApiKey.mockReset();
    providerMocks.resolveCodexCliPath.mockReset();
    providerMocks.callClaudeCustom.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
    providerMocks.callCodexCustom.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
  });

  it.each(nonOpenCodeProviders)('should return null runtime instructions for %s provider', (_providerName, createProvider) => {
    expect(createProvider().getRuntimeInstructions()).toBeNull();
  });

  it('should not add OpenCode tool naming text to Claude system prompt', async () => {
    const provider = new ClaudeProvider();
    expect(provider.getRuntimeInstructions()).toBeNull();

    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'Use the project conventions.',
    });

    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'sonnet',
      anthropicApiKey: 'test-key',
    });

    expect(providerMocks.callClaudeCustom).toHaveBeenCalledWith(
      'coder',
      'implement task',
      'Use the project conventions.',
      expect.objectContaining({ model: 'sonnet' }),
    );
    expect(providerMocks.callClaudeCustom.mock.calls[0]?.[2])
      .not.toContain('OpenCode tool names are lowercase.');
  });

  it('should not add OpenCode tool naming text to Codex system prompt', async () => {
    const provider = new CodexProvider();
    expect(provider.getRuntimeInstructions()).toBeNull();

    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'Use the project conventions.',
    });

    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'gpt-5',
      openaiApiKey: 'test-key',
    });

    expect(providerMocks.callCodexCustom).toHaveBeenCalledWith(
      'coder',
      'implement task',
      'Use the project conventions.',
      expect.objectContaining({ model: 'gpt-5' }),
    );
    expect(providerMocks.callCodexCustom.mock.calls[0]?.[2])
      .not.toContain('OpenCode tool names are lowercase.');
  });
});
