import { beforeEach, describe, expect, it, vi } from 'vitest';

const openCodeMocks = vi.hoisted(() => ({
  callOpenCode: vi.fn(),
  callOpenCodeCustom: vi.fn(),
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: openCodeMocks.callOpenCode,
  callOpenCodeCustom: openCodeMocks.callOpenCodeCustom,
}));

const agentRunnerMocks = vi.hoisted(() => {
  const getRuntimeInstructions = vi.fn(
    (allowedTools?: string[]) => {
      if (allowedTools !== undefined && allowedTools.length === 0) {
        return null;
      }
      return 'OpenCode tool names are lowercase. Do not call run, list, todo, or todo_write.';
    },
  );
  const providerCall = vi.fn().mockResolvedValue({
    status: 'done',
    content: '',
    persona: 'coder',
    timestamp: new Date(),
  });
  const providerSetup = vi.fn(() => ({ call: providerCall }));

  return {
    getProviderMock: vi.fn(() => ({
      supportsStructuredOutput: false,
      supportsNativeImageInput: false,
      getRuntimeInstructions,
      keepsAllowedToolWithoutEdit: vi.fn(() => true),
      setup: providerSetup,
    })),
    getRuntimeInstructionsMock: getRuntimeInstructions,
    providerCallMock: providerCall,
    providerSetupMock: providerSetup,
    loadProjectConfigMock: vi.fn(),
    loadGlobalConfigMock: vi.fn(),
    loadCustomAgentsMock: vi.fn(),
    loadAgentPromptMock: vi.fn(),
    loadPersonaPromptFromPathMock: vi.fn(),
    resolveConfigValueMock: vi.fn(),
    resolveProviderOptionsWithTraceMock: vi.fn(),
    loadTemplateMock: vi.fn(),
  };
});

vi.mock('../infra/providers/index.js', () => ({
  getProvider: agentRunnerMocks.getProviderMock,
}));

vi.mock('../infra/config/index.js', () => ({
  loadProjectConfig: agentRunnerMocks.loadProjectConfigMock,
  loadGlobalConfig: agentRunnerMocks.loadGlobalConfigMock,
  loadCustomAgents: agentRunnerMocks.loadCustomAgentsMock,
  loadAgentPrompt: agentRunnerMocks.loadAgentPromptMock,
  loadPersonaPromptFromPath: agentRunnerMocks.loadPersonaPromptFromPathMock,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: agentRunnerMocks.resolveConfigValueMock,
  resolveProviderOptionsWithTrace: agentRunnerMocks.resolveProviderOptionsWithTraceMock,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: agentRunnerMocks.loadTemplateMock,
}));

