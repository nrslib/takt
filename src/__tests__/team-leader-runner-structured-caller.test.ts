import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStepResolution } from '../core/workflow/types.js';
import {
  createWorkflowStepAbortSignalContext,
  type WorkflowStepInactivityDeadline,
  type WorkflowStepExecutionDeadlineContext,
} from '../core/workflow/engine/step-deadline.js';
import {
  requestValidTeamLeaderDecomposition,
  TeamLeaderDecompositionValidationError,
} from '../agents/team-leader-decomposition-regeneration.js';
import { requestMoreParts } from '../agents/decompose-task-usecase.js';
import { appendCompanionMailboxFindings } from '../core/workflow/companion/mailbox.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import {
  buildPartScopedSessionKey,
  runTeamLeaderPart,
} from '../core/workflow/engine/team-leader-part-runner.js';
import type { AgentResponse, WorkflowStep, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import {
  AGENT_FAILURE_CATEGORIES,
  MAX_AGENT_FAILURE_MESSAGE_BYTES,
} from '../shared/types/agent-failure.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { TeamLeaderPartCancellation } from '../core/workflow/engine/team-leader-part-cancellation.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  buildTeamLeaderPartReportPath,
  TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS,
} from '../core/workflow/engine/team-leader-part-report.js';

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

const defaultTeamLeaderRunDirectory = mkdtempSync(join(tmpdir(), 'takt-team-leader-runner-'));
const defaultTeamLeaderRunPaths = buildRunPaths(defaultTeamLeaderRunDirectory, 'run');
const trackedTeamLeaderTestDirectories = new Set<string>();

function createTrackedTeamLeaderTestDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  trackedTeamLeaderTestDirectories.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of trackedTeamLeaderTestDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  trackedTeamLeaderTestDirectories.clear();
  rmSync(defaultTeamLeaderRunPaths.reportsAbs, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(defaultTeamLeaderRunDirectory, { recursive: true, force: true });
});

