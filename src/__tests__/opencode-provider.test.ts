import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GlobalConfigSchema } from '../core/models/index.js';
import { normalizeProviderOptions, resolveEffectiveProviderOptions } from '../infra/config/providerOptions.js';
import { resolveOpenCodeGuardSuite } from '../infra/opencode/guards/index.js';

const openCodeMocks = vi.hoisted(() => ({
  callOpenCode: vi.fn(),
  callOpenCodeCustom: vi.fn(),
  compactOpenCodeSession: vi.fn(),
  resolveOpencodeApiKey: vi.fn(),
  resolveRuntime: vi.fn(),
}));

vi.mock('../infra/opencode/runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/opencode/runtime.js')>(),
  resolveOpenCodeRuntime: openCodeMocks.resolveRuntime,
}));

vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: openCodeMocks.callOpenCode,
  callOpenCodeCustom: openCodeMocks.callOpenCodeCustom,
  compactOpenCodeSession: openCodeMocks.compactOpenCodeSession,
}));

const agentRunnerMocks = vi.hoisted(() => {
  const getRuntimeInstructions = vi.fn(
    (allowedTools?: string[]): string | null => {
      if (allowedTools !== undefined && allowedTools.length === 0) {
        return null;
      }
      return 'runtime instructions';
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

vi.mock('../infra/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/providers/index.js')>();
  return {
    ...actual,
    getProvider: agentRunnerMocks.getProviderMock,
  };
});

vi.mock('../infra/config/index.js', () => ({
  loadProjectConfig: agentRunnerMocks.loadProjectConfigMock,
  loadGlobalConfig: agentRunnerMocks.loadGlobalConfigMock,
  loadCustomAgents: agentRunnerMocks.loadCustomAgentsMock,
  loadAgentPrompt: agentRunnerMocks.loadAgentPromptMock,
  loadPersonaPromptFromPath: agentRunnerMocks.loadPersonaPromptFromPathMock,
  resolveOpencodeApiKey: openCodeMocks.resolveOpencodeApiKey,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: agentRunnerMocks.resolveConfigValueMock,
  resolveProviderOptionsWithTrace: agentRunnerMocks.resolveProviderOptionsWithTraceMock,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: agentRunnerMocks.loadTemplateMock,
}));

import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { ProviderRegistry } from '../infra/providers/index.js';
import { runAgent } from '../agents/runner.js';

describe('OpenCodeProvider tool naming addendum', () => {
  it.each([{ allowedTools: ['Read'] }, { allowedTools: [] }])('includes explicitly enabled Skill in Phase 1 instructions with tools %j', ({ allowedTools }) => {
    const provider = new OpenCodeProvider();
    const options = { cwd: '/work', executionPhase: 1 as const, providerOptions: { opencode: { skills: { enabled: true } } } };
    expect(provider.getRuntimeInstructions(allowedTools, 'readonly', undefined, options)).toContain('skill');
    for (const restricted of [{ ...options, executionPhase: 2 as const }, { ...options, internalAgentIsolation: 'strict-readonly' as const }]) {
      const instruction = provider.getRuntimeInstructions(allowedTools, 'readonly', undefined, restricted);
      if (allowedTools.length === 0) expect(instruction).toBeNull();
      else expect(instruction).not.toContain('skill');
    }
  });
  it('uses actual v2 tool names in runtime instructions', () => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
    try {
      const provider = new OpenCodeProvider();
      expect(provider.getRuntimeInstructions(['Bash'])).toContain('shell');
      expect(provider.getRuntimeInstructions(['Bash'])).not.toContain('bash');
      expect(provider.getRuntimeInstructions()).toContain('shell');
      expect(provider.getRuntimeInstructions()).not.toContain('todowrite');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  beforeEach(() => {
    openCodeMocks.resolveRuntime.mockReset().mockResolvedValue({ generation: 'v1', command: 'opencode', version: '1.18.2' });
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
      if (allowedTools === undefined) {
          return 'runtime instructions';
        }
        if (allowedTools.length === 0) {
          return null;
        }
        return `allowed tools: ${allowedTools.join(', ')}`;
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

  it('preflights manager restrictions without starting a conversation', async () => {
    const controller = new AbortController();
    await new OpenCodeProvider().preflight({
      cwd: '/repo', model: 'probe/probe', permissionMode: 'readonly',
      mcpOnlySideEffects: ['Read', 'mcp__takt_mgr_session__takt_get_run'],
      abortSignal: controller.signal,
    });
    expect(openCodeMocks.resolveRuntime).toHaveBeenCalledExactlyOnceWith(controller.signal);
    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCodeCustom).not.toHaveBeenCalled();
  });

  it.each([
    { model: undefined }, { model: 'invalid' },
    { mcpOnlySideEffects: ['Bash'] }, { mcpOnlySideEffects: ['mcp__takt__mgr__get_run'] },
    { permissionMode: 'full' as const }, { bypassPermissions: true },
  ])('rejects invalid manager call options before runtime resolution: %j', async (invalid) => {
    await expect(new OpenCodeProvider().preflight({
      cwd: '/repo', model: 'probe/probe', permissionMode: 'readonly', mcpOnlySideEffects: ['Read'], ...invalid,
    })).rejects.toThrow();
    expect(openCodeMocks.resolveRuntime).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
  });

  it('should return null when allowedTools is empty array (no-tools execution)', () => {
    const provider = new OpenCodeProvider() as {
      getRuntimeInstructions(allowedTools?: string[]): string | null;
    };

    expect(provider.getRuntimeInstructions([])).toBeNull();
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
  });

  it('propagates strict readonly artifact reads to the OpenCode client', async () => {
    const agent = new OpenCodeProvider().setup({ name: 'assistant', systemPrompt: 'Interpret verification.' });
    await agent.call('read artifacts', {
      cwd: '/tmp/project', model: 'opencode/big-pickle', allowedTools: ['Read'],
      permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly', allowReadonlyFileRead: true,
    });
    expect(openCodeMocks.callOpenCodeCustom).toHaveBeenCalledWith('assistant', 'read artifacts', 'Interpret verification.', expect.objectContaining({
      allowedTools: ['Read'], permissionMode: 'readonly', internalAgentIsolation: 'strict-readonly', allowReadonlyFileRead: true,
    }));
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

  it.each([
    [undefined, 'strictToolAllowlist'], ['manager persona', 'strictToolAllowlist'],
    [undefined, 'mcpOnlySideEffects'], ['manager persona', 'mcpOnlySideEffects'],
  ] as const)('maps only builtin and MCP names for system prompt %s and restriction %s', async (systemPrompt, restriction) => {
    const strictTools = ['Read', 'mcp__takt_mgr_session__takt_get_run'];
    const agent = new OpenCodeProvider().setup({ name: 'manager', systemPrompt });
    await agent.call('mcp__takt__takt_create_goal in conversation gives no permission', {
      cwd: '/tmp/project', model: 'probe/probe', permissionMode: 'readonly',
      allowedTools: ['Read', 'Bash'], [restriction]: strictTools,
      preparedMcp: { serverConfig: {}, identity: 'test', taskStateMcpTools: ['mcp__takt__takt_create_goal'], dispose: async () => {} },
    });
    const options = systemPrompt === undefined
      ? openCodeMocks.callOpenCode.mock.calls.at(-1)?.[2]
      : openCodeMocks.callOpenCodeCustom.mock.calls.at(-1)?.[3];
    expect(options).toMatchObject({ allowedTools: ['Read'], allowedMcpTools: ['takt_mgr_session_takt_get_run'], strictToolAllowlist: strictTools });
  });

  it.each(['mcp__takt__mgr__get_run', 'mcp__takt__get__run', 'mcp__takt___get_run'])('rejects ambiguous MCP names before calling OpenCode: %s', async (tool) => {
    const agent = new OpenCodeProvider().setup({ name: 'manager', systemPrompt: 'manager' });
    await expect(agent.call('consult', {
      cwd: '/tmp/project', model: 'probe/probe', permissionMode: 'readonly', mcpOnlySideEffects: ['Read', tool],
    })).rejects.toThrow();
    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCodeCustom).not.toHaveBeenCalled();
  });

  it('does not grant an MCP name found only in the conversation', async () => {
    await new OpenCodeProvider().setup({ name: 'manager' }).call('mcp__takt__takt_get_run', {
      cwd: '/tmp/project', model: 'probe/probe', strictToolAllowlist: ['Read'],
    });
    expect(openCodeMocks.callOpenCode.mock.calls.at(-1)?.[2]).toMatchObject({ allowedTools: ['Read'], allowedMcpTools: [] });
  });

  it('YAML guards を設定解決・provider 変換・guard suite まで伝播する', async () => {
    const globalRaw = parseYaml([
      'provider_options:',
      '  opencode:',
      '    guards:',
      '      profile: standard',
      '      model_profiles:',
      '        "opencode/big-*": minimal',
      '      call_timeout_ms: 120000',
      '      event_limit: 4096',
      '      text_byte_limit: 2048',
    ].join('\n')) as unknown;
    const stepRaw = parseYaml([
      'opencode:',
      '  guards:',
      '    reasoning_byte_limit: 8192',
    ].join('\n')) as Record<string, unknown>;
    const parsed = GlobalConfigSchema.parse(globalRaw);
    const effective = resolveEffectiveProviderOptions(
      undefined,
      undefined,
      normalizeProviderOptions(parsed.provider_options),
      normalizeProviderOptions(stepRaw),
    );

    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('implement task', {
      cwd: '/tmp/project',
      model: 'opencode/big-pickle',
      opencodeApiKey: 'test-key',
      providerOptions: effective,
    });

    const callOptions = openCodeMocks.callOpenCode.mock.calls.at(-1)?.[2];
    expect(callOptions?.guards).toEqual({
      profile: 'standard',
      modelProfiles: { 'opencode/big-*': 'minimal' },
      callTimeoutMs: 120_000,
      eventLimit: 4096,
      textByteLimit: 2048,
      reasoningByteLimit: 8192,
    });
    const suite = resolveOpenCodeGuardSuite(callOptions?.guards, callOptions?.model ?? '');
    expect(suite.profile).toBe('minimal');
    expect(suite.policy).toMatchObject({
      callTimeoutMs: 120_000,
      streamEventLimit: 4096,
      streamLimits: { textByteLimit: 2048, reasoningByteLimit: 8192 },
    });
  });
});

  describe('AgentRunner path — allowedTools propagation', () => {
    beforeEach(() => {
      agentRunnerMocks.providerCallMock.mockClear();
      agentRunnerMocks.getRuntimeInstructionsMock.mockReset();
      agentRunnerMocks.getRuntimeInstructionsMock.mockImplementation(
        (allowedTools?: string[]) => {
          if (allowedTools === undefined) {
            return 'runtime instructions';
          }
          if (allowedTools.length === 0) {
            return null;
          }
          return `allowed tools: ${allowedTools.join(', ')}`;
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
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith([], undefined, undefined, expect.objectContaining({ allowedTools: [] }));
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
          providerRuntimeInstructions: expect.any(String),
        }),
      );
      expect(call.systemPrompt).toBe('template');
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith(undefined, undefined, undefined, expect.objectContaining({ allowedTools: undefined }));
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
          providerRuntimeInstructions: expect.any(String),
        }),
      );
      expect(call.systemPrompt).toBe('template');
      expect(agentRunnerMocks.getRuntimeInstructionsMock).toHaveBeenCalledWith(['read', 'edit', 'write'], undefined, undefined, expect.objectContaining({ allowedTools: ['read', 'edit', 'write'] }));
    });
  });

describe('OpenCodeProvider setup', () => {
  it('should return a ProviderAgent when setup with name only', () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });

  it('should return a ProviderAgent when setup with systemPrompt', () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'test',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});

describe('ProviderRegistry with OpenCode', () => {
  it('should return OpenCode provider from registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('opencode');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(OpenCodeProvider);
  });

  it('should setup an agent through the registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('opencode');
    const agent = provider.setup({ name: 'test' });

    expect(agent).toBeDefined();
    expect(typeof agent.call).toBe('function');
  });
});

