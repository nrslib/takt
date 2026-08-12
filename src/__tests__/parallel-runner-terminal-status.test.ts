import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { AgentResponse, AgentWorkflowStep, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { makeRule, makeStep } from './test-helpers.js';
import {
  createProviderStreamParseError,
  MAX_AGENT_FAILURE_MESSAGE_BYTES,
} from '../shared/types/agent-failure.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return {
    ...actual,
    RuleEvaluator: MockRuleEvaluator,
  };
});

vi.mock('../core/workflow/phase-runner.js', () => ({
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ label: '', method: 'auto_select' }),
}));

import { executeAgent } from '../agents/agent-usecases.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import type { StepProviderInfo, StepRunResult } from '../core/workflow/types.js';

interface TerminalLineageFixture {
  readonly subStep: WorkflowStep;
  readonly response: AgentResponse;
  readonly instruction: string;
  readonly providerInfo: StepProviderInfo;
  readonly workflowCallFailure: NonNullable<StepRunResult['workflowCallFailure']>;
  readonly terminalOperation: NonNullable<StepRunResult['terminalOperation']>;
}

function projectPrimaryErrorLineage(
  runner: ParallelRunner,
  terminalResults: TerminalLineageFixture[],
): { result: StepRunResult; primary: TerminalLineageFixture } {
  const boundary = runner as unknown as {
    firstFailureResult(results: TerminalLineageFixture[]): TerminalLineageFixture | undefined;
    createTerminalParentResult(options: {
      step: WorkflowStep;
      state: WorkflowState;
      stepIteration: number;
      subResults: TerminalLineageFixture[];
      terminalResults: TerminalLineageFixture[];
      status: 'error';
      providerInfo: StepProviderInfo;
      primaryFailure: TerminalLineageFixture;
    }): StepRunResult;
  };
  const primary = boundary.firstFailureResult(terminalResults);
  if (primary === undefined) {
    throw new Error('Expected primary error fixture');
  }
  return {
    primary,
    result: boundary.createTerminalParentResult({
      step: makeParallelStep(),
      state: makeState(),
      stepIteration: 1,
      subResults: terminalResults,
      terminalResults,
      status: 'error',
      providerInfo: primary.providerInfo,
      primaryFailure: primary,
    }),
  };
}

function makeTerminalLineageFixture(options: {
  readonly stepName: string;
  readonly error: string;
  readonly providerInfo: StepProviderInfo;
  readonly failureCategory?: AgentResponse['failureCategory'];
  readonly hasRateMetadata: boolean;
}): TerminalLineageFixture {
  const rateLimitInfo = {
    provider: options.providerInfo.provider,
    detectedAt: new Date(`2026-05-29T00:00:0${options.stepName.length % 10}.000Z`),
    source: 'error_text' as const,
  };
  return {
    subStep: makeReviewStep(options.stepName),
    response: makeAgentResponse({
      persona: options.stepName,
      status: 'error',
      content: '',
      error: options.error,
      ...(options.failureCategory === undefined
        ? {}
        : { failureCategory: options.failureCategory }),
      ...(options.hasRateMetadata
        ? { errorKind: 'rate_limit', rateLimitInfo }
        : {}),
    }),
    instruction: `instruction:${options.stepName}`,
    providerInfo: options.providerInfo,
    workflowCallFailure: {
      kind: 'step_error',
      step: options.stepName,
      reason: options.error,
      error: options.error,
      ...(options.failureCategory === undefined
        ? {}
        : { failureCategory: options.failureCategory }),
    },
    terminalOperation: {
      origin: { stage: 'reviewer', reviewerStepName: options.stepName },
      providerInfo: options.providerInfo,
    },
  };
}

