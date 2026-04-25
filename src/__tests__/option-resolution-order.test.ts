import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProviderMock,
  loadCustomAgentsMock,
  loadAgentPromptMock,
  loadPersonaPromptFromPathMock,
  loadProjectConfigMock,
  loadGlobalConfigMock,
  resolveConfigValueMock,
  resolveProviderOptionsWithTraceMock,
  loadTemplateMock,
  providerSetupMock,
  providerCallMock,
} = vi.hoisted(() => {
  const providerCall = vi.fn();
  const providerSetup = vi.fn(() => ({ call: providerCall }));

  return {
    getProviderMock: vi.fn(() => ({ setup: providerSetup })),
    loadCustomAgentsMock: vi.fn(),
    loadAgentPromptMock: vi.fn(),
    loadPersonaPromptFromPathMock: vi.fn(),
    loadProjectConfigMock: vi.fn(),
    loadGlobalConfigMock: vi.fn(),
    resolveConfigValueMock: vi.fn(),
    resolveProviderOptionsWithTraceMock: vi.fn(),
    loadTemplateMock: vi.fn(),
    providerSetupMock: providerSetup,
    providerCallMock: providerCall,
  };
});

vi.mock('../infra/providers/index.js', () => ({
  getProvider: getProviderMock,
}));

vi.mock('../infra/config/index.js', () => ({
  loadProjectConfig: loadProjectConfigMock,
  loadGlobalConfig: loadGlobalConfigMock,
  loadCustomAgents: loadCustomAgentsMock,
  loadAgentPrompt: loadAgentPromptMock,
  loadPersonaPromptFromPath: loadPersonaPromptFromPathMock,
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: resolveConfigValueMock,
  resolveProviderOptionsWithTrace: resolveProviderOptionsWithTraceMock,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: loadTemplateMock,
}));

import { runAgent } from '../agents/runner.js';
import type { RunAgentOptions } from '../agents/runner.js';