import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { runAgent } from '../agents/runner.js';

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

    agentRunnerMocks.getRuntimeInstructionsMock.mockReset();
    agentRunnerMocks.getRuntimeInstructionsMock.mockImplementation(
      (allowedTools?: string[]) => {
        if (allowedTools !== undefined && allowedTools.length === 0) {
          return null;
        }
        return 'OpenCode tool names are lowercase. Do not call run, list, todo, or todo_write.';
      },
    );
    agentRunnerMocks.loadTemplateMock.mockReset().mockReturnValue('template');
    agentRunnerMocks.loadProjectConfigMock.mockReset().mockReturnValue({ provider: 'opencode' });
    agentRunnerMocks.loadGlobalConfigMock.mockReset().mockReturnValue({
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    agentRunnerMocks.resolveConfigValueMock.mockReset().mockReturnValue(undefined);
    agentRunnerMocks.resolveProviderOptionsWithTraceMock.mockReset().mockReturnValue({
      value: undefined,
      source: 'default',
      originResolver: () => 'default',
    });
    agentRunnerMocks.loadCustomAgentsMock.mockReset().mockReturnValue(new Map());
    agentRunnerMocks.loadAgentPromptMock.mockReset().mockReturnValue('prompt');
    agentRunnerMocks.loadPersonaPromptFromPathMock.mockReset();
  });

  it('should expose OpenCode tool naming text as provider runtime instructions', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(allowedTools?: string[]): string | null;
    };

    const runtimeInstructions = provider.getRuntimeInstructions();

    expect(runtimeInstructions).toContain('OpenCode tool names are lowercase.');
    expect(runtimeInstructions).toContain('Do not call run, list, todo, or todo_write.');
  });

  it('should return null when allowedTools is empty array (no-tools execution)', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(allowedTools?: string[]): string | null;
    };

    expect(provider.getRuntimeInstructions([])).toBeNull();
  });

  it('should include addendum when allowedTools is undefined (normal execution)', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(allowedTools?: string[]): string | null;
    };

    const runtimeInstructions = provider.getRuntimeInstructions();

    expect(runtimeInstructions).toContain('OpenCode tool names are lowercase.');
    expect(runtimeInstructions).toContain('Do not call run, list, todo, or todo_write.');
  });

  it('should include addendum when allowedTools contains tools', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(allowedTools?: string[]): string | null;
    };

    const runtimeInstructions = provider.getRuntimeInstructions(['read', 'edit', 'write']);

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

  describe('AgentRunner path — allowedTools propagation', () => {
    beforeEach(() => {
      agentRunnerMocks.getRuntimeInstructionsMock.mockReset();
      agentRunnerMocks.getRuntimeInstructionsMock.mockImplementation(
        (allowedTools?: string[]) => {
          if (allowedTools !== undefined && allowedTools.length === 0) {
            return null;
          }
          return 'OpenCode tool names are lowercase. Do not call run, list, todo, or todo_write.';
        },
      );
      agentRunnerMocks.loadTemplateMock.mockReset().mockReturnValue('template');
      agentRunnerMocks.loadProjectConfigMock.mockReset().mockReturnValue({ provider: 'opencode' });
      agentRunnerMocks.loadGlobalConfigMock.mockReset().mockReturnValue({
        language: 'en',
        concurrency: 1,
        taskPollIntervalMs: 500,
      });
      agentRunnerMocks.resolveConfigValueMock.mockReset().mockReturnValue(undefined);
      agentRunnerMocks.resolveProviderOptionsWithTraceMock.mockReset().mockReturnValue({
        value: undefined,
        source: 'default',
        originResolver: () => 'default',
      });
      agentRunnerMocks.loadCustomAgentsMock.mockReset().mockReturnValue(new Map());
      agentRunnerMocks.loadAgentPromptMock.mockReset().mockReturnValue('prompt');
      agentRunnerMocks.loadPersonaPromptFromPathMock.mockReset();
    });

    it('should exclude addendum from resolved system prompt when allowedTools is []', async () => {
      const onPromptResolved = vi.fn();
      const task = 'test task';

      await runAgent(undefined, task, {
        cwd: '/repo',
        resolvedProvider: 'opencode',
        allowedTools: [],
        onPromptResolved,
      });

      expect(onPromptResolved).toHaveBeenCalledTimes(1);
      const call = onPromptResolved.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(agentRunnerMocks.loadTemplateMock).not.toHaveBeenCalled();
      expect(call.systemPrompt).toBe('');
      expect(call.systemPrompt).not.toContain('OpenCode tool names are lowercase.');
      expect(call.systemPrompt).not.toContain('glob for file discovery');
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith([]);
    });

    it('should include addendum in resolved system prompt when allowedTools is undefined', async () => {
      const onPromptResolved = vi.fn();
      const task = 'test task';

      await runAgent(undefined, task, {
        cwd: '/repo',
        resolvedProvider: 'opencode',
        onPromptResolved,
      });

      expect(onPromptResolved).toHaveBeenCalledTimes(1);
      const call = onPromptResolved.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(agentRunnerMocks.loadTemplateMock).toHaveBeenCalledTimes(1);
      expect(agentRunnerMocks.loadTemplateMock).toHaveBeenCalledWith(
        'provider_runtime_system_prompt',
        'en',
        expect.objectContaining({
          providerRuntimeInstructions: expect.stringContaining('OpenCode tool names are lowercase.'),
        }),
      );
      expect(call.systemPrompt).toBe('template');
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith(undefined);
    });

    it('should include addendum in resolved system prompt when allowedTools is non-empty', async () => {
      const onPromptResolved = vi.fn();
      const task = 'test task';

      await runAgent(undefined, task, {
        cwd: '/repo',
        resolvedProvider: 'opencode',
        allowedTools: ['read', 'edit', 'write'],
        onPromptResolved,
      });

      expect(onPromptResolved).toHaveBeenCalledTimes(1);
      const call = onPromptResolved.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(agentRunnerMocks.loadTemplateMock).toHaveBeenCalledTimes(1);
      expect(agentRunnerMocks.loadTemplateMock).toHaveBeenCalledWith(
        'provider_runtime_system_prompt',
        'en',
        expect.objectContaining({
          providerRuntimeInstructions: expect.stringContaining('OpenCode tool names are lowercase.'),
        }),
      );
      expect(call.systemPrompt).toBe('template');
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith(['read', 'edit', 'write']);
    });
  });
