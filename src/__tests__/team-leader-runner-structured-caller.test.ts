import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import { runTeamLeaderPart } from '../core/workflow/engine/team-leader-part-runner.js';
import type { AgentResponse, WorkflowStep, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';

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

function buildLeaderOrMemberInstruction(step: WorkflowStep): string {
  return step.name.includes('.') ? step.instruction : 'leader instruction';
}

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
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
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
    const buildInstruction = vi.fn(buildLeaderOrMemberInstruction);

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction,
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      observabilityEnabled: true,
      observabilityRunId: 'run-1',
      sanitizeObservabilityText: (text: string) => text,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller; language: 'ja' };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      policyContents: ['member policy'],
      knowledgeContents: ['member knowledge'],
      qualityGates: ['member quality gate'],
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
      undefined,
    );
    expect(buildInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'implement.part-1',
        instruction: 'Implement API',
        passPreviousResponse: false,
        policyContents: ['member policy'],
        knowledgeContents: ['member knowledge'],
        qualityGates: ['member quality gate'],
        session: 'refresh',
      }),
      expect.any(Number),
      state,
      'implement feature',
      5,
      undefined,
      undefined,
      expect.any(Object),
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

  it('passes the complete previous state output, including a trailing finding, to structured decomposition', async () => {
    const trailingFinding = 'TAIL_FINDING: unresolved review issue';
    const previousOutput: AgentResponse = {
      persona: 'review',
      status: 'done',
      content: `${'x'.repeat(2500)}\n${trailingFinding}`,
      timestamp: new Date(),
    };
    const state: WorkflowState = {
      workflowName: 'workflow',
      currentStep: 'implement',
      iteration: 1,
      stepOutputs: new Map([['review', previousOutput]]),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: previousOutput,
      previousResponseSourcePath: undefined,
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    };
    const decomposeTask = vi.fn().mockImplementation(async (instruction, _maxParts, options) => {
      options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: instruction });
      return [{ id: 'part-1', title: 'Implementation', instruction: 'Implement the change' }];
    });
    const structuredCaller = {
      decomposeTask,
      requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'complete', parts: [] }),
    };
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'model' }),
      },
      stepExecutor: {
        buildInstruction: vi.fn((candidate: WorkflowStep, _iteration, currentState: WorkflowState, task: string) =>
          new InstructionBuilder(candidate, makeInstructionContext({
            task,
            previousOutput: currentState.lastOutput,
          })).build()),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: { projectCwd: '/tmp/project', structuredCaller },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0]);
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder', status: 'done', content: 'done', timestamp: new Date(),
    });
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Use the prior result: {previous_response}',
      passPreviousResponse: true,
      teamLeader: {
        maxConcurrency: 1,
        maxTotalParts: 2,
        timeoutMs: 1000,
      },
    };

    await runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn());

    expect(decomposeTask).toHaveBeenCalledWith(
      expect.stringContaining(trailingFinding),
      2,
      expect.any(Object),
    );
    expect(state.iteration).toBe(1);
    expect(state.lastOutput?.persona).toBe('implement');
    expect(state.stepIterations).toEqual(new Map([
      ['implement', 1],
      ['implement.part-1', 1],
    ]));
  });

  it.each([
    { failOnPartError: true, expectedStatus: 'error', postExecutionCalls: 0 },
    { failOnPartError: false, expectedStatus: 'done', postExecutionCalls: 1 },
  ])('handles a failed member followed by a successful recovery part when failOnPartError=$failOnPartError', async ({
    failOnPartError,
    expectedStatus,
    postExecutionCalls,
  }) => {
    mockExecuteAgent.mockImplementation(async (_persona, instruction: string) => ({
      persona: 'coder',
      status: instruction.includes('part-1') ? 'error' : 'done',
      content: instruction.includes('part-1') ? '' : 'recovery complete',
      error: instruction.includes('part-1') ? 'member failed' : undefined,
      timestamp: new Date(),
    }));
    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _limit, options) => {
        options.onPromptResolved?.({ systemPrompt: 'leader', userInstruction: 'leader instruction' });
        return [
          { id: 'part-1', title: 'first', instruction: 'part-1' },
        ];
      }),
      requestMoreParts: vi.fn()
        .mockResolvedValueOnce({
          done: false,
          reasoning: 'run a recovery part',
          parts: [{ id: 'part-2', title: 'recovery', instruction: 'part-2' }],
        })
        .mockResolvedValue({ done: true, reasoning: 'recovery completed', parts: [] }),
    };
    const applyPostExecutionPhases = vi.fn().mockImplementation(
      async (_step: WorkflowStep, _state: WorkflowState, _iteration: number, response: AgentResponse) => response,
    );
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'local' }),
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases,
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: { projectCwd: '/tmp/project', structuredCaller, language: 'ja' },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0]);
    const state: WorkflowState = {
      workflowName: 'workflow', currentStep: 'implement', iteration: 1,
      stepOutputs: new Map(), structuredOutputs: new Map(), systemContexts: new Map(), effectResults: new Map(),
      lastOutput: undefined, previousResponseSourcePath: undefined, userInputs: [], personaSessions: new Map(),
      stepIterations: new Map(), status: 'running',
    };
    const result = await runner.runTeamLeaderStep({
      name: 'implement', persona: 'coder', personaDisplayName: 'coder', instruction: 'leader instruction',
      passPreviousResponse: false,
      teamLeader: {
        maxConcurrency: 1, initialMaxParts: 1, maxTotalParts: 6, failOnPartError,
        timeoutMs: 1000,
      },
    }, state, 'fix issue', 5, vi.fn());

    expect(structuredCaller.decomposeTask).toHaveBeenCalledWith('leader instruction', 1, expect.any(Object));
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledWith(
      'leader instruction', expect.any(Array), expect.any(Array), 5, expect.any(Object),
    );
    expect(mockExecuteAgent).toHaveBeenCalledWith('coder', 'part-2', expect.any(Object));
    expect(result.response.status).toBe(expectedStatus);
    if (failOnPartError) {
      expect(result.response.error).toBe('Team leader part failed: part-1: member failed');
    } else {
      expect(result.response.content).toContain('recovery complete');
    }
    expect(applyPostExecutionPhases).toHaveBeenCalledTimes(postExecutionCalls);
  });

  it('passes resolved session and step mcpServers to team leader structured planning calls', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
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
    const optionsBuilder = new OptionsBuilder(
      {
        projectCwd: '/tmp/project',
        provider: 'claude',
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp' },
        },
        structuredCaller,
      },
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '.takt/runs/sample/reports',
      () => 'ja',
      () => [{ name: 'implement' }],
      () => 'workflow',
      () => 'test workflow',
    );
    const runner = new TeamLeaderRunner({
      optionsBuilder,
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        provider: 'claude',
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp' },
        },
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
    });
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      provider: 'claude',
      mcpServers: {
        playwright: { type: 'stdio', command: 'playwright-mcp' },
      },
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 2,
        maxTotalParts: 2,
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

    await runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn());

    const expectedMcpServers = {
      docs: { type: 'stdio', command: 'docs-mcp' },
      playwright: { type: 'stdio', command: 'playwright-mcp' },
    };
    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions.mcpServers).toEqual(expectedMcpServers);
    expect(requestOptions.mcpServers).toEqual(expectedMcpServers);
  });

  it('fails before team leader decomposition when session mcpServers are unsupported', async () => {
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    };
    const optionsBuilder = new OptionsBuilder(
      {
        projectCwd: '/tmp/project',
        provider: 'cursor',
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp' },
        },
        structuredCaller,
      },
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '.takt/runs/sample/reports',
      () => 'ja',
      () => [{ name: 'implement' }],
      () => 'workflow',
      () => 'test workflow',
    );
    const runner = new TeamLeaderRunner({
      optionsBuilder,
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        provider: 'cursor',
        mcpServers: {
          docs: { type: 'stdio', command: 'docs-mcp' },
        },
        structuredCaller,
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
    });
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      provider: 'cursor',
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 1,
        maxTotalParts: 1,
        timeoutMs: 1000,
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

    await expect(runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn()))
      .rejects.toThrow(/Provider "cursor" does not support session MCP servers for step "implement"/);
    expect(structuredCaller.decomposeTask).not.toHaveBeenCalled();
  });

  it('should keep an existing team leader part session when the response omits sessionId', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      sessionId: undefined,
    });
    const sessions = new Map<string, string>([
      ['coder:opencode', 'existing-part-session'],
    ]);
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) {
        sessions.delete(key);
      } else {
        sessions.set(key, sessionId);
      }
    });
    const optionsBuilder = {
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode' }),
      buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
    } as unknown as OptionsBuilder;
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'Task',
      passPreviousResponse: false,
      teamLeader: {
        maxConcurrency: 1,
        maxTotalParts: 20,
        timeoutMs: 1000,
        partPersona: 'coder',
      },
    };

    await runTeamLeaderPart(
      optionsBuilder,
      step,
      undefined,
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      0,
      1000,
      updatePersonaSession,
      undefined,
      {
        enabled: false,
        workflowName: 'workflow',
        iteration: 1,
      },
      () => 'member instruction',
    );

    expect(updatePersonaSession).not.toHaveBeenCalled();
    expect(sessions.get('coder:opencode')).toBe('existing-part-session');
  });

  it('Given teamLeader.partTags, When running multiple decomposed parts, Then each part step gets part tags without changing aggregated output', async () => {
    mockExecuteAgent.mockImplementation(async (_persona, instruction: string) => {
      if (instruction.includes('Implement API')) {
        return {
          persona: 'coder',
          status: 'done',
          content: 'API done',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
        };
      }
      if (instruction.includes('Implement UI')) {
        return {
          persona: 'coder',
          status: 'done',
          content: 'UI done',
          timestamp: new Date('2026-04-01T00:01:00.000Z'),
        };
      }
      throw new Error(`Unexpected instruction: ${instruction}`);
    });
    const resolveStepProviderModel = vi.fn().mockImplementation((stepArg: WorkflowStep) => {
      if (stepArg.name === 'implement') {
        return { provider: 'codex', model: 'gpt-5.5' };
      }
      return { provider: 'opencode', model: 'ollama-cloud/qwen3-coder-next' };
    });

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
          { id: 'part-2', title: 'UI', instruction: 'Implement UI' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };
    const buildAgentOptions = vi.fn().mockReturnValue({ cwd: '/tmp/project' });
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller; language: 'ja' };
    });

    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'coder',
      tags: ['leader'],
      instruction: 'Task: {task}',
      passPreviousResponse: true,
      teamLeader: {
        persona: 'team-leader',
        maxConcurrency: 2,
        maxTotalParts: 20,
        timeoutMs: 1000,
        partPersona: 'coder',
        partTags: ['coding', 'edit'],
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

    expect(resolveStepProviderModel.mock.calls.map(([stepArg]) => ({
      name: stepArg.name,
      tags: stepArg.tags,
    }))).toEqual([
      { name: 'implement', tags: ['leader'] },
      { name: 'implement.part-1', tags: ['coding', 'edit'] },
      { name: 'implement.part-2', tags: ['coding', 'edit'] },
    ]);
    expect(buildAgentOptions.mock.calls.map(([stepArg]) => ({
      name: stepArg.name,
      tags: stepArg.tags,
    }))).toEqual([
      { name: 'implement.part-1', tags: ['coding', 'edit'] },
      { name: 'implement.part-2', tags: ['coding', 'edit'] },
    ]);
    expect(result.response.status).toBe('done');
    expect(result.response.content).toContain('## decomposition');
    expect(result.response.content).toContain('"id": "part-1"');
    expect(result.response.content).toContain('"id": "part-2"');
    expect(result.response.content).toContain('## part-1: API');
    expect(result.response.content).toContain('## part-2: UI');
    expect(result.response.content).toContain('API done');
    expect(result.response.content).toContain('UI done');
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
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller; language: 'ja' };
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
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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

  it('Given teamLeader.inspectTools and partAllowedTools, When running a team leader step, Then parent planning uses inspect tools and child parts keep part tools', async () => {
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
    }));
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller; language: 'ja' };
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions).toEqual(expect.objectContaining({
      language: 'ja',
      inspectTools: ['Read', 'Glob', 'Grep'],
    }));
    expect(requestOptions).not.toHaveProperty('inspectTools');
    const [, , partOptions] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(partOptions).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit'],
    }));
  });

  it('Given teamLeader.inspectTools and OpenCode provider, When running a team leader step, Then parent planning keeps OpenCode tool names', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
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

    const buildAgentOptions = vi.fn().mockImplementation((_step: WorkflowStep, runtime) => ({
      cwd: '/tmp/project',
      allowedTools: runtime?.teamLeaderPart?.partAllowedTools,
    }));
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
        applyPostExecutionPhases: vi.fn(async (_step, _state, _iteration, response) => response),
        persistPreviousResponseSnapshot: vi.fn(),
        emitStepReports: vi.fn(),
      },
      engineOptions: {
        projectCwd: '/tmp/project',
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => '/tmp/project',
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
    } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
      engineOptions: { projectCwd: string; structuredCaller: typeof structuredCaller; language: 'ja' };
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
        partAllowedTools: ['read', 'edit'],
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    const [, , partOptions] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(decomposeOptions).toEqual(expect.objectContaining({
      inspectTools: ['read', 'glob', 'grep'],
    }));
    expect(requestOptions).not.toHaveProperty('inspectTools');
    expect(partOptions).toEqual(expect.objectContaining({
      allowedTools: ['read', 'edit'],
    }));
  });

  it('Given teamLeader.inspectTools without partAllowedTools, When running child parts, Then child options do not inherit inspect tools', async () => {
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
    }));
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions,
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    const [, , partOptions] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(decomposeOptions).toEqual(expect.objectContaining({
      inspectTools: ['Read', 'Glob', 'Grep'],
    }));
    expect(requestOptions).not.toHaveProperty('inspectTools');
    expect(partOptions.allowedTools).toBeUndefined();
  });

  it('refresh member session を通常 coder session と分離して保存する', async () => {
    mockExecuteAgent.mockImplementation(async (_persona, instruction: string) => ({
      persona: 'coder',
      status: 'done',
      content: `${instruction} done`,
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      sessionId: instruction.includes('API') ? 'session-opencode-1' : 'session-opencode-2',
    }));
    const resolveStepProviderModel = vi.fn((step: WorkflowStep) => (
      step.name === 'implement'
        ? { provider: 'claude', model: 'sonnet' }
        : { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' }
    ));

    const structuredCaller = {
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxTotalParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
          { id: 'part-2', title: 'UI', instruction: 'Implement UI' },
        ];
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        parts: [],
      }),
    };

    const sessions = new Map<string, string>();
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId !== undefined) {
        sessions.set(key, sessionId);
      }
    });
    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
    expect(updatePersonaSession).toHaveBeenCalledWith('implement.part-2:opencode', 'session-opencode-2');
    expect(sessions.has('coder:opencode')).toBe(false);
  });

  it('report phase の有無にかかわらず member session を part-scoped に保存する', async () => {
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
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel,
      },
      stepExecutor: {
        buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
          resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
          resolveStepProviderModel: vi.fn().mockReturnValue({
            provider: 'claude',
            model: 'opus',
          }),
        },
        stepExecutor: {
          buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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
          resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
          resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'model' }),
        },
        stepExecutor: {
          buildInstruction: vi.fn(buildLeaderOrMemberInstruction),
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

    it('Given two parallel parts time out after the batch barrier, When feedback fails, Then each timed-out part gets a continuation in one later batch', async () => {
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
      expect(result.response.content).toContain('Continuation 1 completed');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1, part-2');
    });

    it('Given two timed-out parts and a failed combined continuation batch, When feedback fails, Then the step fails loud', async () => {
      mockExecuteAgent.mockImplementation(async (_persona, executedInstruction: string) => ({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date(),
        ...(executedInstruction.includes('Timed-out part:') ? { error: 'Continuation timeout after 1000ms' } : {}),
      }));
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
      expect(result.response.error).toContain('part-2: part timeout: Part timeout after 1000ms');
      expect(result.response.error).toContain('timeout-continuation: part timeout: Continuation timeout after 1000ms');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-2');
    });

    it('Given a successful part and a timeout continuation provider_error, When feedback fails, Then the step fails loud', async () => {
      mockExecuteAgent.mockImplementation(async (_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Timed-out part:')) {
          return {
            persona: 'coder', status: 'error', content: '', error: 'Upstream model returned 500',
            failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR, timestamp: new Date(),
          };
        }
        if (executedInstruction.includes('Implement second area')) {
          return { persona: 'coder', status: 'done', content: 'Independent part completed', timestamp: new Date() };
        }
        return {
          persona: 'coder', status: 'error', content: '', error: 'Part timeout after 1000ms',
          failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT, timestamp: new Date(),
        };
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
      expect(result.response.error).toContain('timeout-continuation: provider error: Upstream model returned 500');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1');
    });

    it('Given a later timeout in the same batch, When another continuation completes first, Then the barrier waits before planning', async () => {
      const part1Timeout = createDeferredResponse();
      const part2Timeout = createDeferredResponse();
      const continuation1 = createDeferredResponse();
      mockExecuteAgent.mockImplementation((_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Implement first area')) return part1Timeout.promise;
        if (executedInstruction.includes('Implement second area')) return part2Timeout.promise;
        if (executedInstruction.includes('Timed-out part: part-1')) return continuation1.promise;
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

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      expect(structuredCaller.requestMoreParts).not.toHaveBeenCalled();

      part2Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:02:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      });
      continuation1.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Combined continuation completed after both timeouts',
        timestamp: new Date('2026-04-01T00:03:00.000Z'),
      });

      const result = await runnerPromise;

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Combined continuation completed after both timeouts');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1, part-2');
    });

    it('Given an initial batch with a late timeout, When no continuation may start early, Then the barrier waits for the complete batch', async () => {
      const part1Timeout = createDeferredResponse();
      const part2Timeout = createDeferredResponse();
      const continuation1 = createDeferredResponse();
      mockExecuteAgent.mockImplementation((_persona, executedInstruction: string) => {
        if (executedInstruction.includes('Implement first area')) return part1Timeout.promise;
        if (executedInstruction.includes('Implement second area')) return part2Timeout.promise;
        if (executedInstruction.includes('Timed-out part: part-1')) return continuation1.promise;
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

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
      expect(structuredCaller.requestMoreParts).not.toHaveBeenCalled();

      part2Timeout.resolve({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Part timeout after 1000ms',
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date('2026-04-01T00:02:00.000Z'),
      });

      await vi.waitFor(() => {
        expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      });
      continuation1.resolve({
        persona: 'coder',
        status: 'done',
        content: 'Combined continuation completed after the barrier',
        timestamp: new Date('2026-04-01T00:03:00.000Z'),
      });

      const result = await runnerPromise;

      expect(result.response.status).toBe('done');
      expect(result.response.content).toContain('Combined continuation completed after the barrier');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1, part-2');
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