describe('option resolution order', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    providerCallMock.mockResolvedValue({ content: 'ok' });
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    resolveConfigValueMock.mockReturnValue(undefined);
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: undefined,
      source: 'default',
      originResolver: () => 'default',
    });
    loadCustomAgentsMock.mockReturnValue(new Map());
    loadAgentPromptMock.mockReturnValue('prompt');
    loadPersonaPromptFromPathMock.mockReturnValue('persona prompt from path');
    loadTemplateMock.mockReturnValue('template');
  });

  it('should resolve provider in order: CLI > local config > global config', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'opencode' });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'codex',
    });
    expect(getProviderMock).toHaveBeenLastCalledWith('codex');

    await runAgent(undefined, 'task', { cwd: '/repo' });
    expect(getProviderMock).toHaveBeenLastCalledWith('opencode');

    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', { cwd: '/repo' });
    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should apply persona provider override before local/global config', async () => {
    resolveConfigValueMock.mockReturnValue({
      coder: { provider: 'claude' },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'opencode',
      personaProviders: {
        coder: { provider: 'claude' },
      },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
  });

  it('should ignore global personaProviders when project personaProviders key exists', async () => {
    resolveConfigValueMock.mockReturnValue({
      coder: { provider: 'codex' },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'mock',
      personaProviders: {
        coder: { provider: 'codex' },
      },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      personaProviders: {
        reviewer: { provider: 'opencode' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent('reviewer', 'task', {
      cwd: '/repo',
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('mock');
  });

  it('should honor env-resolved personaProviders in standalone runAgent calls', async () => {
    resolveConfigValueMock.mockReturnValue({
      reviewer: { provider: 'codex' },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'mock',
      personaProviders: {
        reviewer: { provider: 'claude' },
      },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent('reviewer', 'task', {
      cwd: '/repo',
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('codex');
  });

  it('should resolve model in order: CLI > persona > local > global', async () => {
    resolveConfigValueMock.mockReturnValue({
      coder: { model: 'persona-model' },
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'local-model',
      personaProviders: {
        coder: { model: 'persona-model' },
      },
    });

    await runAgent('coder', 'task', {
      cwd: '/repo',
      model: 'cli-model',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'cli-model' }),
    );

    await runAgent('coder', 'task', {
      cwd: '/repo',
    });
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'persona-model' }),
    );

    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'codex',
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'global-model' }),
    );
  });

  it('should ignore local/global model if resolved provider is not matching', async () => {
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      model: 'local-model',
    });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      model: 'global-model',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'opencode',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: undefined }),
    );
  });

  it('should use providerOptions from workflow step only', async () => {
    const stepProviderOptions = {
      claude: {
        sandbox: {
          allowUnsandboxedCommands: false,
        },
      },
    };

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      provider: 'claude',
      providerOptions: stepProviderOptions,
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ providerOptions: stepProviderOptions }),
    );
  });

  it('should merge persona providerOptions into standalone runAgent calls', async () => {
    resolveConfigValueMock.mockReturnValue({
      conductor: {
        providerOptions: {
          claude: {
            effort: 'high',
          },
        },
      },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      providerOptions: {
        claude: {
          sandbox: {
            excludedCommands: ['rm'],
          },
        },
      },
      personaProviders: {
        conductor: {
          providerOptions: {
            claude: {
              effort: 'high',
            },
          },
        },
      },
    });
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: {
        claude: {
          sandbox: {
            excludedCommands: ['rm'],
          },
        },
      },
      source: 'project',
      originResolver: () => 'local',
    });

    await runAgent('conductor', 'task', {
      cwd: '/repo',
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: false,
          },
        },
      },
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({
        providerOptions: {
          claude: {
            effort: 'high',
            sandbox: {
              allowUnsandboxedCommands: false,
              excludedCommands: ['rm'],
            },
          },
        },
      }),
    );
  });

  it('should keep env-origin config leaf ahead of persona and explicit providerOptions in standalone runAgent calls', async () => {
    resolveConfigValueMock.mockReturnValue({
      conductor: {
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
            networkAccess: true,
          },
        },
      },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'codex',
      personaProviders: {
        conductor: {
          providerOptions: {
            codex: {
              reasoningEffort: 'high',
              networkAccess: true,
            },
          },
        },
      },
    });
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: {
        codex: {
          reasoningEffort: 'low',
          networkAccess: true,
        },
      },
      source: 'project',
      originResolver: (path: string) => (
        path === 'codex.reasoningEffort' ? 'env' : 'local'
      ),
    });

    await runAgent('conductor', 'task', {
      cwd: '/repo',
      providerOptions: {
        codex: {
          reasoningEffort: 'medium',
          networkAccess: false,
        },
      },
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({
        providerOptions: {
          codex: {
            reasoningEffort: 'low',
            networkAccess: false,
          },
        },
      }),
    );
  });

  it('should pass resolvedProviderOptions through without re-merging raw providerOptions', async () => {
    resolveConfigValueMock.mockReturnValue({
      coder: {
        providerOptions: {
          claude: {
            allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
          },
        },
      },
    });
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
      source: 'project',
      originResolver: () => 'local',
    });

    const handoffOptions: RunAgentOptions & {
      resolvedProviderOptions: {
        opencode: {
          networkAccess: boolean;
        };
        claude: {
          sandbox: {
            allowUnsandboxedCommands: boolean;
          };
        };
      };
    } = {
      cwd: '/repo',
      provider: 'opencode',
      resolvedProvider: 'opencode',
      providerOptions: {
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
        },
      },
      resolvedProviderOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          sandbox: {
            allowUnsandboxedCommands: true,
          },
        },
      },
    };

    await runAgent('coder', 'task', handoffOptions);

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({
        providerOptions: {
          opencode: {
            networkAccess: true,
          },
          claude: {
            sandbox: {
              allowUnsandboxedCommands: true,
            },
          },
        },
      }),
    );
  });

  it('should ignore custom agent provider/model overrides', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude', model: 'project-model' });
    loadGlobalConfigMock.mockReturnValue({
      provider: 'mock',
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo' });

    expect(getProviderMock).toHaveBeenLastCalledWith('claude');
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ model: 'project-model' }),
    );
  });

  it('should merge persona providerOptions into custom agent runAgent calls', async () => {
    resolveConfigValueMock.mockReturnValue({
      custom: {
        providerOptions: {
          claude: {
            effort: 'high',
          },
        },
      },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'claude',
      providerOptions: {
        claude: {
          sandbox: {
            excludedCommands: ['rm'],
          },
        },
      },
      personaProviders: {
        custom: {
          providerOptions: {
            claude: {
              effort: 'high',
            },
          },
        },
      },
    });
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: {
        claude: {
          sandbox: {
            excludedCommands: ['rm'],
          },
        },
      },
      source: 'project',
      originResolver: () => 'local',
    });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));

    await runAgent('custom', 'task', {
      cwd: '/repo',
      providerOptions: {
        claude: {
          sandbox: {
            allowUnsandboxedCommands: false,
          },
        },
      },
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({
        providerOptions: {
          claude: {
            effort: 'high',
            sandbox: {
              allowUnsandboxedCommands: false,
              excludedCommands: ['rm'],
            },
          },
        },
      }),
    );
  });

  it('should keep env-origin config leaf ahead of persona and explicit providerOptions in custom agent runAgent calls', async () => {
    resolveConfigValueMock.mockReturnValue({
      custom: {
        providerOptions: {
          codex: {
            reasoningEffort: 'high',
            networkAccess: true,
          },
        },
      },
    });
    loadProjectConfigMock.mockReturnValue({
      provider: 'codex',
      personaProviders: {
        custom: {
          providerOptions: {
            codex: {
              reasoningEffort: 'high',
              networkAccess: true,
            },
          },
        },
      },
    });
    resolveProviderOptionsWithTraceMock.mockReturnValue({
      value: {
        codex: {
          reasoningEffort: 'low',
          networkAccess: true,
        },
      },
      source: 'project',
      originResolver: (path: string) => (
        path === 'codex.reasoningEffort' ? 'env' : 'local'
      ),
    });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));

    await runAgent('custom', 'task', {
      cwd: '/repo',
      providerOptions: {
        codex: {
          reasoningEffort: 'medium',
          networkAccess: false,
        },
      },
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({
        providerOptions: {
          codex: {
            reasoningEffort: 'low',
            networkAccess: false,
          },
        },
      }),
    );
  });

  it('should use custom agent allowedTools when run options do not provide allowedTools', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', allowedTools: ['Read', 'Grep'] }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo' });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ allowedTools: ['Read', 'Grep'] }),
    );
  });

  it('should prioritize run options allowedTools over custom agent allowedTools', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt', allowedTools: ['Read', 'Grep'] }],
    ]));

    await runAgent('custom', 'task', { cwd: '/repo', allowedTools: ['Write'] });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ allowedTools: ['Write'] }),
    );
  });

  it('should wrap inline persona prompt when workflowMeta has process safety', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });

    await runAgent('inline persona', 'task', {
      cwd: '/repo',
      language: 'en',
      workflowMeta: {
        workflowName: 'takt-default',
        currentStep: 'implement',
        stepsList: [{ name: 'plan' }, { name: 'implement' }],
        currentPosition: '2/2',
        processSafety: { protectedParentRunPid: 4242 },
      },
    });

    expect(loadTemplateMock).toHaveBeenCalledWith(
      'perform_agent_system_prompt',
      'en',
      expect.objectContaining({
        agentDefinition: 'inline persona',
        workflowName: 'takt-default',
        currentStep: 'implement',
        hasProcessSafety: true,
        protectedParentRunPid: '4242',
      }),
    );
    expect(providerSetupMock).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'template',
    }));
  });

  it('should wrap personaPath prompt when workflowMeta has process safety', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      projectCwd: '/project',
      personaPath: '/project/.takt/personas/coder.md',
      language: 'en',
      workflowMeta: {
        workflowName: 'takt-default',
        currentStep: 'implement',
        stepsList: [{ name: 'plan' }, { name: 'implement' }],
        currentPosition: '2/2',
        processSafety: { protectedParentRunPid: 4242 },
      },
    });

    expect(loadPersonaPromptFromPathMock).toHaveBeenCalledWith(
      '/project/.takt/personas/coder.md',
      '/project',
    );
    expect(loadTemplateMock).toHaveBeenCalledWith(
      'perform_agent_system_prompt',
      'en',
      expect.objectContaining({
        agentDefinition: 'persona prompt from path',
        workflowName: 'takt-default',
        currentStep: 'implement',
        hasProcessSafety: true,
        protectedParentRunPid: '4242',
      }),
    );
    expect(providerSetupMock).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'template',
    }));
  });

  it('should not wrap inline persona prompt when workflowMeta has no process safety', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });

    await runAgent('inline persona', 'task', {
      cwd: '/repo',
      language: 'en',
      workflowMeta: {
        workflowName: 'custom-workflow',
        currentStep: 'review',
        stepsList: [{ name: 'plan' }, { name: 'review' }],
        currentPosition: '2/2',
      },
    });

    expect(loadTemplateMock).not.toHaveBeenCalled();
    expect(providerSetupMock).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'inline persona',
    }));
  });

  it('should wrap custom agent prompt when workflowMeta has process safety', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));
    loadAgentPromptMock.mockReturnValue('custom prompt');

    await runAgent('custom', 'task', {
      cwd: '/repo',
      language: 'en',
      workflowMeta: {
        workflowName: 'takt-default',
        currentStep: 'implement',
        stepsList: [{ name: 'plan' }, { name: 'implement' }],
        currentPosition: '2/2',
        processSafety: { protectedParentRunPid: 4242 },
      },
    });

    expect(loadTemplateMock).toHaveBeenCalledWith(
      'perform_agent_system_prompt',
      'en',
      expect.objectContaining({
        agentDefinition: 'custom prompt',
        workflowName: 'takt-default',
        currentStep: 'implement',
        hasProcessSafety: true,
        protectedParentRunPid: '4242',
      }),
    );
    expect(providerSetupMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'custom',
      systemPrompt: 'template',
    }));
  });

  it('should not wrap custom agent prompt when workflowMeta has no process safety', async () => {
    loadProjectConfigMock.mockReturnValue({ provider: 'claude' });
    loadCustomAgentsMock.mockReturnValue(new Map([
      ['custom', { name: 'custom', prompt: 'agent prompt' }],
    ]));
    loadAgentPromptMock.mockReturnValue('custom prompt');

    await runAgent('custom', 'task', {
      cwd: '/repo',
      language: 'en',
      workflowMeta: {
        workflowName: 'custom-workflow',
        currentStep: 'review',
        stepsList: [{ name: 'plan' }, { name: 'review' }],
        currentPosition: '2/2',
      },
    });

    expect(loadTemplateMock).not.toHaveBeenCalled();
    expect(providerSetupMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'custom',
      systemPrompt: 'custom prompt',
    }));
  });

  it('should resolve permission mode after provider resolution using provider profiles', async () => {
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      permissionResolution: {
        stepName: 'supervise',
      },
    });

    expect(getProviderMock).toHaveBeenLastCalledWith('codex');
    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ permissionMode: 'full' }),
    );
  });

  it('should preserve explicit permission mode when permissionResolution is not set', async () => {
    loadProjectConfigMock.mockReturnValue({});
    loadGlobalConfigMock.mockReturnValue({
      provider: 'codex',
      providerProfiles: {
        codex: { defaultPermissionMode: 'full' },
      },
      language: 'en',
      concurrency: 1,
      taskPollIntervalMs: 500,
    });

    await runAgent(undefined, 'task', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    expect(providerCallMock).toHaveBeenLastCalledWith(
      'task',
      expect.objectContaining({ permissionMode: 'readonly' }),
    );
  });
});
