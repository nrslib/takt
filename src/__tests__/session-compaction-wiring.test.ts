import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import type { StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import type { ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import { makeStep } from './test-helpers.js';

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
    needsStatusJudgmentPhase: vi.fn(),
    runReportPhase: vi.fn(),
    runStatusJudgmentPhase: vi.fn(),
  };
});

import { executeAgent } from '../agents/agent-usecases.js';
import { StepExecutor } from '../core/workflow/engine/StepExecutor.js';
import { ParallelRunner } from '../core/workflow/engine/ParallelRunner.js';
import {
  needsStatusJudgmentPhase,
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

function makeParallelDeps(cwd: string): ParallelRunnerDeps {
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
    getInteractive: () => false,
    observabilityEnabled: false,
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {
      evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
    },
    runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
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
    compactSessionBeforePhase1Mock.mockResolvedValue('reused');
    vi.mocked(needsStatusJudgmentPhase).mockReturnValue(false);
    vi.mocked(runReportPhase).mockResolvedValue(undefined);
    vi.mocked(runStatusJudgmentPhase).mockResolvedValue({
      tag: 'approved',
      ruleIndex: 0,
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
      getWorkflowDefinitionSteps: () => [step],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getInheritedPeerReportPaths: () => [],
      getRetryNote: () => undefined,
      detectRuleIndex: vi.fn().mockReturnValue(-1),
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
      getWorkflowDefinitionSteps: () => [step],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getInheritedPeerReportPaths: () => [],
      getRetryNote: () => undefined,
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    };
    const state = makeState();
    state.personaSessions.set('reviewer:opencode', 'session-1');
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
    expect(updatePersonaSession).toHaveBeenNthCalledWith(1, 'reviewer:opencode', undefined);
    expect(updatePersonaSession).toHaveBeenNthCalledWith(2, 'reviewer:opencode', 'session-fresh');
    expect(state.personaSessions.get('reviewer:opencode')).toBe('session-fresh');
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
    const deps: StepExecutorDeps = {
      optionsBuilder: {
        buildAgentOptions: vi.fn().mockReturnValue(phase1Options),
        buildPhaseRunnerContext: vi.fn().mockReturnValue({ childProcessEnv: undefined }),
        buildFindingContractInstructionContext: vi.fn().mockReturnValue({ ledgerCopyPath: undefined }),
        resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      } as unknown as StepExecutorDeps['optionsBuilder'],
      getCwd: () => cwd,
      getProjectCwd: () => cwd,
      getReportDir: () => '.takt/runs/test-run/reports',
      getRunPaths: () => runPaths,
      getLanguage: () => undefined,
      getInteractive: () => false,
      getWorkflowSteps: () => [{ name: 'review' }],
      getWorkflowDefinitionSteps: () => [step],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getInheritedPeerReportPaths: () => [],
      getRetryNote: () => undefined,
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
      findingContract: {} as NonNullable<StepExecutorDeps['findingContract']>,
      findingLedgerStore: {
        loadLedger: vi.fn().mockReturnValue({
          version: 1,
          workflowName: 'test-workflow',
          nextId: 1,
          updatedAt: '2026-07-16T00:00:00.000Z',
          findings: [],
          rawFindings: [],
          conflicts: [],
        }),
      } as NonNullable<StepExecutorDeps['findingLedgerStore']>,
      refreshFindingsState: vi.fn(),
      emitEvent: vi.fn(),
      getRunId: () => 'test-run',
      getFindingCallNamespace: () => '',
    };
    const state = makeState();
    state.personaSessions.set('reviewer:opencode', 'session-old');
    compactSessionBeforePhase1Mock.mockResolvedValueOnce('fresh');
    mkdirSync(runPaths.reportsAbs, { recursive: true });
    writeFileSync(join(runPaths.reportsAbs, 'findings.json'), '{}');
    queueAgentResponse(makeDoneResponse({
      sessionId: undefined,
      structuredOutput: {
        rawFindings: [{
          rawFindingId: 'raw-1',
          familyTag: 'bug',
          severity: 'high',
          title: 'A finding',
          location: 'src/a.ts:1',
          description: 'A finding',
          relation: 'persists',
          targetFindingId: 'F-9999',
          suggestion: '',
        }],
      },
    }));
    queueAgentResponse(makeDoneResponse({
      sessionId: undefined,
      structuredOutput: {
        rawFindings: [{
          rawFindingId: 'raw-1',
          familyTag: 'bug',
          severity: 'high',
          title: 'A finding',
          location: 'src/a.ts:1',
          description: 'A finding',
          relation: 'new',
          targetFindingId: '',
          suggestion: '',
        }],
      },
    }));

    await new StepExecutor(deps).runNormalStep(step, state, 'task', 5, vi.fn(), 'Review');

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId)).toEqual([undefined, undefined]);
    expect(ingestFindingContractResultsMock).toHaveBeenCalledOnce();
  });

  it('Given report and status phases run When a compact normal step executes Then compaction is still Phase 1 only', async () => {
    const step = makeCompactStep({
      outputContracts: [{ name: 'review.md', format: 'markdown' }],
      rules: [{ condition: 'approved', next: 'COMPLETE' }],
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
      getWorkflowDefinitionSteps: () => [step],
      getWorkflowName: () => 'test-workflow',
      getWorkflowDescription: () => undefined,
      getInheritedPeerReportPaths: () => [],
      getRetryNote: () => undefined,
      detectRuleIndex: vi.fn().mockReturnValue(-1),
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
    vi.mocked(needsStatusJudgmentPhase).mockReturnValue(true);
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
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
      detectRuleIndex: vi.fn().mockReturnValue(-1),
      structuredCaller: {
        evaluateCondition: vi.fn(), judgeStatus: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
      runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
    };
    const state = makeState();
    state.personaSessions.set('reviewer:opencode', 'session-1');
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
    expect(updatePersonaSession).toHaveBeenCalledWith('reviewer:opencode', undefined);
    expect(state.personaSessions.has('reviewer:opencode')).toBe(false);
  });

  it('Given fresh fallback Phase 1 returns a provider error When a parallel sub-step runs Then it does not execute the side effect twice', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const state = makeState();
    state.personaSessions.set('reviewer:opencode', 'session-1');
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
});
