import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import type { StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import type { ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { createRawFindingsStructuredOutput } from '../core/workflow/findings/manager-agent.js';
import { parseFindingLedger } from '../core/workflow/findings/schemas.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import { emptyFindingAuthorityProjection } from './helpers/finding-lifecycle-fixture.js';
import {
  makeRule,
  makeStep,
  makeWorkflowResumePointEntry,
} from './test-helpers.js';

const { compactSessionBeforePhase1Mock, ingestFindingContractResultsMock } = vi.hoisted(() => ({
  compactSessionBeforePhase1Mock: vi.fn().mockResolvedValue('reused'),
  ingestFindingContractResultsMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/engine/session-compaction.js', () => ({
  compactSessionBeforePhase1: compactSessionBeforePhase1Mock,
}));

vi.mock('../core/workflow/findings/contract-intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/findings/contract-intake.js')>();
  return {
    ...actual,
    ingestFindingContractResults: ingestFindingContractResultsMock,
  };
});

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/phase-runner.js')>();
  return {
    ...actual,
    runReportPhase: vi.fn(),
    runStatusJudgmentPhase: vi.fn(),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import { ParallelRunner } from '../core/workflow/engine/ParallelRunner.js';
import {
  runReportPhase,
  runStatusJudgmentPhase,
} from '../core/workflow/phase-runner.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'review',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeDoneResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'reviewer',
    status: 'done',
    content: 'approved',
    timestamp: new Date('2026-07-07T00:00:00.000Z'),
    sessionId: 'session-1',
    ...overrides,
  };
}

function makeRunPaths(cwd: string): RunPaths {
  return {
    slug: 'test-run',
    runRootRel: '.takt/runs/test-run',
    reportsRel: '.takt/runs/test-run/reports',
    contextRel: '.takt/runs/test-run/context',
    contextKnowledgeRel: '.takt/runs/test-run/context/knowledge',
    contextPolicyRel: '.takt/runs/test-run/context/policy',
    contextPreviousResponsesRel: '.takt/runs/test-run/context/previous_responses',
    logsRel: '.takt/runs/test-run/logs',
    metaRel: '.takt/runs/test-run/meta.json',
    runRootAbs: join(cwd, '.takt/runs/test-run'),
    reportsAbs: join(cwd, '.takt/runs/test-run/reports'),
    contextAbs: join(cwd, '.takt/runs/test-run/context'),
    contextKnowledgeAbs: join(cwd, '.takt/runs/test-run/context/knowledge'),
    contextPolicyAbs: join(cwd, '.takt/runs/test-run/context/policy'),
    contextPreviousResponsesAbs: join(cwd, '.takt/runs/test-run/context/previous_responses'),
    logsAbs: join(cwd, '.takt/runs/test-run/logs'),
    metaAbs: join(cwd, '.takt/runs/test-run/meta.json'),
  };
}

function makeCompactStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    instruction: 'Review',
    provider: 'opencode',
    model: 'opencode/big-pickle',
    session: 'compact' as unknown as WorkflowStep['session'],
    ...overrides,
  });
}

function queueAgentResponse(response: AgentResponse): void {
  vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    return response;
  });
}

function makeParallelDeps(
  cwd: string,
  overrides: Partial<ParallelRunnerDeps> = {},
): ParallelRunnerDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd,
        projectCwd: cwd,
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/big-pickle',
        sessionId: 'session-1',
      }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
      normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step: WorkflowStep, response: AgentResponse) => ({ response, invalidDetail: undefined })),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: { projectCwd: cwd },
    getCwd: () => cwd,
    getReportDir: () => '.takt/runs/test-run/reports',
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getInteractive: () => false,
    observabilityEnabled: false,
    refreshFindingsState: vi.fn(),
    emitEvent: vi.fn(),
    claimStepOccurrence: vi.fn().mockReturnValue(1),
    updateMaxSteps: vi.fn(),
    setActiveResumePoint: vi.fn(),
    getRunId: () => 'test-run',
    getFindingCallNamespace: () => '',
    structuredCaller: {
      evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
    },
    runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeNormalDeps(
  cwd: string,
  runPaths: RunPaths,
  overrides: Partial<StepExecutorDeps> = {},
): StepExecutorDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd,
        projectCwd: cwd,
        resolvedProvider: 'opencode',
        resolvedModel: 'opencode/big-pickle',
        sessionId: 'session-1',
      }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
      resolveStepProviderModel: vi.fn().mockReturnValue({
        provider: 'opencode',
        model: 'opencode/big-pickle',
      }),
    } as unknown as StepExecutorDeps['optionsBuilder'],
    getCwd: () => cwd,
    getProjectCwd: () => cwd,
    getReportDir: () => '.takt/runs/test-run/reports',
    getRunPaths: () => runPaths,
    getLanguage: () => undefined,
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'review' }],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getWorkflowDescription: () => undefined,
    getRetryNote: () => undefined,
    structuredCaller: {
      evaluateCondition: vi.fn(),
      judgeStatus: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    refreshFindingsState: vi.fn(),
    emitEvent: vi.fn(),
    recordSynthesizedAgentUsage: vi.fn(),
    getRunId: () => 'test-run',
    getFindingCallNamespace: () => '',
    executionProvider: 'opencode',
    executionModel: 'opencode/big-pickle',
    ...overrides,
  };
}