function makeState(): WorkflowState {
  return {
    workflowName: 'test-workflow',
    currentStep: 'reviewers',
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

function makeAgentResponse(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    persona: 'test-agent',
    status: 'done',
    content: '[STEP:1] approved',
    timestamp: new Date('2026-05-29T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReviewStep(name: string): WorkflowStep {
  return makeStep({
    name,
    persona: name,
    instruction: `Run ${name}`,
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
  });
}

function makeParallelStep(): WorkflowStep {
  return makeStep({
    name: 'reviewers',
    instruction: 'Run parallel reviewers',
    parallel: [
      makeReviewStep('ai-antipattern-review-2nd'),
      makeReviewStep('security-review'),
    ],
    rules: [
      makeRule('all("approved")', 'COMPLETE'),
      makeRule('any("needs_fix")', 'fix'),
    ],
  });
}

function makeParallelStepInOrder(reversed: boolean): WorkflowStep {
  const aiReview = makeReviewStep('ai-antipattern-review-2nd');
  const securityReview = makeReviewStep('security-review');
  return makeStep({
    name: 'reviewers',
    instruction: 'Run parallel reviewers',
    parallel: reversed
      ? [securityReview, aiReview]
      : [aiReview, securityReview],
    rules: [
      makeRule('all("approved")', 'COMPLETE'),
      makeRule('any("needs_fix")', 'fix'),
    ],
  });
}

const AI_PROVIDER_INFO = { provider: 'claude' as const, model: 'ai-model' };
const SECURITY_PROVIDER_INFO = { provider: 'mock' as const, model: 'security-model' };

function configureDistinctProviderInfo(deps: ParallelRunnerDeps): void {
  const resolve = (step: WorkflowStep) => {
    if (step.name === 'ai-antipattern-review-2nd') return AI_PROVIDER_INFO;
    if (step.name === 'security-review') return SECURITY_PROVIDER_INFO;
    return { provider: 'claude' as const, model: 'parent-model' };
  };
  vi.mocked(deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting).mockImplementation(resolve);
  vi.mocked(deps.optionsBuilder.resolveStepProviderModel).mockImplementation(resolve);
}

function mockResponsesByPersona(responses: Readonly<Record<string, AgentResponse>>): void {
  vi.mocked(executeAgent).mockImplementation(async (persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    const response = responses[persona ?? ''];
    if (response === undefined) {
      throw new Error(`Missing response fixture for persona: ${persona ?? 'undefined'}`);
    }
    return response;
  });
}

function makeRunner(): { runner: ParallelRunner; deps: ParallelRunnerDeps } {
  const deps: ParallelRunnerDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
      resolveStepProviderModelBeforeAutoRouting: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      prepareDynamicFacetStep: vi.fn(async (step: AgentWorkflowStep) => step),
      buildInstruction: vi.fn((step: WorkflowStep) => `instruction:${step.name}`),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: {
      projectCwd: '/tmp/project',
    },
    getCwd: () => '/tmp/project',
    getReportDir: () => '.takt/runs/test/reports',
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
    updateMaxSteps: vi.fn(),
    setActiveResumePoint: vi.fn(),
  };
  return { runner: new ParallelRunner(deps), deps };
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

function queueAgentRejection(error: Error): void {
  vi.mocked(executeAgent).mockImplementationOnce(async (_persona, instruction, options) => {
    options.onPromptResolved?.({
      systemPrompt: 'system prompt',
      userInstruction: instruction,
    });
    throw error;
  });
}

describe('ParallelRunner terminal sub-step statuses', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => {
      return step.name === 'security-review'
        ? { index: 0, method: 'phase3_tag' }
        : undefined;
    });
  });

  it('keeps configured provider/model preflight for agent sub-steps', async () => {
    const { runner, deps } = makeRunner();
    const failure = new Error('configured provider preflight failed');
    const resolveBeforeAutoRouting = vi.mocked(
      deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting,
    );
    resolveBeforeAutoRouting.mockImplementation((step) => {
      if (step.name === 'security-review') {
        throw failure;
      }
      return { provider: 'claude', model: 'claude-sonnet' };
    });

    await expect(
      runner.runParallelStep(makeParallelStep(), makeState(), 'test task', 5, vi.fn()),
    ).rejects.toBe(failure);

    expect(resolveBeforeAutoRouting.mock.calls.map(([step]) => step.name)).toEqual([
      'ai-antipattern-review-2nd',
      'security-review',
    ]);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('keeps final provider/model preflight for agent sub-steps', async () => {
    const { runner, deps } = makeRunner();
    const failure = new Error('final provider preflight failed');
    const resolveProviderModel = vi.mocked(deps.optionsBuilder.resolveStepProviderModel);
    resolveProviderModel.mockImplementation((step) => {
      if (step.name === 'security-review') {
        throw failure;
      }
      return { provider: 'claude', model: 'claude-sonnet' };
    });

    await expect(
      runner.runParallelStep(makeParallelStep(), makeState(), 'test task', 5, vi.fn()),
    ).rejects.toBe(failure);

    expect(resolveProviderModel.mock.calls.map(([step]) => step.name)).toEqual([
      'reviewers',
      'ai-antipattern-review-2nd',
      'security-review',
    ]);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('returns parent error when one sub-step returns error and another approves', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: 'Reconnecting... 2/5',
      error: 'timeout waiting for child process to exit',
      failureCategory: 'provider_error',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));
    // error 席は新セッションで1回再試行される。terminal のままにするため
    // 再試行分も同じエラーを返す
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: 'Reconnecting... 2/5',
      error: 'timeout waiting for child process to exit',
      failureCategory: 'provider_error',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('error');
    expect(result.response.persona).toBe('reviewers');
    expect(result.response.error).toContain('timeout waiting for child process to exit');
    expect(result.response.failureCategory).toBe('provider_error');
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: error');
    expect(result.response.content).toContain('failureCategory: provider_error');
    expect(result.response.content).toContain('timeout waiting for child process to exit');
    expect(result.response.content).toContain('aggregate');
    expect(state.stepOutputs.get('reviewers')).toBe(result.response);
    expect(state.lastOutput).toBe(result.response);
  });

  it('passes engine childProcessEnv to parallel sub-step quality gates', async () => {
    const { runner, deps } = makeRunner();
    const childProcessEnv = { TAKT_OBSERVABILITY: '{"enabled":true}' };
    deps.engineOptions.childProcessEnv = childProcessEnv;
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      content: '[STEP:1] approved',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[STEP:1] approved',
    }));

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(deps.runQualityGates).toHaveBeenCalledWith(expect.objectContaining({
      childProcessEnv,
      step: expect.objectContaining({ name: 'ai-antipattern-review-2nd' }),
    }));
    expect(deps.runQualityGates).toHaveBeenCalledWith(expect.objectContaining({
      childProcessEnv,
      step: expect.objectContaining({ name: 'security-review' }),
    }));
  });

  it('returns parent error with rejected promise detail', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentRejection(new Error('Session resume failed'));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('error');
    expect(result.response.error).toContain('Session resume failed');
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: error');
    expect(result.response.content).toContain('failureCategory: none');
    expect(result.response.content).toContain('Session resume failed');
    expect(state.stepOutputs.get('ai-antipattern-review-2nd')?.error).toBe('Session resume failed');
  });

  it('returns parent blocked when one sub-step blocks and no sub-step errors', async () => {
    const { runner, deps } = makeRunner();
    vi.mocked(deps.stepExecutor.persistPreviousResponseSnapshot).mockImplementation(
      (targetState, stepName, stepIteration, content) => {
        targetState.previousResponseSourcePath = `.takt/runs/test/context/previous_responses/${stepName}.${stepIteration}.snapshot.md`;
        expect(content).toContain('Need user input before review can continue');
      },
    );
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'blocked',
      content: 'Need user input before review can continue',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('blocked');
    expect(result.response.persona).toBe('reviewers');
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: blocked');
    expect(result.response.content).toContain('failureCategory: none');
    expect(result.response.content).toContain('Need user input before review can continue');
    expect(result.response.content).toContain('aggregate');
    expect(state.stepOutputs.get('reviewers')).toBe(result.response);
    expect(state.lastOutput).toBe(result.response);
    expect(deps.stepExecutor.persistPreviousResponseSnapshot).toHaveBeenCalledWith(
      state,
      'reviewers',
      1,
      result.response.content,
    );
    expect(state.previousResponseSourcePath).toBe('.takt/runs/test/context/previous_responses/reviewers.1.snapshot.md');
  });

  it('returns parent rate_limited with sub-step diagnostics and rate limit metadata', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    const rateLimitInfo = {
      provider: 'claude' as const,
      detectedAt: new Date('2026-05-29T00:00:00.000Z'),
      source: 'stream_marker' as const,
      resetAtRaw: '2:30pm (Asia/Tokyo)',
    };
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded. Please try again later.',
      errorKind: 'rate_limit',
      rateLimitInfo,
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('rate_limited');
    expect(result.response.persona).toBe('reviewers');
    expect(result.response.errorKind).toBe('rate_limit');
    expect(result.response.rateLimitInfo).toBe(rateLimitInfo);
    expect(result.providerInfo?.provider).toBe('claude');
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: rate_limited');
    expect(result.response.content).toContain('failureCategory: none');
    expect(result.response.content).toContain('rateLimitInfo: provider=claude, source=stream_marker');
    expect(result.response.content).toContain('Rate limit exceeded. Please try again later.');
    expect(result.response.content).toContain('aggregate');
    expect(result.response.error).toBe('Rate limit exceeded. Please try again later.');
    expect(state.stepOutputs.get('reviewers')).toBe(result.response);
    expect(state.lastOutput).toBe(result.response);
    expect(state.previousResponseSourcePath).toBeUndefined();
  });

  it('keeps every terminal sub-step in parent rate_limited diagnostics', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    const rateLimitInfo = {
      provider: 'claude' as const,
      detectedAt: new Date('2026-05-29T00:00:00.000Z'),
      source: 'stream_marker' as const,
    };
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded for ai reviewer.',
      errorKind: 'rate_limit',
      rateLimitInfo,
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      status: 'error',
      content: '',
      error: 'Security reviewer failed after retry.',
      failureCategory: 'provider_error',
    }));
    // 再試行分も同じエラー（terminal 維持）
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      status: 'error',
      content: '',
      error: 'Security reviewer failed after retry.',
      failureCategory: 'provider_error',
    }));


    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('rate_limited');
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: rate_limited');
    expect(result.response.content).toContain('Rate limit exceeded for ai reviewer.');
    expect(result.response.content).toContain('security-review');
    expect(result.response.content).toContain('status: error');
    expect(result.response.content).toContain('failureCategory: provider_error');
    expect(result.response.content).toContain('Security reviewer failed after retry.');
    expect(result.response.error).toBe('Rate limit exceeded for ai reviewer.');
    expect(result.response.failureCategory).toBeUndefined();
    expect(result.response.errorKind).toBe('rate_limit');
    expect(result.response.rateLimitInfo).toBe(rateLimitInfo);
    expect(result.workflowCallFailure).toBeUndefined();
  });

  it('uses one categorized error as the parent response and workflow failure source', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error: 'First generic failure.',
      errorKind: 'rate_limit',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      status: 'error',
      content: '',
      error: 'Later provider failure.',
      failureCategory: 'provider_error',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      status: 'error',
      content: '',
      error: 'Later provider failure.',
      failureCategory: 'provider_error',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response).toMatchObject({
      status: 'error',
      error: 'Later provider failure.',
      failureCategory: 'provider_error',
    });
    expect(result.response.content).toContain('First generic failure.');
    expect(result.response.content).toContain('Later provider failure.');
    expect(result.workflowCallFailure).toMatchObject({
      kind: 'step_error',
      step: 'security-review',
      reason: 'Later provider failure.',
      error: 'Later provider failure.',
      failureCategory: 'provider_error',
    });
  });

  it.each([false, true])(
    'keeps categorized error lineage when generic and provider failures are reversed (reversed=%s)',
    async (reversed) => {
      const { runner, deps } = makeRunner();
      configureDistinctProviderInfo(deps);
      mockResponsesByPersona({
        'ai-antipattern-review-2nd': makeAgentResponse({
          persona: 'ai-antipattern-review-2nd',
          status: 'error',
          content: '',
          error: 'Generic AI failure.',
          errorKind: 'rate_limit',
        }),
        'security-review': makeAgentResponse({
          persona: 'security-review',
          status: 'error',
          content: '',
          error: 'Categorized security failure.',
          failureCategory: 'provider_error',
        }),
      });

      const result = await runner.runParallelStep(
        makeParallelStepInOrder(reversed),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'error',
        error: 'Categorized security failure.',
        failureCategory: 'provider_error',
      });
      expect(result.providerInfo).toEqual(SECURITY_PROVIDER_INFO);
      expect(result.workflowCallFailure).toMatchObject({
        step: 'security-review',
        reason: 'Categorized security failure.',
        error: 'Categorized security failure.',
        failureCategory: 'provider_error',
      });
      expect(result.terminalOperation).toBeUndefined();
      expect(result.response.content).toContain('Generic AI failure.');
      expect(result.response.content).toContain('Categorized security failure.');
    },
  );

  it.each([false, true])(
    'projects every provider-error primary field without generic sibling mixing (reversed=%s)',
    (reversed) => {
      const { runner } = makeRunner();
      const generic = makeTerminalLineageFixture({
        stepName: 'generic-source',
        error: 'Generic source error.',
        providerInfo: AI_PROVIDER_INFO,
        hasRateMetadata: true,
      });
      const provider = makeTerminalLineageFixture({
        stepName: 'provider-source',
        error: 'Provider source error.',
        providerInfo: SECURITY_PROVIDER_INFO,
        failureCategory: 'provider_error',
        hasRateMetadata: false,
      });
      const { result, primary } = projectPrimaryErrorLineage(
        runner,
        reversed ? [provider, generic] : [generic, provider],
      );

      expect(primary).toBe(provider);
      expect(result.response).toMatchObject({
        status: provider.response.status,
        error: provider.response.error,
        failureCategory: provider.response.failureCategory,
      });
      expect(result.response.errorKind).toBeUndefined();
      expect(result.response.rateLimitInfo).toBeUndefined();
      expect(result.providerInfo).toBe(provider.providerInfo);
      expect(result.workflowCallFailure).toBe(provider.workflowCallFailure);
      expect(result.workflowCallFailure).toMatchObject({
        step: 'provider-source',
        reason: 'Provider source error.',
        error: 'Provider source error.',
        failureCategory: 'provider_error',
      });
      expect(result.terminalOperation).toBe(provider.terminalOperation);
      expect(result.response.error).not.toContain('Generic source');
      expect(result.workflowCallFailure).not.toEqual(generic.workflowCallFailure);
      expect(result.terminalOperation).not.toEqual(generic.terminalOperation);
      expect(result.response.content).toContain('Generic source error.');
    },
  );

  it.each([false, true])(
    'projects every first generic primary field for equal-priority errors (reversed=%s)',
    (reversed) => {
      const { runner } = makeRunner();
      const generic = makeTerminalLineageFixture({
        stepName: 'generic-source',
        error: 'Generic source error.',
        providerInfo: AI_PROVIDER_INFO,
        hasRateMetadata: false,
      });
      const providerSeat = makeTerminalLineageFixture({
        stepName: 'provider-seat-source',
        error: 'Provider seat generic error.',
        providerInfo: SECURITY_PROVIDER_INFO,
        hasRateMetadata: true,
      });
      const ordered = reversed
        ? [providerSeat, generic]
        : [generic, providerSeat];
      const { result, primary } = projectPrimaryErrorLineage(runner, ordered);
      const secondary = reversed ? generic : providerSeat;

      expect(primary).toBe(ordered[0]);
      expect(result.response).toMatchObject({
        status: primary.response.status,
        error: primary.response.error,
      });
      expect(result.response.failureCategory).toBeUndefined();
      expect(result.response.errorKind).toBeUndefined();
      expect(result.response.rateLimitInfo).toBeUndefined();
      expect(result.providerInfo).toBe(primary.providerInfo);
      expect(result.workflowCallFailure).toBe(primary.workflowCallFailure);
      expect(result.workflowCallFailure).toMatchObject({
        step: primary.subStep.name,
        reason: primary.response.error,
        error: primary.response.error,
      });
      expect(result.workflowCallFailure?.failureCategory).toBeUndefined();
      expect(result.terminalOperation).toBe(primary.terminalOperation);
      expect(result.response.error).not.toBe(secondary.response.error);
      expect(result.workflowCallFailure).not.toEqual(secondary.workflowCallFailure);
      expect(result.terminalOperation).not.toEqual(secondary.terminalOperation);
      expect(result.response.content).toContain(secondary.response.error);
    },
  );

  it.each([false, true])(
    'keeps one rejected primary as response and workflow failure source (reversed=%s)',
    async (reversed) => {
      const { runner } = makeRunner();
      vi.mocked(executeAgent).mockImplementation(async (persona) => {
        throw new Error(`${persona ?? 'unknown'} rejected`);
      });
      const primaryStep = reversed ? 'security-review' : 'ai-antipattern-review-2nd';
      const secondaryStep = reversed ? 'ai-antipattern-review-2nd' : 'security-review';

      const result = await runner.runParallelStep(
        makeParallelStepInOrder(reversed),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'error',
        error: `${primaryStep} rejected`,
      });
      expect(result.workflowCallFailure).toMatchObject({
        step: primaryStep,
        reason: `${primaryStep} rejected`,
        error: `${primaryStep} rejected`,
      });
      expect(result.response.content).toContain(`${primaryStep} rejected`);
      expect(result.response.content).toContain(`${secondaryStep} rejected`);
      expect(result.response.error).not.toContain(secondaryStep);
    },
  );

  it.each([false, true])(
    'keeps rate-limit lineage when rate and provider failures are reversed (reversed=%s)',
    async (reversed) => {
      const { runner, deps } = makeRunner();
      configureDistinctProviderInfo(deps);
      const rateLimitInfo = {
        provider: 'claude' as const,
        detectedAt: new Date('2026-05-29T00:00:00.000Z'),
        source: 'stream_marker' as const,
      };
      mockResponsesByPersona({
        'ai-antipattern-review-2nd': makeAgentResponse({
          persona: 'ai-antipattern-review-2nd',
          status: 'rate_limited',
          content: '',
          error: 'AI rate limit.',
          errorKind: 'rate_limit',
          rateLimitInfo,
        }),
        'security-review': makeAgentResponse({
          persona: 'security-review',
          status: 'error',
          content: '',
          error: 'Security provider failure.',
          failureCategory: 'provider_error',
        }),
      });

      const result = await runner.runParallelStep(
        makeParallelStepInOrder(reversed),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'rate_limited',
        error: 'AI rate limit.',
        errorKind: 'rate_limit',
        rateLimitInfo,
      });
      expect(result.response.failureCategory).toBeUndefined();
      expect(result.providerInfo).toEqual(AI_PROVIDER_INFO);
      expect(result.workflowCallFailure).toBeUndefined();
      expect(result.terminalOperation).toEqual({
        origin: { stage: 'reviewer', reviewerStepName: 'ai-antipattern-review-2nd' },
        providerInfo: AI_PROVIDER_INFO,
      });
      expect(result.response.content).toContain('Security provider failure.');
    },
  );

  it.each([false, true])(
    'keeps error lineage and excludes blocked terminal metadata when siblings are reversed (reversed=%s)',
    async (reversed) => {
      const { runner, deps } = makeRunner();
      configureDistinctProviderInfo(deps);
      mockResponsesByPersona({
        'ai-antipattern-review-2nd': makeAgentResponse({
          persona: 'ai-antipattern-review-2nd',
          status: 'error',
          content: '',
          error: 'Selected generic error.',
          errorKind: 'rate_limit',
        }),
        'security-review': makeAgentResponse({
          persona: 'security-review',
          status: 'blocked',
          content: 'Blocked security review.',
        }),
      });

      const result = await runner.runParallelStep(
        makeParallelStepInOrder(reversed),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'error',
        error: 'Selected generic error.',
      });
      expect(result.response.failureCategory).toBeUndefined();
      expect(result.response.errorKind).toBeUndefined();
      expect(result.providerInfo).toEqual(AI_PROVIDER_INFO);
      expect(result.workflowCallFailure).toMatchObject({
        step: 'ai-antipattern-review-2nd',
        reason: 'Selected generic error.',
        error: 'Selected generic error.',
      });
      expect(result.terminalOperation).toBeUndefined();
      expect(result.response.content).toContain('Blocked security review.');
    },
  );

  it.each([false, true])(
    'keeps the selected rate terminal operation when a blocked sibling is reversed (reversed=%s)',
    async (reversed) => {
      const { runner, deps } = makeRunner();
      configureDistinctProviderInfo(deps);
      mockResponsesByPersona({
        'ai-antipattern-review-2nd': makeAgentResponse({
          persona: 'ai-antipattern-review-2nd',
          status: 'rate_limited',
          content: '',
          error: 'Selected rate terminal.',
          errorKind: 'rate_limit',
        }),
        'security-review': makeAgentResponse({
          persona: 'security-review',
          status: 'blocked',
          content: 'Unselected blocked terminal.',
        }),
      });

      const result = await runner.runParallelStep(
        makeParallelStepInOrder(reversed),
        makeState(),
        'test task',
        5,
        vi.fn(),
      );

      expect(result.response).toMatchObject({
        status: 'rate_limited',
        error: 'Selected rate terminal.',
        errorKind: 'rate_limit',
      });
      expect(result.providerInfo).toEqual(AI_PROVIDER_INFO);
      expect(result.workflowCallFailure).toBeUndefined();
      expect(result.terminalOperation).toEqual({
        origin: { stage: 'reviewer', reviewerStepName: 'ai-antipattern-review-2nd' },
        providerInfo: AI_PROVIDER_INFO,
      });
      expect(result.terminalOperation).not.toEqual({
        origin: { stage: 'reviewer', reviewerStepName: 'security-review' },
        providerInfo: SECURITY_PROVIDER_INFO,
      });
      expect(result.response.content).toContain('Unselected blocked terminal.');
    },
  );

  it('uses a later parse failure for both parent response and step_error over an earlier categorized rate limit', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded for ai reviewer.',
      errorKind: 'rate_limit',
      failureCategory: 'provider_error',
      rateLimitInfo: {
        provider: 'claude',
        detectedAt: new Date('2026-05-29T00:00:00.000Z'),
        source: 'stream_marker',
      },
    }));
    queueAgentRejection(createProviderStreamParseError('Failed to parse item: invalid stdout line'));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('error');
    expect(result.response.failureCategory).toBe('provider_stream_parse_error');
    expect(result.response.error).toBe(
      'provider stream parse error: Failed to parse item: invalid stdout line',
    );
    expect(result.response.errorKind).toBeUndefined();
    expect(result.response.rateLimitInfo).toBeUndefined();
    expect(result.workflowCallFailure).toMatchObject({
      kind: 'step_error',
      step: 'security-review',
      reason: 'provider stream parse error: Failed to parse item: invalid stdout line',
      error: 'provider stream parse error: Failed to parse item: invalid stdout line',
      failureCategory: 'provider_stream_parse_error',
    });
  });

  it('purges the stale persona session when the fresh retry returns no session id', async () => {
    const { runner, deps } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    const staleSessionId = 'stale-session';
    state.personaSessions.set(
      '["ai-antipattern-review-2nd","claude","claude-sonnet"]',
      staleSessionId,
    );
    vi.mocked(deps.optionsBuilder.buildAgentOptions).mockReturnValue({ sessionId: staleSessionId } as never);
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error: 'assistant message cycle budget exceeded',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));
    // 再試行は成功するが sessionId を返さない
    queueAgentResponse({
      ...makeAgentResponse({
        persona: 'ai-antipattern-review-2nd',
        content: '[AI-ANTIPATTERN-REVIEW-2ND:1] approved',
      }),
      sessionId: undefined,
    });

    const updateSession = vi.fn();
    const result = await runner.runParallelStep(step, state, 'test task', 5, updateSession);

    expect(result.response.status).toBe('done');
    // 劣化していた旧セッションが resume 対象に残らない（undefined で削除）
    expect(updateSession).toHaveBeenCalledWith(expect.stringContaining('ai-antipattern-review-2nd'), undefined);
  });

  it('does not retry a sub-step whose error is a rate limit', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error: '429 too many requests',
      errorKind: 'rate_limit',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    // rate limit は新セッション再試行の対象外（既存の rate_limited 経路に委ねる）
    expect(vi.mocked(executeAgent)).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe('error');
  });

  it('redacts sensitive sub-step error details from parent diagnostics', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error: 'Provider failed with api_key=top-secret and Authorization: Bearer sk-secret123456',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));
    // 再試行分も同じエラー（terminal 維持）
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error: 'Provider failed with api_key=top-secret and Authorization: Bearer sk-secret123456',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('error');
    expect(result.response.content).toContain('api_key=[REDACTED]');
    expect(result.response.content).toContain('Authorization: Bearer [REDACTED]');
    expect(result.response.content).not.toContain('top-secret');
    expect(result.response.content).not.toContain('sk-secret123456');
    expect(result.response.error).toBe(
      'Provider failed with api_key=[REDACTED] and Authorization: Bearer [REDACTED]',
    );
  });

  it('re-bounds masked parent failures while retaining the marker, path, and category', async () => {
    const { runner } = makeRunner();
    const step = makeParallelStep();
    const state = makeState();
    const marker = '[TRUNCATED: 12000 bytes, full text: /tmp/failure.txt]';
    const secretAssignment = 'api_key=x';
    const error = `${secretAssignment}${'x'.repeat(
      MAX_AGENT_FAILURE_MESSAGE_BYTES - Buffer.byteLength(`${secretAssignment}${marker}`, 'utf8'),
    )}${marker}`;
    expect(Buffer.byteLength(error, 'utf8')).toBe(MAX_AGENT_FAILURE_MESSAGE_BYTES);

    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error,
      failureCategory: 'provider_error',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'security-review',
      content: '[SECURITY-REVIEW:1] approved',
    }));
    queueAgentResponse(makeAgentResponse({
      persona: 'ai-antipattern-review-2nd',
      status: 'error',
      content: '',
      error,
      failureCategory: 'provider_error',
    }));

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());
    const workflowCallFailure = result.workflowCallFailure;
    const parentFailureValues = [
      result.response.error,
      workflowCallFailure?.reason,
      workflowCallFailure?.error,
      state.stepOutputs.get('reviewers')?.error,
    ];

    expect(result.response.status).toBe('error');
    expect(result.response.failureCategory).toBe('provider_error');
    expect(result.response.content).toContain('failureCategory: provider_error');
    expect(result.response.content).toContain(marker);
    expect(workflowCallFailure?.kind).toBe('step_error');
    for (const value of parentFailureValues) {
      expect(value).toBeDefined();
      expect(Buffer.byteLength(value ?? '', 'utf8')).toBeLessThanOrEqual(
        MAX_AGENT_FAILURE_MESSAGE_BYTES,
      );
      expect(value).toContain(marker);
      expect(value).not.toContain(secretAssignment);
      expect(value).toContain('api_key=[REDACTED]');
    }
  });
});
