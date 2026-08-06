import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { createOperationJournalStore } from '../infra/workflow/operation-journal-store.js';
import type {
  FindingContractConfig,
  FindingLedger,
} from '../core/models/types.js';
import type { RuntimeStepResolution } from '../core/workflow/types.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import type { FindingEvidenceRecord } from '../core/models/finding-types.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import {
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
} from '../agents/team-leader-decomposition-regeneration.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import * as capabilityModule from '../infra/providers/provider-capabilities.js';
import {
  buildPartScopedSessionKey,
  runTeamLeaderPart,
} from '../core/workflow/engine/team-leader-part-runner.js';
import type { AgentResponse, WorkflowStep, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { TeamLeaderPartCancellation } from '../core/workflow/engine/team-leader-part-cancellation.js';

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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
      }),
      requestMoreParts: vi.fn().mockResolvedValue({
        done: true,
        reasoning: 'enough',
        cancelPartIds: [],
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
      policyContents: [{ content: 'member policy' }],
      knowledgeContents: [{ content: 'member knowledge' }],
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
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
      undefined,
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
        policyContents: [{ content: 'member policy' }],
        knowledgeContents: [{ content: 'member knowledge' }],
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
      return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement the change' }] };
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
        timeoutMs: 1000,
      },
    };

    await runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn());

    expect(decomposeTask).toHaveBeenCalledWith(
      expect.stringContaining(trailingFinding),
      undefined,
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
        return { parts: [
          { id: 'part-1', title: 'first', instruction: 'part-1' },
        ] };
      }),
      requestMoreParts: vi.fn()
        .mockResolvedValueOnce({
          done: false,
          reasoning: 'run a recovery part',
          cancelPartIds: [],
          parts: [{ id: 'part-2', title: 'recovery', instruction: 'part-2' }],
        })
        .mockResolvedValue({
          done: true,
          reasoning: 'recovery completed',
          cancelPartIds: [],
          parts: [],
        }),
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
        maxConcurrency: 1, initialMaxParts: 1, failOnPartError,
        timeoutMs: 1000,
      },
    }, state, 'fix issue', 5, vi.fn());

    expect(structuredCaller.decomposeTask).toHaveBeenCalledWith('leader instruction', 1, expect.any(Object));
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledWith(
      'leader instruction', expect.any(Array), expect.any(Array), expect.any(Object),
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions.mcpServers).toEqual(expectedMcpServers);
    expect(requestOptions.mcpServers).toEqual(expectedMcpServers);
  });

  it('fails before team leader decomposition when session mcpServers are unsupported', async () => {
    // issue #1137: all real providers now declare MCP transports. Mock the
    // capability probe to simulate a provider without MCP support and verify
    // the fail-fast path still works before team leader decomposition.
    vi.spyOn(capabilityModule, 'providerSupportsMcpServers').mockReturnValue(false);
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
        timeoutMs: 1000,
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    vi.restoreAllMocks();
  });

  it('should keep an existing team leader part session when the response omits sessionId', async () => {
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
      sessionId: undefined,
    });
    const partSessionKey = buildPartScopedSessionKey(
      { name: 'implement.part-1', instruction: 'Implement API' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    );
    const sessions = new Map<string, string>([
      [partSessionKey, 'existing-part-session'],
    ]);
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) {
        sessions.delete(key);
      } else {
        sessions.set(key, sessionId);
      }
    });
    const optionsBuilder = {
      resolveStepProviderModel: vi.fn().mockReturnValue({
        provider: 'opencode',
        model: 'opencode/zai-coding-plan/glm-5.1',
      }),
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
    expect(sessions.get(partSessionKey)).toBe('existing-part-session');
  });

  it.each(['response', 'throw'] as const)(
    '個別取消の%s経路でsessionを公開しない',
    async (outcome) => {
      const cancellation = new TeamLeaderPartCancellation('part-1');
      const controller = new AbortController();
      controller.abort(cancellation);
      mockExecuteAgent.mockImplementation(async () => {
        if (outcome === 'throw') {
          throw cancellation;
        }
        return {
          persona: 'coder',
          status: 'error',
          content: '',
          timestamp: new Date('2026-04-01T00:00:00.000Z'),
          sessionId: 'cancelled-session',
        };
      });
      const updatePersonaSession = vi.fn();
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
          timeoutMs: 1000,
          partPersona: 'coder',
        },
      };

      await expect(runTeamLeaderPart(
        optionsBuilder,
        step,
        undefined,
        { id: 'part-1', title: 'API', instruction: 'Implement API' },
        0,
        1000,
        updatePersonaSession,
        undefined,
        { enabled: false, workflowName: 'workflow', iteration: 1 },
        () => 'member instruction',
        undefined,
        controller.signal,
      )).rejects.toBe(cancellation);

      expect(updatePersonaSession).not.toHaveBeenCalled();
    },
  );

  it('providerがerrorで終了しても個別取消reasonがあればcancelled phaseとして扱う', async () => {
    const cancellation = new TeamLeaderPartCancellation('part-1');
    const controller = new AbortController();
    controller.abort(cancellation);
    const providerFailure = new Error('Provider request failed during cancellation');
    let phaseErrorOutcome: unknown;
    mockExecuteAgent.mockRejectedValue(providerFailure);
    mockRunWithPhaseSpan.mockImplementation(async (_params, execute, _getOutcome, getErrorOutcome) => {
      try {
        return await execute();
      } catch (error) {
        phaseErrorOutcome = getErrorOutcome(error);
        throw error;
      }
    });
    const optionsBuilder = {
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode' }),
      buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
    } as unknown as OptionsBuilder;
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      instruction: 'Task',
      passPreviousResponse: false,
      teamLeader: { maxConcurrency: 1, timeoutMs: 1000, partPersona: 'coder' },
    };

    await expect(runTeamLeaderPart(
      optionsBuilder,
      step,
      undefined,
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      0,
      1000,
      vi.fn(),
      undefined,
      { enabled: true, workflowName: 'workflow', iteration: 1 },
      () => 'member instruction',
      undefined,
      controller.signal,
    )).rejects.toBe(cancellation);

    expect(phaseErrorOutcome).toEqual({ status: 'cancelled' });
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
          { id: 'part-2', title: 'UI', instruction: 'Implement UI' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
        partTags: ['coding', 'edit'],
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
        partAllowedTools: ['read', 'edit'],
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        inspectTools: ['read', 'glob', 'grep'],
        partPersona: 'coder',
      } as WorkflowStep['teamLeader'] & { inspectTools: string[] },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
          { id: 'part-2', title: 'UI', instruction: 'Implement UI' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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

    const partOneSessionKey = buildPartScopedSessionKey(
      { name: 'implement.part-1', instruction: 'Implement API' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    );
    const partTwoSessionKey = buildPartScopedSessionKey(
      { name: 'implement.part-2', instruction: 'Implement UI' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    );

    expect(JSON.parse(partOneSessionKey)).toEqual([
      'implement.part-1',
      'opencode',
      'opencode/zai-coding-plan/glm-5.1',
    ]);
    expect(JSON.parse(partTwoSessionKey)).toEqual([
      'implement.part-2',
      'opencode',
      'opencode/zai-coding-plan/glm-5.1',
    ]);
    expect(updatePersonaSession).toHaveBeenCalledWith(partOneSessionKey, 'session-opencode-1');
    expect(updatePersonaSession).toHaveBeenCalledWith(partTwoSessionKey, 'session-opencode-2');
    expect(sessions.has(buildPartScopedSessionKey(
      { name: 'coder', instruction: 'Task: {task}' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    ))).toBe(false);
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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

    const partSessionKey = buildPartScopedSessionKey(
      { name: 'implement.part-1', instruction: 'Implement API' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    );
    const coderSessionKey = buildPartScopedSessionKey(
      { name: 'coder', instruction: 'Task: {task}' },
      { provider: 'opencode', model: 'opencode/zai-coding-plan/glm-5.1' },
    );

    expect(updatePersonaSession).toHaveBeenCalledWith(partSessionKey, 'session-opencode-1');
    expect(updatePersonaSession).not.toHaveBeenCalledWith(coderSessionKey, 'session-opencode-1');
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
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
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
        timeoutMs: 1000,
        partPersona: 'coder',
        partAllowedTools: ['Read', 'Edit'],
        partEdit: true,
        partPermissionMode: 'edit',
      },
      rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
          timeoutMs: 1000,
          partPersona: 'coder',
        },
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
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
          return { parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }] };
        }),
        requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'enough', parts: [] }),
      };

      const runner = buildRunner(structuredCaller, onPhaseStart);

      await runner.runTeamLeaderStep(buildStep(), buildState(), 'implement feature', 5, vi.fn());

      expect(onPhaseStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout feedback failure fallback', () => {
    function buildStep(maxConcurrency: number): WorkflowStep {
      return {
        name: 'implement',
        persona: 'coder',
        personaDisplayName: 'coder',
        instruction: 'Task: {task}',
        passPreviousResponse: true,
        teamLeader: {
          persona: 'team-leader',
          maxConcurrency,
          timeoutMs: 1000,
          partPersona: 'coder',
        },
        rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
            { id: 'part-3', title: 'Implementation 3', instruction: 'Implement third area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [
            { id: 'part-1', title: 'Implementation 1', instruction: 'Implement first area' },
            { id: 'part-2', title: 'Implementation 2', instruction: 'Implement second area' },
          ] };
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
        decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
          options.onPromptResolved?.({
            systemPrompt: 'team-leader-system',
            userInstruction: 'leader instruction',
          });
          return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement everything' }] };
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

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function fileQuoteEvidenceRecord(
  path: string,
  line: number,
  claimIdentityHash: string,
): FindingEvidenceRecord {
  const payload = {
    kind: 'file_quote' as const,
    path,
    startLine: line,
    endLine: line,
    verbatimExcerpt: 'fixture evidence',
    snapshotId: 'a'.repeat(64),
    claimIdentityHash,
    fileHash: 'c'.repeat(64),
  };
  return {
    evidenceId: computeFileQuoteEvidenceRecordId(payload),
    ...payload,
  };
}

function makeLedger(): FindingLedger {
  const observedAt = {
    runId: 'run-1',
    stepName: 'reviewers',
    timestamp: '2026-07-24T00:00:00.000Z',
  };
  const firstRaw = canonicalRawFindingFixture({
    rawFindingId: 'R-0001',
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'first-family',
    severity: 'high',
    title: 'First defect',
    description: 'first description',
    suggestion: 'fix first',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/first.ts'] },
    evidence: [{
      kind: 'file_quote',
      path: 'src/first.ts',
      startLine: 10,
      endLine: 10,
      verbatimExcerpt: 'fixture evidence',
      snapshotId: 'a'.repeat(64),
    }],
  });
  const secondRaw = canonicalRawFindingFixture({
    rawFindingId: 'R-0002',
    stepName: 'reviewers',
    reviewer: 'reviewer',
    familyTag: 'second-family',
    severity: 'medium',
    title: 'Second defect',
    description: 'second description',
    suggestion: 'fix second',
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/second.ts'] },
    evidence: [{
      kind: 'file_quote',
      path: 'src/second.ts',
      startLine: 20,
      endLine: 20,
      verbatimExcerpt: 'fixture evidence',
      snapshotId: 'a'.repeat(64),
    }],
  });
  const firstEvidence = fileQuoteEvidenceRecord(
    'src/first.ts',
    10,
    firstRaw.claimIdentityHash,
  );
  const secondEvidence = fileQuoteEvidenceRecord(
    'src/second.ts',
    20,
    secondRaw.claimIdentityHash,
  );
  return authorizeFindingLedgerFixture({
    workflowName: 'workflow',
    nextId: 3,
    updatedAt: observedAt.timestamp,
    findings: [
      {
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        target: firstRaw.target,
        targetIdentityHash: firstRaw.targetIdentityHash,
        claimIdentityHash: firstRaw.claimIdentityHash,
        semanticClaimIdentityHash: firstRaw.semanticClaimIdentityHash,
        severity: 'high',
        title: 'First defect',
        evidenceIds: [firstEvidence.evidenceId],
        description: 'first description',
        suggestion: 'fix first',
        reviewers: ['reviewer'],
        rawFindingIds: ['R-0001'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      },
      {
        id: 'F-0002',
        status: 'open',
        lifecycle: 'persists',
        revision: 1,
        target: secondRaw.target,
        targetIdentityHash: secondRaw.targetIdentityHash,
        claimIdentityHash: secondRaw.claimIdentityHash,
        semanticClaimIdentityHash: secondRaw.semanticClaimIdentityHash,
        severity: 'medium',
        title: 'Second defect',
        evidenceIds: [secondEvidence.evidenceId],
        description: 'second description',
        suggestion: 'fix second',
        reviewers: ['reviewer'],
        rawFindingIds: ['R-0002'],
        firstSeen: observedAt,
        lastSeen: observedAt,
      },
    ],
    evidenceRecords: [firstEvidence, secondEvidence].sort(
      (left, right) => compareBinaryStrings(left.evidenceId, right.evidenceId),
    ),
    rawFindings: [firstRaw, secondRaw],
    conflicts: [],
    reviewerAnomalies: [],
  });
}

function makeState(): WorkflowState {
  return {
    workflowName: 'workflow',
    currentStep: 'fix',
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

describe('TeamLeaderRunner finding_contract_fix', () => {
  beforeEach(() => {
    // Fully reset queued once-implementations from other describes before each
    // finding-contract run, then restore the phase-span pass-through.
    vi.resetAllMocks();
    mockRunWithPhaseSpan.mockImplementation(async (_params, execute) => execute());
  });

  it('scopes each worker to assigned findings and publishes the explicit final decision', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-finding-contract-runner-'));
    temporaryDirectories.push(cwd);
    const runPaths = buildRunPaths(cwd, 'run-1');
    mkdirSync(runPaths.contextAbs, { recursive: true });
    const operationStore = createOperationJournalStore(runPaths.operationJournalAbs);
    const ledger = makeLedger();
    const ledgerStore = {
      loadLedger: vi.fn(() => ledger),
      saveLedgerSnapshot: vi.fn(),
    } as unknown as FindingLedgerStore;
    const findingContract: FindingContractConfig = {
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'contract',
      },
    };
    const parts = [
      {
        id: 'repair-first',
        title: 'First',
        instruction: 'repair first',
        findingContract: {
          findingIds: ['F-0001'],
          role: 'repair' as const,
          readPaths: [],
        },
      },
      {
        id: 'repair-second',
        title: 'Second',
        instruction: 'repair second',
        findingContract: {
          findingIds: ['F-0002'],
          role: 'repair' as const,
          readPaths: [],
        },
      },
    ];
    const verificationPart = {
      id: 'verify-first',
      title: 'Verify first',
      instruction: 'verify first',
      findingContract: {
        findingIds: ['F-0001'],
        role: 'verify' as const,
        readPaths: ['src/first.ts'],
      },
    };
    mockExecuteAgent
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'FIRST_RAW',
        sessionId: 'worker-session-1',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'disputed', evidence: ['inspected source'] }],
          changedPaths: ['src/first.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first claim needs evidence correction',
        },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'SECOND_RAW',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0002', outcome: 'addressed', evidence: ['src/second.ts:20'] }],
          changedPaths: ['src/second.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'second fixed',
        },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'CORRECTED_FIRST_CLAIM',
        sessionId: 'worker-session-2',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/first.ts:10'] }],
          changedPaths: ['src/first.ts'],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first claim needs evidence correction',
        },
        timestamp: new Date(),
      })
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'VERIFY_RAW',
        structuredOutput: {
          findingOutcomes: [{ findingId: 'F-0001', outcome: 'addressed', evidence: ['src/first.ts:10'] }],
          changedPaths: [],
          checks: [{ command: 'npm test', status: 'passed' }],
          summary: 'first verified',
        },
        timestamp: new Date(),
      });
    const completeDecision = {
      decision: 'complete' as const,
      reasoning: 'all covered',
      parts: [] as [],
      blockers: [] as string[],
      fixCoverage: parts.map((part) => {
        const findingId = part.findingContract.findingIds[0];
        if (!findingId) throw new Error(`Missing finding assignment: ${part.id}`);
        return {
          findingId,
          disposition: 'addressed' as const,
          supportingPartIds: [part.id],
          verificationPartIds: [part.id === 'repair-first' ? verificationPart.id : part.id],
        };
      }),
    };
    const rawDecisionResponse = (structuredOutput: Record<string, unknown>): AgentResponse => ({
      persona: 'leader',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      structuredOutput,
      timestamp: new Date(),
    });
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: 'leader instruction' });
        return { parts };
      }),
      requestDecompositionRawResponse: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({ systemPrompt: 'system', userInstruction: 'leader instruction' });
        return rawDecisionResponse({ parts });
      }),
      requestMoreParts: vi.fn()
        .mockResolvedValue({ done: true, reasoning: 'unused', parts: [] }),
      requestMorePartsRawResponse: vi.fn()
        .mockResolvedValueOnce(rawDecisionResponse({
          decision: 'continue',
          reasoning: 'invalid coverage',
          parts: [verificationPart],
          fixCoverage: [{
            findingId: 'F-0001',
            disposition: 'addressed',
            supportingPartIds: ['repair-first'],
            verificationPartIds: ['repair-first'],
          }],
          blockers: [],
        }))
        .mockResolvedValueOnce(rawDecisionResponse({
          ...completeDecision,
          reasoning: 'unsupported disposition',
          fixCoverage: completeDecision.fixCoverage.map((coverage) => (
            coverage.findingId === 'F-0001'
              ? { ...coverage, disposition: 'disputed' }
              : coverage
          )),
        }))
        .mockResolvedValueOnce(rawDecisionResponse({
          decision: 'continue',
          reasoning: 'verify first',
          parts: [verificationPart],
          fixCoverage: [],
          blockers: [],
        }))
        .mockResolvedValueOnce(rawDecisionResponse(completeDecision)),
    };
    let leaderContext: unknown;
    let completeRuleMatched = false;
    let postExecutionCalls = 0;
    let workflowStepIterations: Record<string, number> = { fix: 1 };
    const stepExecutor = {
      buildInstruction: vi.fn((step: WorkflowStep, _iteration, _state, _task, _max, _fallback, context) => {
        if (!step.name.includes('.')) leaderContext = context;
        return step.name.includes('.') ? step.instruction : 'leader instruction';
      }),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutput: vi.fn((_step, response: AgentResponse) => response),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      })),
      applyPostExecutionPhases: vi.fn(async (_step, state: WorkflowState, _iteration, response: AgentResponse) => {
        postExecutionCalls += 1;
        if (postExecutionCalls === 1) {
          throw new Error('simulated crash after accepted Team Leader boundaries');
        }
        if (response.structuredOutput) state.structuredOutputs.set('fix', response.structuredOutput);
        completeRuleMatched = evaluateWhenExpression(
          'structured.fix.decision == "complete"',
          state,
        );
        return response;
      }),
      persistPreviousResponseSnapshot: vi.fn(),
      emitStepReports: vi.fn(),
    };
    const runnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd }),
        buildBaseOptions: vi.fn().mockReturnValue({}),
        buildResumeOptions: vi.fn((_step, sessionId) => ({
          cwd,
          sessionId,
          permissionMode: 'readonly',
          allowedTools: [],
        })),
        buildNewSessionReportOptions: vi.fn().mockReturnValue({
          cwd,
          permissionMode: 'readonly',
          allowedTools: [],
        }),
        buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
        resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'codex', model: 'gpt-5' }),
      },
      stepExecutor,
      engineOptions: { projectCwd: cwd, structuredCaller, language: 'ja' },
      getCwd: () => cwd,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => runPaths,
      getCurrentWorkflowStack: () => [{
        workflow: 'workflow',
        workflow_ref: 'project:sha256:workflow',
        step: 'fix',
        kind: 'agent',
        occurrence: 1,
        step_iterations: workflowStepIterations,
      }],
      findingContract,
      findingLedgerStore: ledgerStore,
      operationJournal: {
        store: operationStore,
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-a',
      },
      observabilityEnabled: false,
      emitEvent: vi.fn(),
    } as unknown as ConstructorParameters<typeof TeamLeaderRunner>[0];
    const step: WorkflowStep = {
      name: 'fix',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'fix findings',
      edit: true,
      teamLeader: {
        mode: 'finding_contract_fix',
        maxConcurrency: 2,
        timeoutMs: 1000,
        partPersona: 'coder',
        partEdit: true,
      },
    };
    const state = makeState();
    state.stepIterations.set('fix', 1);

    const firstRunner = new TeamLeaderRunner(runnerDeps);
    await expect(
      firstRunner.runTeamLeaderStep(step, state, 'task', 20, vi.fn(), undefined, 1),
    ).rejects.toThrow('simulated crash after accepted Team Leader boundaries');
    const callsBeforeResume = {
      worker: mockExecuteAgent.mock.calls.length,
      decomposition: structuredCaller.requestDecompositionRawResponse.mock.calls.length,
      decision: structuredCaller.requestMorePartsRawResponse.mock.calls.length,
    };
    workflowStepIterations = {
      fix: 1,
      'fix.repair-first': 1,
      'fix.repair-second': 1,
      'fix.verify-first': 1,
    };
    const resumedRunner = new TeamLeaderRunner({
      ...runnerDeps,
      operationJournal: {
        store: createOperationJournalStore(runPaths.operationJournalAbs),
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-b',
        sourceClaimTokens: new Set(['claim-a']),
      },
    });
    const result = await resumedRunner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      undefined,
      1,
    );

    expect(mockExecuteAgent).toHaveBeenCalledTimes(callsBeforeResume.worker);
    expect(structuredCaller.requestDecompositionRawResponse).toHaveBeenCalledTimes(callsBeforeResume.decomposition);
    expect(structuredCaller.requestMorePartsRawResponse).toHaveBeenCalledTimes(callsBeforeResume.decision);

    expect(result.response.structuredOutput).toEqual({
      decision: 'complete',
      reasoning: 'all covered',
      fixCoverage: expect.any(Array),
    });
    result.commitTransition?.({ kind: 'next_step', nextStep: 'COMPLETE' });
    expect(completeRuleMatched).toBe(true);
    expect(result.response.content).not.toContain('FIRST_RAW');
    expect(result.response.content).not.toContain('SECOND_RAW');
    expect(leaderContext).toEqual({ mode: 'omit' });
    const decompositionOptions = structuredCaller.requestDecompositionRawResponse.mock.calls[0]?.[2];
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).toContain('F-0002');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0001');
    expect(decompositionOptions?.findingContract.actionableFindings).not.toContain('R-0002');
    const firstWorkerInstruction = mockExecuteAgent.mock.calls[0]?.[1] as string;
    const secondWorkerInstruction = mockExecuteAgent.mock.calls[1]?.[1] as string;
    const correctionInstruction = mockExecuteAgent.mock.calls[2]?.[1] as string;
    expect(firstWorkerInstruction).toContain('## Finding Contract Part Assignment');
    expect(firstWorkerInstruction).toContain('src/first.ts');
    expect(firstWorkerInstruction).not.toContain('src/second.ts');
    expect(firstWorkerInstruction).toContain('F-0001');
    expect(firstWorkerInstruction).toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('F-0002');
    expect(firstWorkerInstruction).not.toContain('R-0002');
    expect(secondWorkerInstruction).toContain('src/second.ts');
    expect(correctionInstruction).toContain('完了済み worker part の申告訂正専用フェーズ');
    expect(correctionInstruction).toContain('evidence.disputed_file_line');
    expect(mockExecuteAgent.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      sessionId: 'worker-session-1',
      permissionMode: 'readonly',
      allowedTools: [],
    }));
    expect(secondWorkerInstruction).toContain('F-0002');
    expect(secondWorkerInstruction).toContain('R-0002');
    expect(secondWorkerInstruction).not.toContain('F-0001');
    expect(secondWorkerInstruction).not.toContain('R-0001');
    expect(firstWorkerInstruction).not.toContain('.takt/finding-ledger.json');
    expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
    expect(state.stepIterations.get('fix.repair-first')).toBe(1);
    expect(state.stepIterations.get('fix.repair-second')).toBe(1);
    expect(state.stepIterations.get('fix.verify-first')).toBe(1);
    expect(structuredCaller.requestMorePartsRawResponse).toHaveBeenCalledTimes(4);
    const firstFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[0]?.[3];
    const secondFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[1]?.[3];
    const thirdFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[2]?.[3];
    const fourthFeedbackOptions = structuredCaller.requestMorePartsRawResponse.mock.calls[3]?.[3];
    const firstFeedbackResults = structuredCaller.requestMorePartsRawResponse.mock.calls[0]?.[1];
    expect(firstFeedbackResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'repair-first',
        findingContractClaim: expect.objectContaining({
          changedPaths: ['src/first.ts'],
          omittedChangedPathCount: 0,
        }),
      }),
      expect.objectContaining({
        id: 'repair-second',
        findingContractClaim: expect.objectContaining({
          changedPaths: ['src/second.ts'],
          omittedChangedPathCount: 0,
        }),
      }),
    ]));
    expect(firstFeedbackOptions?.findingContract.completedPartIndex).toEqual([]);
    expect(firstFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 1,
      mode: 'normal',
    }));
    expect(secondFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 2,
      mode: 'normal',
      latestRejection: expect.objectContaining({
        attempt: 1,
        issueFingerprint: expect.any(String),
      }),
    }));
    expect(thirdFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 3,
      mode: 'strict',
      strictReason: 'evidence_or_reference_issue',
    }));
    expect(fourthFeedbackOptions?.findingContract.recovery).toEqual(expect.objectContaining({
      attempt: 1,
      mode: 'normal',
    }));
    const attemptDirectory = readdirSync(join(runPaths.contextAbs, 'team_leader', 'fix'))
      .find((entry) => (
        entry.startsWith('attempt-')
        && existsSync(join(
          runPaths.contextAbs,
          'team_leader',
          'fix',
          entry,
          'finding-contract-recovery.jsonl',
        ))
      ));
    if (attemptDirectory === undefined) throw new Error('Missing Team Leader attempt directory');
    const auditRecords = readFileSync(
      join(runPaths.contextAbs, 'team_leader', 'fix', attemptDirectory, 'finding-contract-recovery.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line) as {
      type: string;
      attempt: number;
      mode: string;
      boundaryId: string;
      attemptToken: string;
      rawOutputDigest?: { hash: string };
      normalizedOutputDigest?: { hash: string };
    });
    expect(auditRecords.map((record) => [record.type, record.attempt, record.mode])).toEqual([
      ['started', 1, 'normal'],
      ['accepted', 1, 'normal'],
      ['rejected', 0, 'strict'],
      ['started', 1, 'strict'],
      ['accepted', 1, 'strict'],
      ['started', 1, 'normal'],
      ['rejected', 1, 'normal'],
      ['started', 2, 'normal'],
      ['rejected', 2, 'strict'],
      ['started', 3, 'strict'],
      ['accepted', 3, 'strict'],
      ['started', 1, 'normal'],
      ['accepted', 1, 'normal'],
    ]);
    expect(new Set(auditRecords.map((record) => record.boundaryId))).toEqual(new Set([
      'decomposition',
      'part:repair-first:completion',
      'feedback:1',
      'feedback:2',
    ]));
    expect(auditRecords.every((record) => record.attemptToken.length > 0)).toBe(true);
    expect(auditRecords.filter((record) => record.type === 'accepted')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawOutputDigest: expect.objectContaining({ hash: expect.any(String) }),
          normalizedOutputDigest: expect.objectContaining({ hash: expect.any(String) }),
        }),
      ]),
    );
    const [operation] = operationStore.listParents();
    if (operation === undefined) throw new Error('Missing Team Leader operation');
    expect(operation.stage).toBe('completed');
    expect(operation.owner).toEqual({ generation: 1, claimToken: 'claim-b' });
    expect(new Set(operation.children.map((child) => child.id))).toEqual(new Set([
      'decomposition',
      'part:repair-first:completion',
      'part:repair-second:completion',
      'part:verify-first:completion',
      'feedback:1',
      'feedback:2',
    ]));
    expect(operation.children.every((child) => child.stage === 'completed')).toBe(true);
    expect(
      operation.children.find((child) => child.id === 'part:repair-first:completion')?.attempts,
    ).toHaveLength(3);
  }, 120_000);

  it('redispatches a rate-limited part with the fallback provider instead of replaying it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-finding-contract-rate-limit-'));
    temporaryDirectories.push(cwd);
    const runPaths = buildRunPaths(cwd, 'run-rate-limit');
    mkdirSync(runPaths.contextAbs, { recursive: true });
    const operationStore = createOperationJournalStore(runPaths.operationJournalAbs);
    const fullLedger = makeLedger();
    const ledger: FindingLedger = {
      ...fullLedger,
      findings: fullLedger.findings.filter((finding) => finding.id === 'F-0002'),
      rawFindings: fullLedger.rawFindings.filter(
        (finding) => finding.rawFindingId === 'R-0002',
      ),
    };
    const ledgerStore = {
      loadLedger: vi.fn(() => ledger),
      saveLedgerSnapshot: vi.fn(),
    } as unknown as FindingLedgerStore;
    const findingContract: FindingContractConfig = {
      manager: {
        persona: 'findings-manager',
        instruction: 'manage',
        outputContract: 'contract',
      },
    };
    const part = {
      id: 'repair',
      title: 'Repair',
      instruction: 'repair finding',
      findingContract: {
        findingIds: ['F-0002'],
        role: 'repair' as const,
        readPaths: [],
      },
    };
    mockExecuteAgent
      .mockImplementationOnce(async (_persona, _instruction, options) => {
        options.onDispatch?.('edit');
        return {
          persona: 'coder',
          status: 'rate_limited',
          content: 'rate limited',
          timestamp: new Date(),
        };
      })
      .mockImplementationOnce(async (_persona, _instruction, options) => {
        options.onDispatch?.('edit');
        return {
          persona: 'coder',
          status: 'done',
          content: 'fixed',
          structuredOutput: {
            findingOutcomes: [{
              findingId: 'F-0002',
              outcome: 'addressed',
              evidence: ['src/second.ts:20'],
            }],
            changedPaths: ['src/second.ts'],
            checks: [{ command: 'npm test', status: 'passed' }],
            summary: 'fixed with fallback provider',
          },
          timestamp: new Date(),
        };
      });
    const rawResponse = (structuredOutput: Record<string, unknown>): AgentResponse => ({
      persona: 'leader',
      status: 'done',
      content: JSON.stringify(structuredOutput),
      structuredOutput,
      timestamp: new Date(),
    });
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn(),
      requestDecompositionRawResponse: vi.fn(async (_instruction, _max, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'system',
          userInstruction: 'leader instruction',
        });
        return rawResponse({ parts: [part] });
      }),
      requestMoreParts: vi.fn(),
      requestMorePartsRawResponse: vi.fn(async () => rawResponse({
        decision: 'complete',
        reasoning: 'fixed',
        parts: [],
        blockers: [],
        fixCoverage: [{
          findingId: 'F-0002',
          disposition: 'addressed',
          supportingPartIds: ['repair'],
          verificationPartIds: ['repair'],
        }],
      })),
    };
    const stepExecutor = {
      buildInstruction: vi.fn((currentStep: WorkflowStep) => (
        currentStep.name.includes('.') ? currentStep.instruction : 'leader instruction'
      )),
      buildPhase1Instruction: vi.fn((instruction: string) => instruction),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step, response: AgentResponse) => ({
        response,
        invalidDetail: undefined,
      })),
      applyPostExecutionPhases: vi.fn(async (
        _step,
        _state,
        _iteration,
        response: AgentResponse,
      ) => response),
      persistPreviousResponseSnapshot: vi.fn(),
      emitStepReports: vi.fn(),
    };
    const resolveProvider = (runtime?: RuntimeStepResolution) => (
      runtime?.providerInfo ?? {
        provider: 'codex' as const,
        model: 'gpt-5',
        providerSource: 'step' as const,
        modelSource: 'step' as const,
      }
    );
    const optionsBuilder = {
      buildAgentOptions: vi.fn((_step, runtime?: RuntimeStepResolution) => ({
        cwd,
        resolvedProvider: resolveProvider(runtime).provider,
        resolvedModel: resolveProvider(runtime).model,
      })),
      buildBaseOptions: vi.fn().mockReturnValue({}),
      buildResumeOptions: vi.fn(),
      buildNewSessionReportOptions: vi.fn(),
      buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
      resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
      resolveStepProviderModel: vi.fn((_step, runtime?: RuntimeStepResolution) => (
        resolveProvider(runtime)
      )),
    };
    const runner = new TeamLeaderRunner({
      optionsBuilder,
      stepExecutor,
      engineOptions: { projectCwd: cwd, structuredCaller, language: 'ja' },
      getCwd: () => cwd,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => runPaths,
      getCurrentWorkflowStack: () => [{
        workflow: 'workflow',
        workflow_ref: 'project:sha256:workflow',
        step: 'fix',
        kind: 'agent',
        occurrence: 1,
      }],
      findingContract,
      findingLedgerStore: ledgerStore,
      operationJournal: {
        store: operationStore,
        journalRunSlug: runPaths.slug,
        claimToken: 'claim-a',
      },
      observabilityEnabled: false,
      emitEvent: vi.fn(),
    } as unknown as ConstructorParameters<typeof TeamLeaderRunner>[0]);
    const step: WorkflowStep = {
      name: 'fix',
      persona: 'coder',
      personaDisplayName: 'coder',
      instruction: 'fix findings',
      edit: true,
      teamLeader: {
        mode: 'finding_contract_fix',
        maxConcurrency: 1,
        timeoutMs: 1000,
        partPersona: 'coder',
        partEdit: true,
      },
    };
    const state = makeState();
    state.stepIterations.set('fix', 1);

    const rateLimited = await runner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      undefined,
      1,
    );
    expect(rateLimited.response.status).toBe('rate_limited');
    const [rateLimitedOperation] = operationStore.listParents();
    if (rateLimitedOperation === undefined) {
      throw new Error('Missing rate-limited Team Leader operation');
    }
    expect(operationStore.getChild(
      rateLimitedOperation.id,
      'part:repair:completion',
    ).stage).toBe('running');
    state.stepIterations.set('fix', 1);

    const fallbackRuntime: RuntimeStepResolution = {
      providerInfo: {
        provider: 'claude-sdk',
        model: 'claude-sonnet',
        providerSource: 'step',
        modelSource: 'step',
      },
      fallback: {
        reason: 'rate_limited',
        reasonDetail: 'rate limited',
        originalIteration: 1,
        previousProvider: 'codex',
        previousModel: 'gpt-5',
        currentProvider: 'claude-sdk',
        currentModel: 'claude-sonnet',
        stepName: 'fix',
        reportDir: runPaths.reportsAbs,
      },
    };
    const completed = await runner.runTeamLeaderStep(
      step,
      state,
      'task',
      20,
      vi.fn(),
      fallbackRuntime,
      1,
    );

    expect(completed.response.status).toBe('done');
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(optionsBuilder.buildAgentOptions.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        providerInfo: expect.objectContaining({ provider: 'claude-sdk' }),
      }),
    );
    expect(structuredCaller.requestDecompositionRawResponse).toHaveBeenCalledTimes(1);
    const [operation] = operationStore.listParents();
    expect(
      operation?.children.find((child) => child.id === 'part:repair:completion')?.stage,
    ).toBe('completed');
  }, 120_000);
});