describe('OpenCodeProvider compactSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openCodeMocks.callOpenCode.mockResolvedValue({
      status: 'done',
      content: '',
      persona: 'coder',
      timestamp: new Date(),
    });
    openCodeMocks.compactOpenCodeSession.mockResolvedValue(undefined);
    openCodeMocks.resolveOpencodeApiKey.mockReturnValue('configured-opencode-key');
  });

  it('Given compaction options When compactSession runs Then it delegates only SDK compaction options to the OpenCode client', async () => {
    const abortController = new AbortController();
    const provider = new OpenCodeProvider();

    await provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
    });

    expect(openCodeMocks.resolveOpencodeApiKey).toHaveBeenCalledTimes(1);
    expect(openCodeMocks.compactOpenCodeSession).toHaveBeenCalledWith({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
      abortSignal: abortController.signal,
      childProcessEnv: {
        TAKT_OBSERVABILITY: '{"enabled":true}',
      },
      opencodeApiKey: 'configured-opencode-key',
      skillsEnabled: false,
    });
  });

  it('Given no explicit OpenCode API key When compactSession runs Then it resolves the configured key once', async () => {
    const provider = new OpenCodeProvider();

    await provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      model: 'opencode/big-pickle',
    });

    expect(openCodeMocks.resolveOpencodeApiKey).toHaveBeenCalledTimes(1);
    expect(openCodeMocks.compactOpenCodeSession).toHaveBeenCalledWith(expect.objectContaining({
      opencodeApiKey: 'configured-opencode-key',
    }));
  });

  it('Given model is missing When compactSession runs Then it fails before calling the client', async () => {
    const provider = new OpenCodeProvider();

    await expect(provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(openCodeMocks.compactOpenCodeSession).not.toHaveBeenCalled();
  });

  it('Given a workflow default route When compactSession runs Then it delegates model resolution to the session runtime', async () => {
    const provider = new OpenCodeProvider();

    await provider.compactSession({
      cwd: '/repo',
      sessionId: 'session-1',
      allowDefaultModel: true,
    });

    expect(openCodeMocks.compactOpenCodeSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      sessionId: 'session-1',
      allowDefaultModel: true,
    }));
    expect(openCodeMocks.compactOpenCodeSession.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('Given model is missing When the regular OpenCode agent call runs Then it fails with the same model validation before calling the client', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    await expect(agent.call('implement task', {
      cwd: '/repo',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
    expect(openCodeMocks.compactOpenCodeSession).not.toHaveBeenCalled();
  });

  it('Given a workflow default route When the regular OpenCode agent call runs Then it delegates model resolution to the runtime', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement task', {
      cwd: '/repo',
      allowDefaultModel: true,
    });

    expect(openCodeMocks.callOpenCode).toHaveBeenCalledWith('coder', 'implement task', expect.objectContaining({
      allowDefaultModel: true,
    }));
    expect(openCodeMocks.callOpenCode.mock.calls[0]?.[2]).not.toHaveProperty('model');
  });

  it('Given model is missing When the custom OpenCode agent call runs Then it fails with the same model validation before calling the client', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({
      name: 'coder',
      systemPrompt: 'Follow the system prompt.',
    });

    await expect(agent.call('implement task', {
      cwd: '/repo',
    })).rejects.toThrow("OpenCode provider requires model in 'provider/model' format");

    expect(openCodeMocks.callOpenCodeCustom).not.toHaveBeenCalled();
    expect(openCodeMocks.callOpenCode).not.toHaveBeenCalled();
    expect(openCodeMocks.compactOpenCodeSession).not.toHaveBeenCalled();
  });
});
