import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import type { AgentResponse, WorkflowStep, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';

function createProcessSafetyByStep(parentRunPid: number): WorkflowEngineOptions['phase1ProcessSafetyByStep'] {
  return {
    implement: { protectedParentRunPid: parentRunPid },
  };
}

const {
  mockExecuteAgent,
  mockRunWithPhaseSpan,
} = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
  mockRunWithPhaseSpan: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: mockExecuteAgent,
}));

vi.mock('../core/workflow/observability/workflowSpans.js', async () => {
  const actual = await vi.importActual<typeof import('../core/workflow/observability/workflowSpans.js')>(
    '../core/workflow/observability/workflowSpans.js',
  );
  return {
    ...actual,
    runWithPhaseSpan: mockRunWithPhaseSpan,
  };
});

describe('TeamLeaderRunner with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWithPhaseSpan.mockImplementation(async (_params, execute) => execute());
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
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
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      observabilityEnabled: true,
      observabilityRunId: 'run-1',
      sanitizeObservabilityText: (text: string) => text,
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
        maxConcurrency: 2,
        maxTotalParts: 20,
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
      20,
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
    expect(mockRunWithPhaseSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        runId: 'run-1',
        workflowName: 'workflow',
        step: expect.objectContaining({ name: 'implement.part-1' }),
        iteration: 1,
        phase: 1,
        phaseName: 'execute',
        instruction: expect.stringContaining('Implement API'),
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('takt-default の implement では process safety を leader prompt に渡す', async () => {
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
    const leaderWorkflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: { protectedParentRunPid: 4242 },
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildBaseOptions: vi.fn().mockReturnValue({
          workflowMeta: {
            workflowName: 'takt-default',
            currentStep: 'implement',
            stepsList: [{ name: 'plan' }, { name: 'implement' }],
            currentPosition: '2/2',
          },
        }),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(leaderWorkflowMeta),
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
      getWorkflowName: () => 'workflow',
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
        maxConcurrency: 2,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'takt-default',
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions.workflowMeta).toBe(leaderWorkflowMeta);
    expect(requestOptions.workflowMeta).toBe(leaderWorkflowMeta);
  });

  it('takt-default の非 implement step では leader prompt に process safety を渡さない', async () => {
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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

    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/tmp/project',
      provider: 'opencode',
      providerProfiles: {
        opencode: {
          defaultPermissionMode: 'full',
        },
      },
      structuredCaller,
      phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
    };
    const optionsBuilder = new OptionsBuilder(
      engineOptions,
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '.takt/runs/sample/reports',
      () => 'ja',
      () => [{ name: 'reviewers' }],
      () => 'takt-default',
      () => 'test workflow',
    );

    const runner = new TeamLeaderRunner({
      optionsBuilder,
      stepExecutor: {
        buildInstruction: vi.fn().mockReturnValue('leader instruction'),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        phase1ProcessSafetyByStep: createProcessSafetyByStep(4242),
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'takt-default',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: {
        projectCwd: string;
        structuredCaller: typeof structuredCaller;
        phase1ProcessSafetyByStep: WorkflowEngineOptions['phase1ProcessSafetyByStep'];
      };
    });

    const step: WorkflowStep = {
      name: 'reviewers',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 2,
        maxTotalParts: 20,
        refillThreshold: 0,
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    };

    const state: WorkflowState = {
      workflowName: 'takt-default',
      currentStep: 'reviewers',
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    expect(decomposeOptions.workflowMeta?.processSafety).toBeUndefined();
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
    const leaderWorkflowMeta = {
      workflowName: 'takt-default',
      currentStep: 'implement',
      stepsList: [{ name: 'plan' }, { name: 'implement' }],
      currentPosition: '2/2',
      processSafety: { protectedParentRunPid: 4242 },
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(leaderWorkflowMeta),
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
      getWorkflowName: () => 'workflow',
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
        maxConcurrency: 2,
        maxTotalParts: 20,
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
    expect(runtimeArg?.teamLeaderPart?.processSafety).toEqual({
      protectedParentRunPid: 4242,
    });
    expect(runtimeArg).toEqual(expect.objectContaining({
      providerInfo: { provider: 'claude', model: 'sonnet' },
      teamLeaderPart: {
        partAllowedTools: ['Read', 'Edit'],
        processSafety: { protectedParentRunPid: 4242 },
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
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
      getWorkflowName: () => 'workflow',
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
        maxConcurrency: 2,
        maxTotalParts: 20,
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

  it('report phase を持つ team_leader で parent と part の key が衝突する場合は part-scoped session key で保存する', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      sessionId: 'session-opencode-1',
    });
    const resolveStepProviderModel = vi
      .fn()
      .mockReturnValueOnce({ provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' })
      .mockReturnValueOnce({ provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
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
      getWorkflowName: () => 'workflow',
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
      outputContracts: [
        { name: 'implement.md', format: '# Implement report' },
      ],
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 2,
        maxTotalParts: 20,
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

    expect(updatePersonaSession).toHaveBeenCalledWith('implement.part-1:opencode', 'session-opencode-1');
    expect(updatePersonaSession).not.toHaveBeenCalledWith('coder:opencode', 'session-opencode-1');
  });

  it('non-Claude part execution でも partAllowedTools をそのまま runtime に渡す（プロバイダ層で log & ignore される）', async () => {
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
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
      getWorkflowName: () => 'workflow',
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
        maxConcurrency: 2,
        maxTotalParts: 20,
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

    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'implement.part-1' }),
      {
        providerInfo: { provider: 'cursor', model: 'cursor-fast' },
        teamLeaderPart: { partAllowedTools: ['Read', 'Edit'] },
      },
    );
    const [, , executedOptions] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(executedOptions).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit'],
    }));
  });

  it.each([
    { allowGitCommit: false, expectsGitRules: true },
    { allowGitCommit: true, expectsGitRules: false },
  ])('team leader part prompt should respect allowGitCommit=$allowGitCommit', async ({ allowGitCommit, expectsGitRules }) => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
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
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project', language: 'en' }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'model' }),
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
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      allowGitCommit,
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 2,
        maxTotalParts: 20,
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
      vi.fn(),
    );

    const [, executedInstruction] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(executedInstruction).toContain('Implement API');
    if (expectsGitRules) {
      expect(executedInstruction).toContain('Do NOT run git commit');
      expect(executedInstruction).toContain('Do NOT run git push');
      expect(executedInstruction).toContain('Do NOT run git add');
    } else {
      expect(executedInstruction).not.toContain('Do NOT run git commit');
      expect(executedInstruction).not.toContain('Do NOT run git push');
      expect(executedInstruction).not.toContain('Do NOT run git add');
    }
  });

  describe('onPhaseStart deduplication on decomposeTask retry', () => {
    function buildRunner(
      structuredCaller: {
        decomposeTask: ReturnType<typeof vi.fn>;
        requestMoreParts: ReturnType<typeof vi.fn>;
      },
      onPhaseStart: ReturnType<typeof vi.fn>,
    ) {
      return new TeamLeaderRunner({
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
          buildBaseOptions: vi.fn().mockReturnValue({}),
          buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'claude',
            model: 'opus',
          }),
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
        onPhaseStart,
        getCwd: () => '/tmp/project',
        getWorkflowName: () => 'workflow',
        getInteractive: () => false,
      } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
        engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller };
      });
    }

    function buildStep(): WorkflowStep {
      return {
        name: 'implement',
        persona: 'coder',
        personaDisplayName: 'coder',
        instruction: 'Task: {task}',
        passPreviousResponse: true,
        teamLeader: {
          persona: 'team-leader',
          maxConcurrency: 1,
          maxTotalParts: 20,
          refillThreshold: 0,
          timeoutMs: 1000,
          partPersona: 'coder',
        },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      };
    }

    function buildState(): WorkflowState {
      return {
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
    }

    it('emits onPhaseStart only once even when decomposeTask retries (onPromptResolved fires multiple times)', async () => {
      mockExecuteAgent.mockResolvedValue({
        persona: 'coder',
        status: 'done',
        content: 'API done',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });

      const onPhaseStart = vi.fn();
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
        }),
        requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'enough', parts: [] }),
      };

      const runner = buildRunner(structuredCaller, onPhaseStart);

      await runner.runTeamLeaderStep(buildStep(), buildState(), 'implement feature', 5, vi.fn());

      expect(onPhaseStart).toHaveBeenCalledTimes(1);
    });

    it('emits onPhaseStart only once on the success path (single onPromptResolved call)', async () => {
      mockExecuteAgent.mockResolvedValue({
        persona: 'coder',
        status: 'done',
        content: 'API done',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });

      const onPhaseStart = vi.fn();
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
        }),
        requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'enough', parts: [] }),
      };

      const runner = buildRunner(structuredCaller, onPhaseStart);

      await runner.runTeamLeaderStep(buildStep(), buildState(), 'implement feature', 5, vi.fn());

      expect(onPhaseStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout feedback failure fallback', () => {
    function buildStep(maxConcurrency: number, maxTotalParts = 20): WorkflowStep {
      return {
        name: 'implement',
        persona: 'coder',
        personaDisplayName: 'coder',
        instruction: 'Task: {task}',
        passPreviousResponse: true,
        teamLeader: {
          persona: 'team-leader',
          maxConcurrency,
          maxTotalParts,
          refillThreshold: 0,
          timeoutMs: 1000,
          partPersona: 'coder',
        },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      };
    }

    function buildState(): WorkflowState {
      return {
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
    }

    function buildRunner(structuredCaller: {
      decomposeTask: ReturnType<typeof vi.fn>;
      requestMoreParts: ReturnType<typeof vi.fn>;
    }): TeamLeaderRunner {
      return new TeamLeaderRunner({
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project', language: 'en' }),
          buildBaseOptions: vi.fn().mockReturnValue({}),
          buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
          resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'model' }),
        },
        stepExecutor: {
          buildInstruction: vi.fn().mockReturnValue('leader instruction'),
          applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
          persistPreviousResponseSnapshot: vi.fn(),
          emitStepReports: vi.fn(),
        },
        engineOptions: {
          projectCwd: '/tmp/project',
          language: 'en',
          structuredCaller,
        },
        getCwd: () => '/tmp/project',
        getWorkflowName: () => 'workflow',
        getInteractive: () => false,
        observabilityEnabled: false,
      } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
        engineOptions: { projectCwd: string; language: 'en'; structuredCaller: typeof structuredCaller };
      });
    }

    function createDeferredResponse(): {
      promise: Promise<AgentResponse>;
      resolve: (response: AgentResponse) => void;
    } {
      let resolve!: (response: AgentResponse) => void;
      const promise = new Promise<AgentResponse>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    }

    it('Runner 経由でも maxConcurrency を超えて part を同時実行しない', async () => {
      const part1 = createDeferredResponse();
      const part2 = createDeferredResponse();
      const part3 = createDeferredResponse();
      mockExecuteAgent.mockImplementation((_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Implement first area')) return part1.promise;
        if (executedInstruction.includes('Implement second area')) return part2.promise;
        if (executedInstruction.includes('Implement third area')) return part3.promise;
        throw new Error(`Unexpected instruction: ${executedInstruction}`);
      });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
            { id: 'part-3', title: 'Implementation 3', instruction: 'Implement third area' },
          ];
        }),
        requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'complete', parts: [] }),
      };

      const runnerPromise = buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      });
      expect(mockExecuteAgent.mock.calls[0]?.[1]).toContain('Implement first area');
      expect(mockExecuteAgent.mock.calls[1]?.[1]).toContain('Implement second area');

      part1.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Part 1 completed',
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });
      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      });
      expect(mockExecuteAgent.mock.calls[2]?.[1]).toContain('Implement third area');

      part2.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Part 2 completed',
        timestamp: new Date('2026-04-01T00:00:30.000Z'),
      });
      part3.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Part 3 completed',
        timestamp: new Date('2026-04-01T00:01:00.000Z'),
      });

      const result = await runnerPromise;

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Part 1 completed');
      expect(result.response.content).toContain('Part 2 completed');
      expect(result.response.content).toContain('Part 3 completed');
    });

    it('part_timeout 後の feedback が残予算超過を投げた場合は timeout fallback に変換しない', async () => {
      mockExecuteAgent.mockResolvedValueOnce({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('Structured output produced too many parts: 2 > 1')),
      };

      await expect(buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(1, 2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      )).rejects.toThrow('Structured output produced too many parts: 2 > 1');

      expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    });

    it('Given part_timeout and feedback failure, When running team leader step, Then a continuation part completes the step', async () => {
      mockExecuteAgent
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'Continuation completed',
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(1),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('## part-1: Implementation');
      expect(result.response.content).toContain('[ERROR] part timeout: Part timeout after 1000ms');
      expect(result.response.content).toContain('timeout-continuation');
      expect(result.response.content).toContain('Continuation completed');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[1] ?? [];
      expect(continuationInstruction).toContain('Preserve existing changes');
      expect(continuationInstruction).toContain('Inspect the timed-out part result');
      expect(continuationInstruction).toContain('part-1');
    });

    it('Given a timeout continuation also times out, When feedback fails again, Then no second-level continuation is created', async () => {
      mockExecuteAgent
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(1),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('error');
      expect(result.response.error).toContain('part-1: part timeout: Part timeout after 1000ms');
      expect(result.response.error).toContain('timeout-continuation: part timeout: Part timeout after 1000ms');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[1] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1');
    });

    it('Given two parallel parts time out after the first fallback, When feedback fails, Then each timed-out part gets a continuation', async () => {
      mockExecuteAgent
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:30.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'Continuation 1 completed',
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'Continuation 2 completed',
          timestamp: new Date('2026-04-01T00:01:30.000Z'),
        });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('## timeout-continuation: Timeout continuation');
      expect(result.response.content).toContain('## timeout-continuation-2: Timeout continuation');
      expect(result.response.content).toContain('Continuation 1 completed');
      expect(result.response.content).toContain('Continuation 2 completed');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(4);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
      const [, firstContinuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      const [, secondContinuationInstruction] = mockExecuteAgent.mock.calls[3] ?? [];
      expect(firstContinuationInstruction).toContain('Timed-out part: part-1');
      expect(secondContinuationInstruction).toContain('Timed-out part: part-2');
    });

    it('Given two timeout continuations and one continuation times out, When feedback fails, Then the step returns error', async () => {
      mockExecuteAgent
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:30.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'Continuation 1 completed',
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:01:30.000Z'),
        });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('error');
      expect(result.response.error).toContain('Team leader timeout continuation failed');
      expect(result.response.error).toContain('part-1: part timeout: Part timeout after 1000ms');
      expect(result.response.error).toContain('part-2: part timeout: Part timeout after 1000ms');
      expect(result.response.error).toContain('timeout-continuation-2: part timeout: Part timeout after 1000ms');
      expect(result.response.error).not.toContain('timeout-continuation-3');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
      const [, firstContinuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      const [, secondContinuationInstruction] = mockExecuteAgent.mock.calls[3] ?? [];
      expect(firstContinuationInstruction).toContain('Timed-out part: part-1');
      expect(secondContinuationInstruction).toContain('Timed-out part: part-2');
    });

    it('Given a timeout continuation returns provider_error with a successful part, When feedback fails, Then the step returns error', async () => {
      mockExecuteAgent
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'Independent part completed',
          timestamp: new Date('2026-04-01T00:00:30.000Z'),
        })
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'error',
          content: '',
          error: 'Upstream model returned 500',
          failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('error');
      expect(result.response.error).toContain('Team leader timeout continuation failed');
      expect(result.response.error).toContain('part-1: part timeout: Part timeout after 1000ms');
      expect(result.response.error).toContain('timeout-continuation: provider error: Upstream model returned 500');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1');
    });

    it('Given a timeout continuation finishes before another running part times out, When feedback fails, Then planning waits for the later timeout', async () => {
      const part1Timeout = createDeferredResponse();
      const part2Timeout = createDeferredResponse();
      const continuation1 = createDeferredResponse();
      const continuation2 = createDeferredResponse();
      mockExecuteAgent.mockImplementation((_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Implement first area')) return part1Timeout.promise;
        if (executedInstruction.includes('Implement second area')) return part2Timeout.promise;
        if (executedInstruction.includes('Timed-out part: part-1')) return continuation1.promise;
        if (executedInstruction.includes('Timed-out part: part-2')) return continuation2.promise;
        throw new Error(`Unexpected instruction: ${executedInstruction}`);
      });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const runnerPromise = buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      });
      part1Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      });
      continuation1.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Continuation 1 completed before part 2 timed out',
        timestamp: new Date('2026-04-01T00:01:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      });
      part2Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:02:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
      });
      continuation2.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Continuation 2 completed',
        timestamp: new Date('2026-04-01T00:03:00.000Z'),
      });

      const result = await runnerPromise;

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Continuation 1 completed before part 2 timed out');
      expect(result.response.content).toContain('Continuation 2 completed');
      expect(result.response.content).toContain('## timeout-continuation-2: Timeout continuation');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(4);
      const [, secondContinuationInstruction] = mockExecuteAgent.mock.calls[3] ?? [];
      expect(secondContinuationInstruction).toContain('Timed-out part: part-2');
    });

    it('Given structured feedback returns done while another part is still running, When that part later times out, Then continuation planning stays open', async () => {
      const part1Timeout = createDeferredResponse();
      const part2Timeout = createDeferredResponse();
      const continuation1 = createDeferredResponse();
      const continuation2 = createDeferredResponse();
      mockExecuteAgent.mockImplementation((_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Implement first area')) return part1Timeout.promise;
        if (executedInstruction.includes('Implement second area')) return part2Timeout.promise;
        if (executedInstruction.includes('Timed-out part: part-1')) return continuation1.promise;
        if (executedInstruction.includes('Timed-out part: part-2')) return continuation2.promise;
        throw new Error(`Unexpected instruction: ${executedInstruction}`);
      });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ];
        }),
        requestMoreParts: vi.fn()
          .mockRejectedValueOnce(new Error('feedback failed'))
          .mockResolvedValueOnce({ done: true, reasoning: 'leader says complete', parts: [] })
          .mockRejectedValue(new Error('feedback failed')),
      };

      const runnerPromise = buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(2),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      });
      part1Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      });
      continuation1.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Continuation 1 completed before part 2 timed out',
        timestamp: new Date('2026-04-01T00:01:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      });
      part2Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:02:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
      });
      continuation2.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Continuation 2 completed after structured done',
        timestamp: new Date('2026-04-01T00:03:00.000Z'),
      });

      const result = await runnerPromise;

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Continuation 1 completed before part 2 timed out');
      expect(result.response.content).toContain('Continuation 2 completed after structured done');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(4);
      const [, secondContinuationInstruction] = mockExecuteAgent.mock.calls[3] ?? [];
      expect(secondContinuationInstruction).toContain('Timed-out part: part-2');
    });

    it('Given provider_error and feedback failure, When running team leader step, Then no timeout continuation is created', async () => {
      mockExecuteAgent.mockResolvedValueOnce({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Upstream model returned 500',
        failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
        timestamp: new Date('2026-04-01T00:00:00.000Z'),
      });
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }];
        }),
        requestMoreParts: vi.fn().mockRejectedValue(new Error('feedback failed')),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(1),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'error',
        error: 'All team leader parts failed: part-1: provider error: Upstream model returned 500',
      });
      expect(result.response.content).not.toContain('timeout-continuation');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    });
  });
});
