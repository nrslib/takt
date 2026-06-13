import { beforeEach, describe, expect, it, vi } from 'vitest';

const openCodeMocks = vi.hoisted(() => ({
  callOpenCode: vi.fn(),
  callOpenCodeCustom: vi.fn(),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: openCodeMocks.callOpenCode,
  callOpenCodeCustom: openCodeMocks.callOpenCodeCustom,
}));

import { OpenCodeProvider } from '../infra/providers/opencode.js';

describe('OpenCodeProvider tool naming addendum', () => {
  beforeEach(() => {
    openCodeMocks.callOpenCode.mockReset();
    openCodeMocks.callOpenCodeCustom.mockReset();
    openCodeMocks.callOpenCode.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
    openCodeMocks.callOpenCodeCustom.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
  });

  it('should expose OpenCode tool naming text as provider runtime instructions', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(): string | null;
    };

    const runtimeInstructions = provider.getRuntimeInstructions();

    expect(runtimeInstructions).toContain('OpenCode tool names are lowercase.');
    expect(runtimeInstructions).toContain('Do not call run, list, todo, or todo_write.');
  });

  it('should pass custom system prompt without appending OpenCode runtime instructions', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'Use the project conventions.',
    });

    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'opencode/big-pickle',
      opencodeApiKey: 'test-key',
    });

    expect(openCodeMocks.callOpenCodeCustom).toHaveBeenCalledWith(
      'coder',
      'implement task',
      'Use the project conventions.',
      expect.objectContaining({ model: 'opencode/big-pickle' }),
    );
    expect(openCodeMocks.callOpenCodeCustom.mock.calls[0]?.[2])
      .not.toContain('OpenCode tool names are lowercase.');
  });

  it('should use the regular OpenCode call when setup has no system prompt', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'opencode/big-pickle',
      opencodeApiKey: 'test-key',
    });

    expect(openCodeMocks.callOpenCodeCustom).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCode).toHaveBeenCalledWith(
      'coder',
      'implement task',
      expect.objectContaining({ model: 'opencode/big-pickle' }),
    );
  });
});
