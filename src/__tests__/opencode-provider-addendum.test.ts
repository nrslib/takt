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

  it('should append OpenCode tool naming addendum to custom system prompt', async () => {
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
      expect.stringContaining('Use the project conventions.\n\nOpenCode tool names are lowercase.'),
      expect.objectContaining({ model: 'opencode/big-pickle' }),
    );
    expect(openCodeMocks.callOpenCodeCustom.mock.calls[0]?.[2])
      .toContain('Do not call run, list, todo, or todo_write.');
  });

  it('should use custom OpenCode call with addendum when setup has no system prompt', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'opencode/big-pickle',
      opencodeApiKey: 'test-key',
    });

    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCodeCustom).toHaveBeenCalledWith(
      'coder',
      'implement task',
      expect.stringContaining('OpenCode tool names are lowercase.'),
      expect.objectContaining({ model: 'opencode/big-pickle' }),
    );
  });
});