function invalidDecomposition(message: string): TeamLeaderDecompositionValidationError {
  return new TeamLeaderDecompositionValidationError(
    'decomposition.parts_invalid',
    '$.parts',
    new Error(message),
  );
}

describe('Team Leader decomposition regeneration', () => {
  it('regenerates after semantic validation failure and passes bounded diagnostics', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(invalidDecomposition('x'.repeat(3_000)))
      .mockResolvedValueOnce('valid');

    await expect(requestValidTeamLeaderDecomposition({ request })).resolves.toBe('valid');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, undefined);
    expect(request).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      maxAttempts: 3,
      diagnostic: {
        code: 'decomposition.parts_invalid',
        path: '$.parts',
        message: `${'x'.repeat(1_999)}…`,
      },
    });
  });

  it('stops after three consecutive semantic validation failures', async () => {
    const error = invalidDecomposition('still invalid');
    const request = vi.fn().mockRejectedValue(error);

    await expect(requestValidTeamLeaderDecomposition({ request })).rejects.toBe(error);

    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry provider or engine failures', async () => {
    const error = new Error('provider unavailable');
    const request = vi.fn().mockRejectedValue(error);

    await expect(requestValidTeamLeaderDecomposition({ request })).rejects.toBe(error);

    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects immediately when an in-flight request ignores cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const result = requestValidTeamLeaderDecomposition({
      abortSignal: controller.signal,
      request,
    });

    controller.abort(new Error('cancelled while waiting'));

    await expect(result).rejects.toThrow('cancelled while waiting');
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not invoke the request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const request = vi.fn();

    await expect(requestValidTeamLeaderDecomposition({
      abortSignal: controller.signal,
      request,
    })).rejects.toThrow('cancelled before start');

    expect(request).not.toHaveBeenCalled();
  });
});