describe('session compaction Phase 1 wiring', () => {
  let cwd: string;
  let runPaths: RunPaths;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'session-compaction-wiring-'));
    runPaths = makeRunPaths(cwd);
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(executeAgent).mockReset();
    compactSessionBeforePhase1Mock.mockResolvedValue('reused');
    vi.mocked(runReportPhase).mockResolvedValue(undefined);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({
      label: 'approved',
      method: 'phase3_tag',
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('Given a normal compact step When Phase 1 runs Then compaction happens before the agent call', async () => {
    const step = makeCompactStep();
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    queueAgentResponse(makeDoneResponse());

    await new StepExecutor(deps).runNormalStep(step, makeState(), 'task', 5, vi.fn());

    expect(compactSessionBeforePhase1Mock).toHaveBeenCalledWith(step, phase1Options);
    expect(compactSessionBeforePhase1Mock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeAgent).mock.invocationCallOrder[0]!,
    );
  });

  it('Given normal compaction failure When Phase 1 runs Then it clears the old session and executes fresh', async () => {
    const step = makeCompactStep();
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    };
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-1',
    );
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    queueAgentResponse(makeDoneResponse({ sessionId: 'session-fresh' }));

    await new StepExecutor(deps).runNormalStep(step, state, 'task', 5, updatePersonaSession);

    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith('reviewer', expect.any(String), expect.objectContaining({
      sessionId: undefined,
    }));
    expect(updatePersonaSession).toHaveBeenNthCalledWith(
      1,
      '["reviewer","opencode","opencode/big-pickle"]',
      undefined,
    );
    expect(updatePersonaSession).toHaveBeenNthCalledWith(
      2,
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-fresh',
    );
    expect(state.personaSessions.get(
      '["reviewer","opencode","opencode/big-pickle"]',
    )).toBe('session-fresh');
  });

  it('Given fresh Phase 1 returns no session When relation clarification runs Then it never receives the invalidated session', async () => {
    const step = makeCompactStep({
      outputContracts: [{ name: 'findings.json', format: 'json', formatRef: 'review-finding-contract' }],
    });
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-old',
    };
    const reviewScopeSnapshotId = 'session-compaction-review-snapshot';
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue({
          ledgerSummary: '{"findings":[]}',
          reportLedgerSummary: '{"ids":[]}',
          hasOpenFindings: false,
          hasWaivedFindings: false,
          hasDismissedFindings: false,
          reviewer: {
            mode: 'structured',
            rawFindingsStructuredOutput: createRawFindingsStructuredOutput(reviewScopeSnapshotId),
            reviewScopeSnapshotId,
          },
        }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getTask: () => 'task',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      findingContract: {} as NonNullable<StepExecutorDeps['findingContract']>,
      findingLedgerStore: {
        loadLedger: vi.fn().mockReturnValue({
          workflowName: 'test-workflow',
          nextId: 1,
          updatedAt: '2026-07-16T00:00:00.000Z',
          findings: [],
          evidenceRecords: [],
          rawFindings: [],
          conflicts: [],
          interpretations: [],
          ...emptyFindingAuthorityProjection(),
        } satisfies FindingLedger),
      } as NonNullable<StepExecutorDeps['findingLedgerStore']>,
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
    };
    expect(() => parseFindingLedger(deps.findingLedgerStore!.loadLedger())).not.toThrow();
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-old',
    );
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    mkdirSync(runPaths.reportsAbs, { recursive: true });
    writeFileSync(join(runPaths.reportsAbs, 'findings.json'), '{}');
    queueAgentResponse(makeDoneResponse({
      sessionId: undefined,
      structuredOutput: {
        rawFindings: [{
          rawExcerpt: 'A finding',
          candidate: {
            rawFindingId: 'raw-1',
            familyTag: 'bug',
            severity: 'high',
            title: 'A finding',
            description: 'A finding',
            relation: 'persists',
            targetFindingId: 'F-9999',
            suggestion: null,
            target: { kind: 'code', paths: ['src/a.ts'] },
            evidenceRequests: [],
          },
        }],
      },
    }));
    queueAgentResponse(makeDoneResponse({
      sessionId: undefined,
      structuredOutput: {
        rawFindings: [{
          rawExcerpt: 'A finding',
          candidate: {
            rawFindingId: 'raw-1',
            familyTag: 'bug',
            severity: 'high',
            title: 'A finding',
            description: 'A finding',
            relation: 'new',
            targetFindingId: null,
            suggestion: null,
            target: { kind: 'code', paths: ['src/a.ts'] },
            evidenceRequests: [],
          },
        }],
      },
    }));

    const executor = new StepExecutor(deps);
    const preparedExecution = executor.prepareNormalStepExecution(step, state, 'task', 5, 1);
    await executor.runNormalStep(
      step,
      state,
      'task',
      5,
      vi.fn(),
      undefined,
      undefined,
      preparedExecution,
    );

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId)).toEqual([undefined, undefined]);
    expect(ingestFindingContractResultsMock).toHaveBeenCalledOnce();
  });

  it('Given report and status phases run When a compact normal step executes Then compaction is still Phase 1 only', async () => {
    const step = makeCompactStep({
      outputContracts: [{ name: 'review.md', format: 'markdown' }],
      rules: [
        makeRule('approved', 'COMPLETE'),
        makeRule('needs_fix', 'ABORT'),
      ],
    });
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
    };
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowName: () => 'test-workflow',
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      getWorkflowDescription: () => undefined,
      getRetryNote: () => undefined,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    };
    queueAgentResponse(makeDoneResponse());

    await new StepExecutor(deps).runNormalStep(step, makeState(), 'task', 5, vi.fn());

    expect(runReportPhase).toHaveBeenCalledOnce();
    expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(compactSessionBeforePhase1Mock).toHaveBeenCalledOnce();
    expect(compactSessionBeforePhase1Mock).toHaveBeenCalledWith(step, phase1Options);
  });

  it('Given a compact parallel sub-step When Phase 1 runs Then compaction happens before the sub-agent call', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [subStep],
    });
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
    };
    const deps: ParallelRunnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as ParallelRunnerDeps['optionsBuilder'],
      stepExecutor: {
        buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
        emitStepReports: vi.fn(),
        persistPreviousResponseSnapshot: vi.fn(),
        normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
        normalizeStructuredOutputWithDiagnostics: vi.fn((_step: WorkflowStep, response: AgentResponse) => ({
          response,
          invalidDetail: undefined,
        })),
      } as unknown as ParallelRunnerDeps['stepExecutor'],
      engineOptions: {
        projectCwd: cwd,
      },
      getCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getWorkflowName: () => 'test-workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
      structuredCaller: {
        evaluateCondition: vi.fn(),
        judgeStatus: vi.fn(),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    };
    queueAgentResponse(makeDoneResponse());

    await new ParallelRunner(deps).runParallelStep(parentStep, makeState(), 'task', 5, vi.fn());

    expect(compactSessionBeforePhase1Mock).toHaveBeenCalledWith(subStep, phase1Options);
    expect(compactSessionBeforePhase1Mock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeAgent).mock.invocationCallOrder[0]!,
    );
  });

  it('Given parallel compaction failure When Phase 1 runs Then it executes the sub-step fresh without restoring the old session', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const phase1Options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode',
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
    };
    const deps: ParallelRunnerDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as ParallelRunnerDeps['optionsBuilder'],
      stepExecutor: {
        buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
        emitStepReports: vi.fn(),
        persistPreviousResponseSnapshot: vi.fn(),
        normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
        normalizeStructuredOutputWithDiagnostics: vi.fn((_step: WorkflowStep, response: AgentResponse) => ({ response, invalidDetail: undefined })),
      } as unknown as ParallelRunnerDeps['stepExecutor'],
      engineOptions: { projectCwd: cwd },
      getCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getWorkflowName: () => 'test-workflow',
      getInteractive: () => false,
      observabilityEnabled: false,
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    };
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-1',
    );
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    queueAgentResponse(makeDoneResponse({ sessionId: undefined }));

    await new ParallelRunner(deps).runParallelStep(parentStep, state, 'task', 5, updatePersonaSession);

    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith('reviewer', expect.any(String), expect.objectContaining({
      sessionId: undefined,
    }));
    expect(updatePersonaSession).toHaveBeenCalledWith(
      '["reviewer","opencode","opencode/big-pickle"]',
      undefined,
    );
    expect(state.personaSessions.has(
      '["reviewer","opencode","opencode/big-pickle"]',
    )).toBe(false);
  });

  it('Given fresh fallback Phase 1 returns a provider error When a parallel sub-step runs Then it does not execute the side effect twice', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-1',
    );
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    let sideEffectCount = 0;
    vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      sideEffectCount++;
      options.onPromptResolved?.({ systemPrompt: 'system prompt', userInstruction: instruction });
      return {
        persona: 'reviewer',
        status: 'error',
        content: 'provider failed after write',
        error: 'provider failed after write',
        timestamp: new Date(),
      };
    });

    await new ParallelRunner(makeParallelDeps(cwd)).runParallelStep(parentStep, state, 'task', 5, vi.fn());

    expect(sideEffectCount).toBe(1);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith('reviewer', expect.any(String), expect.objectContaining({
      sessionId: undefined,
    }));
  });

  it('Given parallel compaction starts fresh When empty continuation hits a provider error Then it stops without another fresh retry', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-fresh' }));
    queueAgentResponse({
      persona: 'reviewer',
      status: 'error',
      content: 'provider failed',
      error: 'provider failed',
      timestamp: new Date(),
      sessionId: 'session-fresh',
    });
    const state = makeState();

    const result = await new ParallelRunner(
      makeParallelDeps(cwd),
    ).runParallelStep(parentStep, state, 'task', 5, vi.fn());

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId))
      .toEqual([undefined, 'session-fresh']);
    expect(state.stepOutputs.get('api-review')).toMatchObject({
      status: 'error',
      error: 'provider failed',
    });
    expect(result.response.status).toBe('error');
  });

  it('Given reused-session Phase 1 returns a provider error When a parallel sub-step runs Then the existing one-time fresh recovery still executes', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('reused');
    queueAgentResponse({
      persona: 'reviewer',
      status: 'error',
      content: 'provider failed',
      error: 'provider failed',
      timestamp: new Date(),
      sessionId: 'session-1',
    });
    queueAgentResponse(makeDoneResponse({ sessionId: 'session-recovered' }));

    await new ParallelRunner(makeParallelDeps(cwd)).runParallelStep(parentStep, makeState(), 'task', 5, vi.fn());

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId)).toEqual(['session-1', undefined]);
  });

  it('Given normal Phase 1 stays empty When recovery runs Then it continues once and restarts fresh with truthful phase records', async () => {
    const step = makeCompactStep();
    const state = makeState();
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const recordSynthesizedAgentUsage = vi.fn();
    queueAgentResponse(makeDoneResponse({ content: '  ', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: 'approved fresh', sessionId: 'session-fresh' }));

    const result = await new StepExecutor(makeNormalDeps(cwd, runPaths, {
      onPhaseStart,
      onPhaseComplete,
      recordSynthesizedAgentUsage,
    })).runNormalStep(step, state, 'task', 5, updatePersonaSession);

    const calls = vi.mocked(executeAgent).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([, , options]) => options.sessionId)).toEqual([
      'session-1',
      'session-1',
      undefined,
    ]);
    expect(calls[1]![1]).toContain('Continue the review or work');
    expect(calls[2]![1]).toBe(calls[0]![1]);
    expect(onPhaseStart.mock.calls.map((call) => call[5])).toEqual([
      'review:1:1:1',
      'review:1:1:2',
      'review:1:1:3',
    ]);
    expect(onPhaseComplete.mock.calls.map((call) => call[6])).toEqual([
      'review:1:1:1',
      'review:1:1:2',
      'review:1:1:3',
    ]);
    expect(recordSynthesizedAgentUsage).toHaveBeenCalledTimes(2);
    expect(updatePersonaSession).toHaveBeenCalledWith(sessionKey, undefined);
    expect(state.personaSessions.get(sessionKey)).toBe('session-fresh');
    expect(result.response.content).toBe('approved fresh');
  });

  it('Given parallel Phase 1 stays empty When recovery runs Then it uses the same continuation and fresh-session contract', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [subStep],
    });
    const state = makeState();
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const delegatedUsage = vi.fn();
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: ' \n', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: 'approved fresh', sessionId: 'session-fresh' }));

    const result = await new ParallelRunner(makeParallelDeps(cwd, {
      onPhaseStart,
      onPhaseComplete,
      engineOptions: {
        projectCwd: cwd,
        onDelegatedAgentUsage: delegatedUsage,
      },
    })).runParallelStep(parentStep, state, 'task', 5, updatePersonaSession);

    const calls = vi.mocked(executeAgent).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([, , options]) => options.sessionId)).toEqual([
      'session-1',
      'session-1',
      undefined,
    ]);
    expect(calls[1]![1]).toContain('Continue the review or work');
    expect(calls[2]![1]).toBe(calls[0]![1]);
    expect(onPhaseStart.mock.calls.map((call) => call[5])).toEqual([
      'api-review:1:1:1',
      'api-review:1:1:2',
      'api-review:1:1:3',
    ]);
    expect(onPhaseComplete.mock.calls.map((call) => call[6])).toEqual([
      'api-review:1:1:1',
      'api-review:1:1:2',
      'api-review:1:1:3',
    ]);
    expect(delegatedUsage).toHaveBeenCalledTimes(3);
    expect(state.personaSessions.get(sessionKey)).toBe('session-fresh');
    expect(state.stepOutputs.get('api-review')?.content).toBe('approved fresh');
    expect(result.response.status).toBe('done');
  });

  it('Given provider recovery consumes one attempt When the next outputs are empty Then parallel Phase 1 stops at three executions', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [subStep],
    });
    const state = makeState();
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    queueAgentResponse({
      persona: 'reviewer',
      status: 'error',
      content: 'provider failed',
      error: 'provider failed',
      timestamp: new Date(),
      sessionId: 'session-1',
    });
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-provider-fresh' }));
    queueAgentResponse(makeDoneResponse({ content: ' ', sessionId: 'session-provider-fresh' }));

    const result = await new ParallelRunner(makeParallelDeps(cwd, {
      onPhaseStart,
      onPhaseComplete,
    })).runParallelStep(parentStep, state, 'task', 5, updatePersonaSession);

    const calls = vi.mocked(executeAgent).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([, , options]) => options.sessionId)).toEqual([
      'session-1',
      undefined,
      'session-provider-fresh',
    ]);
    expect(calls[1]![1]).toBe(calls[0]![1]);
    expect(calls[2]![1]).toContain('Continue the review or work');
    expect(onPhaseStart.mock.calls.map((call) => call[5])).toEqual([
      'api-review:1:1:1',
      'api-review:1:1:2',
      'api-review:1:1:3',
    ]);
    expect(onPhaseComplete.mock.calls.map((call) => [call[4], call[6]])).toEqual([
      ['error', 'api-review:1:1:1'],
      ['done', 'api-review:1:1:2'],
      ['error', 'api-review:1:1:3'],
    ]);
    expect(state.stepOutputs.get('api-review')).toMatchObject({
      status: 'error',
      error: 'Phase 1 returned empty output',
    });
    expect(state.personaSessions.has(sessionKey)).toBe(false);
    expect(result.response.status).toBe('error');
  });

  it('Given all normal empty recoveries fail When Phase 1 stops Then it discards the final fresh session', async () => {
    const step = makeCompactStep();
    const state = makeState();
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: ' ', sessionId: 'session-1' }));
    queueAgentResponse(makeDoneResponse({ content: '\n', sessionId: 'session-final-empty' }));
    const onPhaseComplete = vi.fn();

    const result = await new StepExecutor(
      makeNormalDeps(cwd, runPaths, { onPhaseComplete }),
    ).runNormalStep(step, state, 'task', 5, updatePersonaSession);

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(3);
    expect(result.response).toMatchObject({
      status: 'error',
      error: 'Phase 1 returned empty output',
    });
    expect(result.response.sessionId).toBeUndefined();
    expect(state.personaSessions.has(sessionKey)).toBe(false);
    expect(updatePersonaSession.mock.calls.at(-1)).toEqual([sessionKey, undefined]);
    expect(onPhaseComplete.mock.calls.map((call) => [call[4], call[6]])).toEqual([
      ['done', 'review:1:1:1'],
      ['done', 'review:1:1:2'],
      ['error', 'review:1:1:3'],
    ]);
  });
});
