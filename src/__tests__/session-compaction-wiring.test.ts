import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResponse, AgentWorkflowStep, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { buildRunPaths, type RunPaths } from '../core/workflow/run/run-paths.js';
import type { StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import type { ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { Provider, ProviderCompactSessionOptions } from '../infra/providers/types.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import {
  makeRule,
  makeStep,
  makeWorkflowResumePointEntry,
} from './test-helpers.js';

const { compactSessionMock, compactionWarnMock } = vi.hoisted(() => ({
  compactSessionMock: vi.fn<(options: ProviderCompactSessionOptions) => Promise<void>>(),
  compactionWarnMock: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/engine/session-compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/engine/session-compaction.js')>();
  const provider: Provider = {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => false,
    setup: vi.fn(),
    compactSession: compactSessionMock,
  };
  return {
    ...actual,
    compactSessionBeforePhase1: ((step, options) => (
      actual.compactSessionBeforePhase1(step, options, {
        getProvider: () => provider,
        warn: compactionWarnMock,
      })
    )) satisfies typeof actual.compactSessionBeforePhase1,
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
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    dynamicFacetSelections: new Map(),
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

function makeCompactStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'reviewer',
    instruction: 'Review',
    provider: 'opencode',
    model: 'opencode/big-pickle',
    session: 'compact',
    ...overrides,
  } as Partial<WorkflowStep>);
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
      buildProviderStream: vi.fn<ParallelRunnerDeps['optionsBuilder']['buildProviderStream']>(
        (_step, _provider, _model, onStream) => onStream,
      ),
      resolveStepProviderModelBeforeAutoRouting: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'opencode', model: 'opencode/big-pickle' }),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      prepareDynamicFacetStep: vi.fn(async (step: AgentWorkflowStep) => step),
      prepareInstruction: vi.fn((step: WorkflowStep) => ({ text: `instruction:${step.name}`, injectedReports: [] })),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
      normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
      normalizeStructuredOutputWithDiagnostics: vi.fn((_step: WorkflowStep, response: AgentResponse) => ({ response, invalidDetail: undefined })),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: { projectCwd: cwd },
    getCwd: () => cwd,
    dynamicParallelSelector: {
      selectParticipants: vi.fn(),
    } as unknown as ParallelRunnerDeps['dynamicParallelSelector'],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getInteractive: () => false,
    observabilityEnabled: false,
    emitEvent: vi.fn(),
    claimStepOccurrence: vi.fn().mockReturnValue(1),
    updateMaxSteps: vi.fn(),
    setActiveResumePoint: vi.fn(),
    getRunId: () => 'test-run',
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
    getFailureDir: () => join(runPaths.runRootAbs, 'failures'),
    getLanguage: () => undefined,
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'review' }],
    getWorkflowName: () => 'test-workflow',
    getTask: () => 'task',
    getWorkflowDescription: () => undefined,
    getWorkflowRules: () => undefined,
    getRetryNote: () => undefined,
    getReviewScope: () => ({ kind: 'not_a_git_repository' } as const),
    structuredOutputNormalizers: createStructuredOutputNormalizerRegistry([]),
    emitEvent: vi.fn(),
    recordSynthesizedAgentUsage: vi.fn(),
    getRunId: () => 'test-run',
    getRunPathNamespace: () => [],
    companionEnabled: false,
    companionReviewMode: 'completion',
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
    runPaths = buildRunPaths(cwd, 'test-run');
    mkdirSync(runPaths.contextPreviousResponsesAbs, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(executeAgent).mockReset();
    compactSessionMock.mockReset().mockResolvedValue(undefined);
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
    const deps = makeNormalDeps(cwd, runPaths, {
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    });
    queueAgentResponse(makeDoneResponse());

    await new StepExecutor(deps).runNormalStep(step, makeState(), 'task', 5, vi.fn());

    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd, sessionId: 'session-1', model: 'opencode/big-pickle',
    }));
    expect(compactSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeAgent).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(executeAgent).mock.calls[0]![2].sessionId).toBe('session-1');
  });

  it('Given normal compaction failure When Phase 1 runs Then it keeps the existing session before and after a response without a session ID', async () => {
    const step = makeCompactStep();
    const deps = makeNormalDeps(cwd, runPaths);
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-1',
    );
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    const observedSessions: Array<string | undefined> = [];
    compactSessionMock.mockImplementationOnce(async () => {
      observedSessions.push(state.personaSessions.get('["reviewer","opencode","opencode/big-pickle"]'));
      throw new Error('compaction failed');
    });
    vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      observedSessions.push(state.personaSessions.get('["reviewer","opencode","opencode/big-pickle"]'));
      options.onPromptResolved?.({ systemPrompt: 'system prompt', userInstruction: instruction });
      return makeDoneResponse({ sessionId: undefined });
    });

    const result = await new StepExecutor(deps).runNormalStep(step, state, 'task', 5, updatePersonaSession);

    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(observedSessions).toEqual(['session-1', 'session-1']);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith('reviewer', expect.any(String), expect.objectContaining({
      sessionId: 'session-1',
    }));
    expect(updatePersonaSession).not.toHaveBeenCalledWith('["reviewer","opencode","opencode/big-pickle"]', undefined);
    expect(state.personaSessions.get(
      '["reviewer","opencode","opencode/big-pickle"]',
    )).toBe('session-1');
    expect(result.response).toMatchObject({ status: 'done', sessionId: 'session-1' });
  });



  it('Given report and status phases run When a compact normal step executes Then compaction is still Phase 1 only', async () => {
    const step = makeCompactStep({
      outputContracts: [{ name: 'review.md', format: 'markdown' }],
      rules: [
        makeRule('approved', 'COMPLETE'),
        makeRule('needs_fix', 'ABORT'),
      ],
    });
    const deps = makeNormalDeps(cwd, runPaths, {
      getCurrentWorkflowStack: () => [
        makeWorkflowResumePointEntry({ step: 'review' }),
      ],
      onPhaseStart: vi.fn(),
      onPhaseComplete: vi.fn(),
      onJudgeStage: vi.fn(),
    });
    queueAgentResponse(makeDoneResponse());

    await new StepExecutor(deps).runNormalStep(step, makeState(), 'task', 5, vi.fn());

    expect(runReportPhase).toHaveBeenCalledOnce();
    expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(compactSessionMock).toHaveBeenCalledOnce();
    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd, sessionId: 'session-1', model: 'opencode/big-pickle',
    }));
  });

  it('Given a compact parallel sub-step When Phase 1 runs Then compaction happens before the sub-agent call', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [subStep],
    });
    const deps = makeParallelDeps(cwd);
    queueAgentResponse(makeDoneResponse());

    await new ParallelRunner(deps).runParallelStep(parentStep, makeState(), 'task', 5, vi.fn());

    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd, sessionId: 'session-1', model: 'opencode/big-pickle',
    }));
    expect(compactSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executeAgent).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(executeAgent).mock.calls[0]![2].sessionId).toBe('session-1');
  });

  it.each([false, true])('Given parallel compaction failure with streaming=%s When Phase 1 runs Then it keeps the existing session before and after a response without a session ID', async (streaming) => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const deps = makeParallelDeps(cwd, {
      engineOptions: { projectCwd: cwd, ...(streaming ? { onStream: vi.fn() } : {}) },
    });
    const state = makeState();
    state.personaSessions.set(
      '["reviewer","opencode","opencode/big-pickle"]',
      'session-1',
    );
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    const observedSessions: Array<string | undefined> = [];
    compactSessionMock.mockImplementationOnce(async () => {
      observedSessions.push(state.personaSessions.get('["reviewer","opencode","opencode/big-pickle"]'));
      throw new Error('compaction failed');
    });
    vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
      observedSessions.push(state.personaSessions.get('["reviewer","opencode","opencode/big-pickle"]'));
      options.onPromptResolved?.({ systemPrompt: 'system prompt', userInstruction: instruction });
      return makeDoneResponse({ sessionId: undefined });
    });

    const result = await new ParallelRunner(deps).runParallelStep(parentStep, state, 'task', 5, updatePersonaSession);

    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(observedSessions).toEqual(['session-1', 'session-1']);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith('reviewer', expect.any(String), expect.objectContaining({
      sessionId: 'session-1',
    }));
    expect(updatePersonaSession).not.toHaveBeenCalledWith(
      '["reviewer","opencode","opencode/big-pickle"]',
      undefined,
    );
    expect(state.personaSessions.get(
      '["reviewer","opencode","opencode/big-pickle"]',
    )).toBe('session-1');
    expect(state.stepOutputs.get('api-review')).toMatchObject({ status: 'done', sessionId: 'session-1' });
    expect(result.response.status).toBe('done');
  });

  it('Given Phase 1 without a resumed session returns a provider error When a parallel sub-step runs Then it retries once in a fresh session', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const state = makeState();
    const deps = makeParallelDeps(cwd);
    vi.mocked(deps.optionsBuilder.buildAgentOptions).mockReturnValue({ cwd, projectCwd: cwd, resolvedProvider: 'opencode', sessionId: undefined });
    let sideEffectCount = 0;
    vi.mocked(executeAgent).mockImplementation(async (_persona, instruction, options) => {
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

    await new ParallelRunner(deps).runParallelStep(parentStep, state, 'task', 5, vi.fn());

    expect(sideEffectCount).toBe(2);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId))
      .toEqual([undefined, undefined]);
  });

  it.each(['normal', 'parallel'] as const)('Given external abort during %s compaction When preparation stops Then Phase 1 does not run and the existing session is retained', async (runner) => {
    const abortController = new AbortController();
    const error = new Error('OpenCode execution aborted');
    const state = makeState();
    const sessionKey = '["reviewer","opencode","opencode/big-pickle"]';
    state.personaSessions.set(sessionKey, 'session-1');
    const updatePersonaSession = vi.fn((key: string, sessionId: string | undefined) => {
      if (sessionId === undefined) state.personaSessions.delete(key);
      else state.personaSessions.set(key, sessionId);
    });
    compactSessionMock.mockImplementationOnce(async () => {
      abortController.abort();
      throw error;
    });
    const options = {
      cwd,
      projectCwd: cwd,
      resolvedProvider: 'opencode' as const,
      resolvedModel: 'opencode/big-pickle',
      sessionId: 'session-1',
      abortSignal: abortController.signal,
    };

    if (runner === 'normal') {
      const deps = makeNormalDeps(cwd, runPaths);
      vi.mocked(deps.optionsBuilder.buildAgentOptions).mockReturnValue(options);
      await expect(new StepExecutor(deps).runNormalStep(
        makeCompactStep(), state, 'task', 5, updatePersonaSession,
      )).rejects.toBe(error);
    } else {
      const deps = makeParallelDeps(cwd);
      vi.mocked(deps.optionsBuilder.buildAgentOptions).mockReturnValue(options);
      const parentStep = makeStep({
        name: 'reviewers',
        parallel: [makeCompactStep({ name: 'api-review' })],
      });
      const result = await new ParallelRunner(deps).runParallelStep(
        parentStep, state, 'task', 5, updatePersonaSession,
      );
      expect(result.response.status).toBe('error');
      expect(state.stepOutputs.get('api-review')).toMatchObject({ status: 'error', error: error.message });
    }

    expect(compactSessionMock).toHaveBeenCalledOnce();
    expect(compactSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', abortSignal: abortController.signal,
    }));
    expect(executeAgent).not.toHaveBeenCalled();
    expect(compactionWarnMock).not.toHaveBeenCalled();
    expect(updatePersonaSession).not.toHaveBeenCalled();
    expect(state.personaSessions.get(sessionKey)).toBe('session-1');
  });

  it('Given parallel Phase 1 starts without a resumed session When empty continuation hits a provider error Then it retries the original instruction fresh once', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
    const deps = makeParallelDeps(cwd);
    vi.mocked(deps.optionsBuilder.buildAgentOptions).mockReturnValue({ cwd, projectCwd: cwd, resolvedProvider: 'opencode', sessionId: undefined });
    queueAgentResponse(makeDoneResponse({ content: '', sessionId: 'session-fresh' }));
    queueAgentResponse({
      persona: 'reviewer',
      status: 'error',
      content: 'provider failed',
      error: 'provider failed',
      timestamp: new Date(),
      sessionId: 'session-fresh',
    });
    queueAgentResponse({
      persona: 'reviewer',
      status: 'error',
      content: 'provider failed',
      error: 'provider failed',
      timestamp: new Date(),
    });
    const state = makeState();

    const result = await new ParallelRunner(
      deps,
    ).runParallelStep(parentStep, state, 'task', 5, vi.fn());

    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(executeAgent).mock.calls.map(([, , options]) => options.sessionId))
      .toEqual([undefined, 'session-fresh', undefined]);
    expect(state.stepOutputs.get('api-review')).toMatchObject({
      status: 'error',
      error: 'provider failed',
    });
    expect(result.response.status).toBe('error');
  });

  it('Given reused-session Phase 1 returns a provider error When a parallel sub-step runs Then the existing one-time fresh recovery still executes', async () => {
    const subStep = makeCompactStep({ name: 'api-review' });
    const parentStep = makeStep({ name: 'reviewers', instruction: 'Run reviewers', parallel: [subStep] });
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
    expect(recordSynthesizedAgentUsage.mock.calls.map((call) => call[2])).toEqual([true, true]);
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
    expect(delegatedUsage.mock.calls.map((call) => call[1].success)).toEqual([true, true, true]);
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