describe('TeamLeaderRunner with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWithPhaseSpan.mockImplementation(async (_params, execute) => execute());
  });

  it('should delegate decomposition and route provider tool activity through the leader deadline', async () => {
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

    let feedbackAbortSignal: AbortSignal | undefined;
    const structuredCaller = {
      judgeStatus: vi.fn(),
      evaluateCondition: vi.fn(),
      decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
        options.onPromptResolved?.({
          systemPrompt: 'team-leader-system',
          userInstruction: 'leader instruction',
        });
        options.onStream?.({
          type: 'tool_use',
          data: { tool: 'Read', input: {}, id: 'leader-tool-1' },
        });
        options.onStream?.({
          type: 'tool_result',
          data: { id: 'leader-tool-1', content: 'done', isError: false },
        });
        return { parts: [
          { id: 'part-1', title: 'API', instruction: 'Implement API' },
        ] };
      }),
      requestMoreParts: vi.fn().mockImplementation(async (
        _instruction,
        _results,
        _existingIds,
        options: { abortSignal: AbortSignal },
      ) => {
        feedbackAbortSignal = options.abortSignal;
        return {
          done: true,
          reasoning: 'enough',
          cancelPartIds: [],
          parts: [],
        };
      }),
    };
    const leaderAbortController = new AbortController();
    const leaderOnStream = vi.fn();
    const leaderOnActivity = vi.fn();
    const deadlineContext = createWorkflowStepAbortSignalContext(undefined);
    const leaderDeadline: WorkflowStepInactivityDeadline = {
      signal: leaderAbortController.signal,
      recordActivity: vi.fn(),
      dispose: vi.fn(),
      inactivityTimeoutMs: 60_000,
    };
    const executionDeadlineContext: WorkflowStepExecutionDeadlineContext = {
      begin: vi.fn((executionUnitKey) => executionUnitKey === 'team-leader:leader'
        ? leaderDeadline
        : {
            signal: new AbortController().signal,
            recordActivity: vi.fn(),
            dispose: vi.fn(),
            inactivityTimeoutMs: 60_000,
          }),
      runWith: vi.fn((deadline, operation) => deadlineContext.runWith(deadline, operation)),
    };
    const providerStreamBuilder = new OptionsBuilder(
      { projectCwd: '/tmp/project', provider: 'opencode' },
      () => '/tmp/project',
      () => '/tmp/project',
      () => undefined,
      () => '/tmp/project/.takt/runs/sample/reports',
      () => 'ja',
      () => [{ name: 'implement' }],
      () => 'workflow',
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deadlineContext.getAbortSignal,
      deadlineContext.recordActivity,
    );
    let leaderProviderStream: ReturnType<OptionsBuilder['buildProviderStream']> = undefined;
    const buildInstruction = vi.fn(buildLeaderOrMemberInstruction);

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({
          cwd: '/tmp/project',
          failureDir: '/tmp/project/.takt/runs/sample/failures',
        }),
        buildBaseOptions: vi.fn().mockImplementation((leaderStep: WorkflowStep) => {
          leaderProviderStream = providerStreamBuilder.buildProviderStream(
            leaderStep,
            'opencode',
            'opencode/zai-coding-plan/glm-5.1',
            leaderOnStream,
          );
          return {
            failureDir: '/tmp/project/.takt/runs/sample/failures',
            onStream: leaderProviderStream,
            onActivity: leaderOnActivity,
          };
        }),
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
        inspectTools: ['read', 'glob'],
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
      undefined,
      undefined,
      executionDeadlineContext,
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
        failureDir: '/tmp/project/.takt/runs/sample/failures',
        inspectTools: ['read', 'glob'],
        abortSignal: leaderAbortController.signal,
        onStream: leaderProviderStream,
        onActivity: leaderOnActivity,
      }),
    );
    expect(structuredCaller.requestMoreParts).toHaveBeenCalledWith(
      'leader instruction',
      [
        {
          id: 'part-1',
          title: 'API',
          status: 'done',
          content: expect.stringContaining('[full report:'),
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
        failureDir: '/tmp/project/.takt/runs/sample/failures',
        onStream: leaderProviderStream,
        onActivity: leaderOnActivity,
      }),
    );
    expect(leaderDeadline.recordActivity).toHaveBeenNthCalledWith(1, {
      kind: 'tool_started',
      executionUnitKey: 'implement',
      toolCallKey: JSON.stringify(['implement', 'leader-tool-1']),
    });
    expect(leaderDeadline.recordActivity).toHaveBeenNthCalledWith(2, {
      kind: 'tool_finished',
      executionUnitKey: 'implement',
      toolCallKey: JSON.stringify(['implement', 'leader-tool-1']),
    });
    expect(feedbackAbortSignal).toBeDefined();
    leaderAbortController.abort(new Error('leader deadline reached'));
    expect(feedbackAbortSignal?.aborted).toBe(true);
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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

  it('re-enters feedback after a terminal response when completion review accepts a finding', async () => {
    const mailboxRoot = mkdtempSync(join(tmpdir(), 'takt-team-leader-mailbox-'));
    const mailboxPath = join(mailboxRoot, 'security-reviewer.jsonl');
    const findingSentinel = 'MAILBOX_SENTINEL_FINDING';
    const finding = {
      severity: 'must_fix' as const,
      file: 'src/value.ts',
      line: 1,
      finding: findingSentinel,
    };
    const events: string[] = [];
    const feedbackPrompts: string[] = [];
    const feedbackRequests: Array<{
      instruction: string;
      inspectTools: string[] | undefined;
    }> = [];
    const mailboxPulls: string[] = [];
    const feedbackAgentCalls: Array<{
      prompt: string;
      allowedTools: string[] | undefined;
    }> = [];
    let feedbackCallCount = 0;
    const structuredResponse = (structuredOutput: Record<string, unknown>): AgentResponse => ({
      persona: 'coder',
      status: 'done',
      content: '',
      timestamp: new Date(),
      structuredOutput,
    });

    try {
      mockExecuteAgent.mockImplementation(async (
        _persona: string | undefined,
        prompt: string,
        options: { allowedTools?: string[]; outputSchema?: Record<string, unknown> } = {},
      ): Promise<AgentResponse> => {
        if (options.outputSchema === undefined) {
          return {
            persona: 'coder',
            status: 'done',
            content: 'part completed',
            timestamp: new Date(),
          };
        }

        feedbackCallCount += 1;
        feedbackPrompts.push(prompt);
        feedbackAgentCalls.push({ prompt, allowedTools: options.allowedTools });
        if (feedbackCallCount === 1) {
          return structuredResponse({
            done: true,
            reasoning: 'initially complete',
            cancelPartIds: [],
            parts: [],
          });
        }
        if (feedbackCallCount === 2) {
          const mailbox = readFileSync(mailboxPath, 'utf8');
          mailboxPulls.push(mailbox);
          events.push('mailbox-read');
          events.push('correction-response');
          return structuredResponse({
            done: false,
            reasoning: 'apply the mailbox finding',
            cancelPartIds: [],
            parts: [{ id: 'part-2', title: 'Correction', instruction: 'Fix the finding' }],
          });
        }
        return structuredResponse({
          done: true,
          reasoning: 'complete after correction',
          cancelPartIds: [],
          parts: [],
        });
      });

      const companionRuntime = {
        beginReviewAttempt: vi.fn(),
        beginFollowUpRound: vi.fn(),
        composeOptions: vi.fn((options: Record<string, unknown>) => options),
        complete: vi.fn()
          .mockImplementationOnce(async () => {
            appendCompanionMailboxFindings({
              path: mailboxPath,
              companionName: 'reviewer',
              reviewedAt: '2026-08-17T00:00:00.000Z',
              reviewedDigest: 'digest-1',
              findings: [finding],
            });
            events.push('mailbox-append');
            return { findings: [finding] };
          })
          .mockResolvedValueOnce({ findings: [] }),
        [Symbol.dispose]: vi.fn(),
      };
      const observedRequestMoreParts = async (...args: Parameters<typeof requestMoreParts>) => {
        const [instruction, _results, _existingIds, options] = args;
        feedbackRequests.push({ instruction, inspectTools: options.inspectTools });
        return requestMoreParts(...args);
      };
      const structuredCaller = {
        decomposeTask: vi.fn().mockImplementation(async (
          _instruction: string,
          _maxInitialParts: number | undefined,
          options: { onPromptResolved?: (parts: { systemPrompt: string; userInstruction: string }) => void },
        ) => {
          options.onPromptResolved?.({ systemPrompt: 'leader', userInstruction: 'leader instruction' });
          return { parts: [{ id: 'part-1', title: 'Implementation', instruction: 'Implement the change' }] };
        }),
        requestMoreParts: vi.fn(observedRequestMoreParts),
      };
      const applyPostExecutionPhases = vi.fn(async (
        _step: WorkflowStep,
        _state: WorkflowState,
        _iteration: number,
        response: AgentResponse,
      ) => response);
      const runner = new TeamLeaderRunner({
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/tmp/project' }),
          buildBaseOptions: vi.fn().mockReturnValue({}),
          buildPhase1WorkflowMeta: vi.fn().mockReturnValue(undefined),
          resolveMcpServersForStep: vi.fn().mockReturnValue(undefined),
          resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'mock-model' }),
        },
        stepExecutor: {
          buildInstruction: vi.fn((candidate: WorkflowStep) => new InstructionBuilder(
            candidate,
            makeInstructionContext({
              task: 'implement feature',
              companion: { mailboxDirectory: mailboxPath },
            }),
          ).build()),
          createCompanionRuntime: vi.fn().mockResolvedValue(companionRuntime),
          applyPostExecutionPhases,
          persistPreviousResponseSnapshot: vi.fn(),
          emitStepReports: vi.fn(),
        },
        engineOptions: { projectCwd: '/tmp/project', structuredCaller },
        getCwd: () => '/tmp/project',
        getWorkflowName: () => 'workflow',
        getInteractive: () => false,
        getRunPaths: () => defaultTeamLeaderRunPaths,
        observabilityEnabled: false,
      } as ConstructorParameters<typeof TeamLeaderRunner>[0]);
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
      const step: WorkflowStep = {
        name: 'implement',
        persona: 'coder',
        personaDisplayName: 'coder',
        instruction: 'leader instruction',
        passPreviousResponse: false,
        teamLeader: {
          maxConcurrency: 1,
          timeoutMs: 1_000,
          inspectTools: ['read', 'glob', 'grep'],
        },
        companion: { fixed: ['reviewer'], pool: [] },
      };

      await runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn());

      expect(feedbackCallCount).toBe(3);
      expect(feedbackRequests).toHaveLength(3);
      for (const { instruction, inspectTools } of feedbackRequests) {
        expect(inspectTools).toEqual(['Read', 'Glob', 'Grep']);
        expect(instruction).toContain(mailboxPath);
        expect(instruction).not.toContain(findingSentinel);
      }
      expect(feedbackPrompts).toHaveLength(3);
      expect(feedbackPrompts.every((prompt) => !prompt.includes(findingSentinel))).toBe(true);
      expect(feedbackAgentCalls).toHaveLength(3);
      for (const { prompt, allowedTools } of feedbackAgentCalls) {
        expect(allowedTools).toEqual(['Read', 'Glob', 'Grep']);
        expect(prompt).not.toContain(findingSentinel);
      }
      expect(feedbackAgentCalls[1]?.prompt).toContain(mailboxPath);
      expect(mailboxPulls).toHaveLength(1);
      expect(mailboxPulls[0]).toContain(findingSentinel);
      expect(events).toEqual(['mailbox-append', 'mailbox-read', 'correction-response']);
      expect(companionRuntime.complete).toHaveBeenCalledTimes(2);
      expect(companionRuntime.beginReviewAttempt).toHaveBeenCalledOnce();
      expect(applyPostExecutionPhases).toHaveBeenCalledOnce();
      expect(mockExecuteAgent).toHaveBeenCalledTimes(5);
    } finally {
      rmSync(mailboxRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { failOnPartError: true, expectedStatus: 'error', postExecutionCalls: 0 },
    { failOnPartError: false, expectedStatus: 'done', postExecutionCalls: 1 },
  ])('handles a failed member followed by a successful recovery part when failOnPartError=$failOnPartError', async ({
    failOnPartError,
    expectedStatus,
    postExecutionCalls,
  }) => {
    const failedDetail = `member failed ${'e'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS + 1000)}`;
    mockExecuteAgent.mockImplementation(async (_persona, instruction: string) => ({
      persona: 'coder',
      status: instruction.includes('part-1') ? 'error' : 'done',
      content: instruction.includes('part-1') ? '' : 'recovery complete',
      error: instruction.includes('part-1') ? failedDetail : undefined,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      expect(result.response.error).toBe(failedDetail);
      expect(result.response.content).toBe(`Team leader part failed: part-1: ${failedDetail}`);
    } else {
      expect(result.response.content).toContain('recovery complete');
    }
    const feedbackResults = structuredCaller.requestMoreParts.mock.calls[0]?.[1] as Array<{
      id: string;
      content: string;
    }>;
    const failedFeedback = feedbackResults.find((feedback) => feedback.id === 'part-1');
    expect(failedFeedback).toBeDefined();
    expect(failedFeedback?.content).not.toContain(failedDetail);
    expect(failedFeedback?.content).toContain('[ERROR]');
    const failedReportPath = buildTeamLeaderPartReportPath({
      runPaths: defaultTeamLeaderRunPaths,
      stepName: 'implement',
      partId: 'part-1',
    });
    expect(readFileSync(failedReportPath.absolutePath, 'utf-8')).toContain(failedDetail);
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
    expect(result.response.content).toContain('"id": "part-1"');
    expect(result.response.content).toContain('"id": "part-2"');
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-inspect-tools-');
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
      getRunPaths: () => buildRunPaths(projectDir, 'run'),
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
    expect(requestOptions).toEqual(expect.objectContaining({
      inspectTools: ['Read', 'Glob', 'Grep'],
    }));
    const [, , partOptions] = mockExecuteAgent.mock.calls[0] ?? [];
    expect(partOptions).toEqual(expect.objectContaining({
      allowedTools: ['Read', 'Edit'],
    }));
  });

  it('Given teamLeader.inspectTools and OpenCode provider, When running a team leader step, Then parent planning keeps OpenCode tool names', async () => {
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-inspect-tools-opencode-');
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
      getRunPaths: () => buildRunPaths(projectDir, 'run'),
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
    expect(requestOptions).toEqual(expect.objectContaining({
      inspectTools: ['read', 'glob', 'grep'],
    }));
    expect(partOptions).toEqual(expect.objectContaining({
      allowedTools: ['read', 'edit'],
    }));
  });

  it('Given teamLeader.inspectTools without partAllowedTools, When running child parts, Then child options do not inherit inspect tools', async () => {
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-inspect-tools-no-part-');
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
      getRunPaths: () => buildRunPaths(projectDir, 'run'),
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
    expect(requestOptions).toEqual(expect.objectContaining({
      inspectTools: ['Read', 'Glob', 'Grep'],
    }));
    expect(partOptions.allowedTools).toBeUndefined();
  });

  it('Given teamLeader.inspectTools and a large part result, When building feedback, Then content is bounded and the report path is included', async () => {
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-feedback-project-');
    const worktreeDir = createTrackedTeamLeaderTestDirectory('takt-leader-feedback-worktree-');
    {
      const fullContent = 'x'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS + 5000);
      mockExecuteAgent.mockResolvedValue({
        persona: 'coder',
        status: 'done',
        content: fullContent,
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
          cancelPartIds: [],
          parts: [],
        }),
      };

      const runner = new TeamLeaderRunner({
        optionsBuilder: {
          buildAgentOptions: vi.fn().mockReturnValue({ cwd: worktreeDir }),
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
          projectCwd: projectDir,
          structuredCaller,
          language: 'ja',
        },
        getCwd: () => worktreeDir,
        getWorkflowName: () => 'workflow',
        getInteractive: () => false,
        getRunPaths: () => buildRunPaths(worktreeDir, 'run'),
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
          maxConcurrency: 1,
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

      await runner.runTeamLeaderStep(step, state, 'implement feature', 5, vi.fn());

      const [, feedbackResults, , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
      expect(requestOptions).toEqual(expect.objectContaining({
        persona: 'team-leader',
        provider: 'opencode',
      }));
      const feedbackEntry = (feedbackResults as Array<{ id: string; content: string }>)[0];
      expect(feedbackEntry.id).toBe('part-1');
      expect(feedbackEntry.content.length).toBeLessThan(fullContent.length);
      expect(feedbackEntry.content).toContain('[truncated:');
      expect(feedbackEntry.content).not.toContain(fullContent);
      const reportPath = buildTeamLeaderPartReportPath({
        runPaths: buildRunPaths(worktreeDir, 'run'),
        stepName: 'implement',
        partId: 'part-1',
      });
      expect(feedbackEntry.content).toContain(`[full report: ${reportPath.absolutePath}]`);
      const writtenContent = readFileSync(reportPath.absolutePath, 'utf-8');
      expect(writtenContent).toContain('## content');
      expect(writtenContent).toContain(fullContent);
    }
  });

  it('Given no teamLeader.inspectTools, When building feedback, Then content is still bounded and the report path is included', async () => {
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-feedback-without-inspect-tools-');
    const fullContent = 'x'.repeat(TEAM_LEADER_FEEDBACK_SUMMARY_MAX_CHARS + 1000);
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: fullContent,
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
        cancelPartIds: [],
        parts: [],
      }),
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: projectDir }),
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
        projectCwd: projectDir,
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => projectDir,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => buildRunPaths(projectDir, 'run'),
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
        maxConcurrency: 1,
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions).toEqual(expect.objectContaining({
      inspectTools: ['read', 'glob', 'grep'],
      inspectGuidance: true,
    }));
    expect(requestOptions).toEqual(expect.objectContaining({
      inspectTools: ['read', 'glob', 'grep'],
      inspectGuidance: true,
    }));
    const [, feedbackResults] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    const feedbackEntry = (feedbackResults as Array<{ id: string; content: string }>)[0];
    expect(feedbackEntry.content).not.toContain(fullContent);
    expect(feedbackEntry.content).toContain('[truncated:');
    const reportPath = buildTeamLeaderPartReportPath({
      runPaths: buildRunPaths(projectDir, 'run'),
      stepName: 'implement',
      partId: 'part-1',
    });
    expect(feedbackEntry.content).toContain(`[full report: ${reportPath.absolutePath}]`);
    expect(readFileSync(reportPath.absolutePath, 'utf-8')).toContain(fullContent);
  });

  it('Given no teamLeader.inspectTools and a Codex leader, When running, Then inspectTools stays undefined but inspectGuidance is true', async () => {
    const projectDir = createTrackedTeamLeaderTestDirectory('takt-leader-default-codex-');
    mockExecuteAgent.mockResolvedValue({
      persona: 'coder',
      status: 'done',
      content: 'API done',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
    const resolveStepProviderModel = vi.fn().mockReturnValue({
      provider: 'codex',
      model: 'gpt-5.5',
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
        cancelPartIds: [],
        parts: [],
      }),
    };

    const runner = new TeamLeaderRunner({
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue({ cwd: projectDir }),
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
        projectCwd: projectDir,
        structuredCaller,
        language: 'ja',
      },
      getCwd: () => projectDir,
      getWorkflowName: () => 'workflow',
      getInteractive: () => false,
      getRunPaths: () => buildRunPaths(projectDir, 'run'),
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
        maxConcurrency: 1,
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

    const [, , decomposeOptions] = structuredCaller.decomposeTask.mock.calls[0] ?? [];
    const [, , , requestOptions] = structuredCaller.requestMoreParts.mock.calls[0] ?? [];
    expect(decomposeOptions).toEqual(expect.objectContaining({
      inspectTools: undefined,
      inspectGuidance: true,
    }));
    expect(requestOptions).toEqual(expect.objectContaining({
      inspectTools: undefined,
      inspectGuidance: true,
    }));
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
      getRunPaths: () => defaultTeamLeaderRunPaths,
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
        getRunPaths: () => defaultTeamLeaderRunPaths,
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
    function buildStep(maxConcurrency: number, failOnPartError = false): WorkflowStep {
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
          failOnPartError,
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
    }, applyPostExecutionPhases = vi.fn(async (
      _step: WorkflowStep,
      _state: WorkflowState,
      _iteration: number,
      response: AgentResponse,
    ) => response)): TeamLeaderRunner {
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
          applyPostExecutionPhases,
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
        getRunPaths: () => defaultTeamLeaderRunPaths,
        observabilityEnabled: false,
      } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
        engineOptions: { projectCwd: string; language: 'en'; structuredCaller: typeof structuredCaller };
      });
    }

    it.each([false, true])(
      'Given a member provider stream parse error and failOnPartError=%s, When running team leader step, Then the parent fails before feedback or aggregation',
      async (failOnPartError) => {
        mockExecuteAgent
          .mockResolvedValueOnce({
            persona: 'coder',
            status: 'error',
            content: '',
            error: 'provider stream parse error: Failed to parse item: invalid stdout line',
            failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
            timestamp: new Date('2026-04-01T00:00:00.000Z'),
          })
          .mockResolvedValueOnce({
            persona: 'coder',
            status: 'done',
            content: 'Independent part completed',
            timestamp: new Date('2026-04-01T00:00:01.000Z'),
          });
        const requestMoreParts = vi.fn().mockResolvedValue({
          done: true,
          reasoning: 'unused',
          parts: [],
        });
        const applyPostExecutionPhases = vi.fn(async (
          _step: WorkflowStep,
          _state: WorkflowState,
          _iteration: number,
          response: AgentResponse,
        ) => response);
        const structuredCaller = {
          decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
            options.onPromptResolved?.({
              systemPrompt: 'team-leader-system',
              userInstruction: 'leader instruction',
            });
            return { parts: [
              { id: 'part-1', title: 'Parse failure', instruction: 'Implement parse failure area' },
              { id: 'part-2', title: 'Independent', instruction: 'Implement independent area' },
            ] };
          }),
          requestMoreParts,
        };

        await expect(
          buildRunner(structuredCaller, applyPostExecutionPhases).runTeamLeaderStep(
            buildStep(2, failOnPartError),
            buildState(),
            'implement feature',
            5,
            vi.fn(),
          ),
        ).rejects.toMatchObject({
          name: 'ProviderStreamParseError',
          failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
        });

        expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
        expect(requestMoreParts).not.toHaveBeenCalled();
        expect(applyPostExecutionPhases).not.toHaveBeenCalled();
      },
    );

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
      expect(result.response.error).toBe('part timeout: Part timeout after 1000ms');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(result.response.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PART_TIMEOUT);
      expect(result.response.content).toContain('part-1: part timeout: Part timeout after 1000ms');
      expect(result.response.content).toContain('timeout-continuation: part timeout: Part timeout after 1000ms');
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
      expect(result.response.content).toContain('Continuation 1 completed');
      expect(structuredCaller.requestMoreParts).toHaveBeenCalledTimes(2);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-1, part-2');
    });

    it('Given two timed-out parts and a failed combined continuation batch, When feedback fails, Then the step fails loud', async () => {
      const markers = [
        '[TRUNCATED: 12000 bytes, full text: /tmp/failure-dir/part-1.txt]',
        '[TRUNCATED: 13000 bytes, full text: /tmp/failure-dir/part-2.txt]',
        '[TRUNCATED: 14000 bytes, full text: /tmp/failure-dir/timeout-continuation.txt]',
      ];
      mockExecuteAgent.mockImplementation(async (_persona, executedInstruction: string) => ({
        persona: 'coder',
        status: 'error',
        content: '',
        error: executedInstruction.includes('Timed-out part:')
          ? `Continuation timeout after 1000ms ${'x'.repeat(3000)} ${markers[2]}`
          : executedInstruction.includes('Implement first area')
            ? `Part timeout after 1000ms ${'x'.repeat(3000)} ${markers[0]}`
            : `Part timeout after 1000ms ${'x'.repeat(3000)} ${markers[1]}`,
        failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
        timestamp: new Date(),
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
      expect(result.response.error).toContain('part timeout: Part timeout after 1000ms');
      expect(result.response.error).not.toContain('Team leader timeout continuation failed');
      expect(result.response.error).not.toContain('timeout-continuation:');
      expect(result.response.error).not.toContain('timeout-continuation-2');
      expect(result.response.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PART_TIMEOUT);
      expect(Buffer.byteLength(result.response.content, 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_FAILURE_MESSAGE_BYTES,
      );
      expect(Buffer.byteLength(result.response.error ?? '', 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_FAILURE_MESSAGE_BYTES,
      );
      for (const marker of markers.slice(1)) {
        expect(result.response.content).toContain(marker);
      }
      expect(result.response.error).toContain(markers[1]);
      expect(result.response.error).not.toContain(markers[2]);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
      const [, continuationInstruction] = mockExecuteAgent.mock.calls[2] ?? [];
      expect(continuationInstruction).toContain('Timed-out part: part-2');
    });

    it.each([
      AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
      AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
      AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
    ])('preserves the primary %s category and error when failOnPartError closes the boundary', async (failureCategory) => {
      mockExecuteAgent.mockResolvedValueOnce({
        persona: 'coder',
        status: 'error',
        content: '',
        error: 'Boundary-specific failure detail',
        failureCategory,
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
        requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'stop', parts: [] }),
      };

      const result = await buildRunner(structuredCaller).runTeamLeaderStep(
        buildStep(1, true),
        buildState(),
        'implement feature',
        5,
        vi.fn(),
      );

      expect(result.response.status).toBe('error');
      expect(result.response.failureCategory).toBe(failureCategory);
      expect(result.response.error).toContain('Boundary-specific failure detail');
      expect(result.response.content).toContain('All team leader parts failed');
    });

    it.each([false, true])(
      'keeps categorized Team Leader lineage when categorized and generic parts are reversed (reversed=%s)',
      async (reversed) => {
        mockExecuteAgent.mockImplementation(async (_persona, executedInstruction: string) => {
          if (executedInstruction.includes('categorized area')) {
            return {
              persona: 'coder',
              status: 'error',
              content: '',
              error: 'Categorized idle failure',
              failureCategory: AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
              timestamp: new Date('2026-04-01T00:00:00.000Z'),
            };
          }
          return {
            persona: 'coder',
            status: 'error',
            content: '',
            error: 'Generic part failure',
            timestamp: new Date('2026-04-01T00:00:01.000Z'),
          };
        });
        const categorizedPart = {
          id: 'categorized',
          title: 'Categorized',
          instruction: 'Implement categorized area',
        };
        const genericPart = {
          id: 'generic',
          title: 'Generic',
          instruction: 'Implement generic area',
        };
        const structuredCaller = {
          decomposeTask: vi.fn().mockImplementation(async (_instruction, _maxInitialParts, options) => {
            options.onPromptResolved?.({
              systemPrompt: 'team-leader-system',
              userInstruction: 'leader instruction',
            });
            return { parts: reversed
              ? [genericPart, categorizedPart]
              : [categorizedPart, genericPart] };
          }),
          requestMoreParts: vi.fn().mockResolvedValue({ done: true, reasoning: 'stop', parts: [] }),
        };

        const result = await buildRunner(structuredCaller).runTeamLeaderStep(
          buildStep(2, true),
          buildState(),
          'implement feature',
          5,
          vi.fn(),
        );

        expect(result.response).toMatchObject({
          status: 'error',
          error: 'stream idle timeout: Categorized idle failure',
          failureCategory: AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
        });
        expect(result.response.content).toContain('categorized: stream idle timeout: Categorized idle failure');
        expect(result.response.content).toContain('generic: Generic part failure');
        expect(result.providerInfo).toBeUndefined();
        expect(result.workflowCallFailure).toBeUndefined();
        expect(result.terminalOperation).toBeUndefined();
      },
    );

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
      expect(result.response.error).toBe('Upstream model returned 500');
      expect(result.response.failureCategory).toBe(AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR);
      expect(result.response.content).toContain('Team leader timeout continuation failed');
      expect(result.response.content).toContain('timeout-continuation: Upstream model returned 500');
      expect(result.response.content).not.toContain('timeout-continuation-2');
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
        error: 'Upstream model returned 500',
        failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      });
      expect(result.response.content).toBe(
        'All team leader parts failed: part-1: Upstream model returned 500',
      );
      expect(result.response.content).not.toContain('timeout-continuation');
      expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    });
  });
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
