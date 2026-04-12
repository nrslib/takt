import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import type { WorkflowStep, WorkflowState } from '../core/models/types.js';

const {
  mockExecuteAgent,
} = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: mockExecuteAgent,
}));

describe('TeamLeaderRunner with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate decomposition and feedback to structuredCaller instead of legacy usecases', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi.fn().mockReturnValue({
      provider: 'opencode',
      model: 'opencode/zai-coding-plan/glm-5.1',
    });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      providerOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          sandbox: {
            excludedCommands: ['./gradlew'],
          },
        },
      },
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };

    const result = await runner.runTeamLeaderStep(
      step,
      state,
      'implement feature',
      5,
      vi.fn(),
    );

    expect(result.response.status).toBe('done');
    expect(result.response.content).toContain('part-1');
    expect(structuredCaller.decomposeTask).toHaveBeenCalledWith(
      'leader instruction',
      2,
      expect.objectContaining({
        cwd: '/tmp/project',
        model: 'opencode/zai-coding-plan/glm-5.1',
        persona: 'team-leader',
        provider: 'opencode',
        resolvedModel: 'opencode/zai-coding-plan/glm-5.1',
        resolvedProvider: 'opencode',
      }),
    );
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledWith(
      'leader instruction',
      [
        {
          id: 'part-1',
          title: 'API',
          status: 'done',
          content: 'API done',
        },
      ],
      ['part-1'],
      19,
      expect.objectContaining({
        cwd: '/tmp/project',
        model: 'opencode/zai-coding-plan/glm-5.1',
        persona: 'team-leader',
        provider: 'opencode',
        resolvedModel: 'opencode/zai-coding-plan/glm-5.1',
        resolvedProvider: 'opencode',
      }),
    );
    expect(resolveStepProviderModel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'implement',
        persona: 'team-leader',
      }),
    );
  });

  it('Claude part execution では partAllowedTools を executeAgent options に反映する', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi
      .fn()
      .mockReturnValueOnce({ provider: 'claude', model: 'sonnet' })
      .mockReturnValueOnce({ provider: 'claude', model: 'sonnet' });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const buildAgentOptions = vi.fn().mockImplementation((_step: WorkflowStep, runtime) => ({
      cwd: '/tmp/project',
      allowedTools: runtime?.teamLeaderPart?.partAllowedTools,
      providerOptions: undefined,
    }));

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      providerOptions: {
        opencode: {
          networkAccess: true,
        },
        claude: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          sandbox: {
            excludedCommands: ['./gradlew'],
          },
        },
      },
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };

    await runner.runTeamLeaderStep(
      step,
      state,
      'implement feature',
      5,
      vi.fn(),
    );

    const [partStepArg, runtimeArg] = buildAgentOptions.mock.calls[0] ?? [];
    expect(partStepArg).toEqual(expect.objectContaining({
      name: 'implement.part-1',
      persona: 'coder',
    }));
    expect(partStepArg?.providerOptions).toEqual({
      opencode: {
        networkAccess: true,
      },
      claude: {
        allowedTools: ['Read', 'Edit', 'Bash'],
        sandbox: {
          excludedCommands: ['./gradlew'],
        },
      },
    });
    expect(runtimeArg).toEqual(expect.objectContaining({
      providerInfo: { provider: 'claude', model: 'sonnet' },
      teamLeaderPart: {
        partAllowedTools: ['Read', 'Edit'],
      },
    }));
    const [, , options] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(options).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      allowedTools: ['Read', 'Edit'],
    }));
  });

  it('resolved provider を含む session key で part session を保存する', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      sessionId: 'session-opencode-1',
    });
    const resolveStepProviderModel = vi
      .fn()
      .mockReturnValueOnce({ provider: 'claude', model: 'sonnet' })
      .mockReturnValueOnce({ provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const updatePersonaSession = vi.fn();
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };

    await runner.runTeamLeaderStep(
      step,
      state,
      'implement feature',
      5,
      updatePersonaSession,
    );

    expect(updatePersonaSession).toHaveBeenCalledWith('coder:opencode', 'session-opencode-1');
  });

  it('non-Claude part execution では partAllowedTools 設定を fail-fast 契約へ委譲する', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi
      .fn()
      .mockReturnValueOnce({ provider: 'cursor', model: 'cursor-fast' })
      .mockReturnValueOnce({ provider: 'cursor', model: 'cursor-fast' });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const buildAgentOptions = vi.fn().mockImplementation(() => {
      throw new Error('team_leader.part_allowed_tools is not supported for provider "cursor"');
    });

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };

    await expect(runner.runTeamLeaderStep(
      step,
      state,
      'implement feature',
      5,
      vi.fn(),
    )).rejects.toThrow(/team_leader\.part_allowed_tools.*cursor/i);

    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'implement.part-1',
      }),
      {
        providerInfo: {
          provider: 'cursor',
          model: 'cursor-fast',
        },
        teamLeaderPart: {
          partAllowedTools: ['Read', 'Edit'],
        },
      },
    );
    expect(mockExecuteAgent).not.toHaveBeenCalled();
  });

  it('provider 未解決のまま part_allowed_tools を使うと fail-fast し、part 実行に進まない', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi
      .fn()
      .mockReturnValueOnce({ provider: 'claude', model: 'sonnet' })
      .mockReturnValueOnce({ provider: undefined, model: undefined });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const buildAgentOptions = vi.fn().mockImplementation(() => {
      throw new Error('Step "implement.part-1" uses team_leader.part_allowed_tools but provider is not resolved');
    });

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxParts: 2,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: undefined,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };

    await expect(runner.runTeamLeaderStep(
      step,
      state,
      'implement feature',
      5,
      vi.fn(),
    )).rejects.toThrow(/team_leader\.part_allowed_tools.*provider is not resolved/i);

    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'implement.part-1',
      }),
      {
        providerInfo: {
          provider: undefined,
          model: undefined,
        },
        teamLeaderPart: {
          partAllowedTools: ['Read', 'Edit'],
        },
      },
    );
    expect(mockExecuteAgent).not.toHaveBeenCalled();
  });
});
