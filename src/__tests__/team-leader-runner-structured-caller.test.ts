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
    const resolveStepProviderModel = vi.fn().mockReturnValue({ provider: 'cursor', model: 'gpt-5' });

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
        model: 'gpt-5',
        persona: 'team-leader',
        provider: 'cursor',
        resolvedModel: 'gpt-5',
        resolvedProvider: 'cursor',
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
        model: 'gpt-5',
        persona: 'team-leader',
        provider: 'cursor',
        resolvedModel: 'gpt-5',
        resolvedProvider: 'cursor',
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

    const buildAgentOptions = vi.fn().mockImplementation((step: WorkflowStep) => ({
      cwd: '/tmp/project',
      allowedTools: step.providerOptions?.claude?.allowedTools,
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

    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          claude: {
            allowedTools: ['Read', 'Edit'],
          },
        },
      }),
      expect.objectContaining({
        providerInfo: { provider: 'claude', model: 'sonnet' },
      }),
    );
    const [, , options] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(options).toEqual(expect.objectContaining({
      cwd: '/tmp/project',
      allowedTools: ['Read', 'Edit'],
    }));
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

    const buildAgentOptions = vi.fn().mockImplementation((step: WorkflowStep, runtime) => {
      if (runtime?.providerInfo?.provider === 'cursor' && step.providerOptions?.claude?.allowedTools) {
        throw new Error('provider_options.claude.allowed_tools is not supported for provider "cursor"');
      }

      return {
        cwd: '/tmp/project',
        allowedTools: step.providerOptions?.claude?.allowedTools,
      };
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
    )).rejects.toThrow(/provider_options\.claude\.allowed_tools.*cursor/i);

    expect(buildAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          claude: {
            allowedTools: ['Read', 'Edit'],
          },
        },
      }),
      expect.objectContaining({
        providerInfo: { provider: 'cursor', model: 'cursor-fast' },
      }),
    );
    expect(mockExecuteAgent).not.toHaveBeenCalled();
  });
});
