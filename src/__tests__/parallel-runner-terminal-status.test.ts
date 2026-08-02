import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type {
  AgentResponse,
  AutoRoutingConfig,
  WorkflowResumePoint,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { makeRule, makeStep } from './test-helpers.js';
import { WorkflowStepBudget } from '../core/workflow/workflow-step-budget.js';

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

const eventAttribution = {
  iteration: 1,
  scope: {
    kind: 'workflow_execution_scope',
    stack: [],
  },
} as const;

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

function makeAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: { provider: 'mock', model: 'router-model' },
    candidates: [
      {
        name: 'default',
        provider: 'mock',
        model: 'routed-model',
        routingTier: 'medium',
      },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: {
        candidates: ['default'],
        fallback: 'default',
      },
    },
  };
}

function makeResumePoint(
  stack: WorkflowResumePoint['stack'],
  iteration: number,
): WorkflowResumePoint {
  return {
    version: 2,
    stack,
    iteration,
    max_steps: 5,
    elapsed_ms: 0,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
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
    emitEvent: vi.fn(),
    setActiveResumePoint: vi.fn(),
    adoptResumeCheckpoint: vi.fn(),
    setActiveResumeStack: vi.fn(),
    getCurrentWorkflowStack: () => [{
      workflow: 'test-workflow',
      step: 'reviewers',
      kind: 'agent',
    }],
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

  it('runs a parallel workflow_call without resolving provider or model for the call wrapper', async () => {
    const { runner, deps } = makeRunner();
    const estimate = vi.fn().mockResolvedValue({
      requiredTier: 'medium',
      reasonCodes: ['focused-change'],
    });
    deps.engineOptions.autoRouting = makeAutoRoutingConfig();
    deps.engineOptions.autoRoutingEstimator = { estimate };
    const workflowCallStep = makeStep({
      name: 'delegate-review',
      kind: 'workflow_call',
      call: './child.yaml',
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [workflowCallStep],
      rules: [makeRule('all("COMPLETE")', 'COMPLETE')],
    });
    const resolveBeforeRouting = vi.mocked(
      deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting,
    );
    const resolveProviderModel = vi.mocked(deps.optionsBuilder.resolveStepProviderModel);
    resolveBeforeRouting.mockImplementation((step) => {
      if (step.name === 'delegate-review') {
        throw new Error('workflow_call wrapper reached provider preflight');
      }
      return { provider: 'mock', model: 'parent-model' };
    });
    resolveProviderModel.mockImplementation((step) => {
      if (step.name === 'delegate-review') {
        throw new Error('workflow_call wrapper reached provider resolution');
      }
      return { provider: 'mock', model: 'parent-model' };
    });
    const resolveRuntime = vi.fn(() => {
      throw new Error('workflow_call wrapper resolved runtime provider/model');
    });
    const state = makeState();
    vi.mocked(deps.setActiveResumePoint).mockImplementation((_step, iteration) => {
      expect(state.iteration).toBe(1);
      state.iteration = iteration;
    });
    const runIsolated = vi.fn().mockImplementation(async () => {
      state.stepIterations.set('delegate-review', 1);
      return {
        result: {
          response: makeAgentResponse({
            persona: 'child-review',
            content: 'approved',
          }),
          instruction: 'child instruction',
        },
        sessionUpdates: new Map(),
        stateSync: {
          iteration: 2,
          resumePoint: makeResumePoint([], 2),
          interrupted: false,
        },
      };
    });
    deps.getWorkflowCallRunner = () => ({
      resolveRuntime,
      runIsolated,
    } as unknown as ReturnType<NonNullable<ParallelRunnerDeps['getWorkflowCallRunner']>>);

    const result = await runner.runParallelStep(parentStep, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

    expect(result.response.status).toBe('done');
    expect(state.iteration).toBe(2);
    expect(state.stepIterations).toEqual(new Map([
      ['reviewers', 1],
      ['delegate-review', 1],
    ]));
    expect(deps.setActiveResumePoint).toHaveBeenCalledOnce();
    expect(runIsolated).toHaveBeenCalledOnce();
    expect(resolveBeforeRouting.mock.calls.map(([step]) => step.name))
      .not.toContain('delegate-review');
    expect(resolveProviderModel.mock.calls.map(([step]) => step.name))
      .not.toContain('delegate-review');
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('routes only agent sub-steps when workflow_call and agent sub-steps are mixed', async () => {
    const { runner, deps } = makeRunner();
    const estimate = vi.fn().mockResolvedValue({
      requiredTier: 'medium',
      reasonCodes: ['focused-change'],
    });
    deps.engineOptions.autoRouting = makeAutoRoutingConfig();
    deps.engineOptions.autoRoutingEstimator = { estimate };
    const agentStep = makeReviewStep('security-review');
    const workflowCallStep = makeStep({
      name: 'delegate-review',
      kind: 'workflow_call',
      call: './child.yaml',
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    });
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [agentStep, workflowCallStep],
      rules: [makeRule('all("approved")', 'COMPLETE')],
    });
    const resolveBeforeRouting = vi.mocked(
      deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting,
    );
    resolveBeforeRouting.mockImplementation((step) => (
      step.name === agentStep.name
        ? { provider: undefined, model: undefined }
        : { provider: 'mock', model: 'parent-model' }
    ));
    vi.mocked(deps.optionsBuilder.resolveStepProviderModel).mockImplementation(
      (_step, runtime) => runtime?.providerInfo ?? { provider: 'mock', model: 'parent-model' },
    );
    const state = makeState();
    const runIsolated = vi.fn().mockImplementation(async () => {
      state.stepIterations.set(workflowCallStep.name, 1);
      return {
        result: {
          response: makeAgentResponse({
            persona: 'child-review',
            content: 'approved',
          }),
          instruction: '',
        },
        sessionUpdates: new Map(),
        stateSync: {
          iteration: 2,
          resumePoint: makeResumePoint([], 2),
          interrupted: false,
        },
      };
    });
    deps.getWorkflowCallRunner = () => ({
      runIsolated,
    } as unknown as ReturnType<NonNullable<ParallelRunnerDeps['getWorkflowCallRunner']>>);
    queueAgentResponse(makeAgentResponse({
      persona: agentStep.name,
      content: 'approved',
    }));

    const result = await runner.runParallelStep(parentStep, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

    expect(result.response.status).toBe('done');
    expect(estimate).toHaveBeenCalledOnce();
    expect(estimate.mock.calls.map(([input]) => input.step.name)).toEqual([agentStep.name]);
    expect(resolveBeforeRouting.mock.calls.map(([step]) => step.name)).toEqual([agentStep.name]);
    expect(runIsolated).toHaveBeenCalledOnce();
    expect(executeAgent).toHaveBeenCalledOnce();
  });

  it('does not rerun a successful workflow_call when an agent fallback is exhausted', async () => {
    const { runner, deps } = makeRunner();
    deps.engineOptions.rateLimitFallback = {
      switchChain: [{ provider: 'codex', model: 'gpt-5' }],
    };
    vi.mocked(deps.optionsBuilder.resolveStepProviderModel).mockImplementation(
      (_step, runtime) => runtime?.providerInfo ?? { provider: 'claude', model: 'claude-sonnet' },
    );
    const workflowCallStep = makeStep({
      name: 'delegate-review',
      kind: 'workflow_call',
      call: './child.yaml',
      rules: [makeRule('COMPLETE', 'COMPLETE')],
    });
    const agentStep = makeReviewStep('security-review');
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run reviewers',
      parallel: [workflowCallStep, agentStep],
      rules: [makeRule('all("COMPLETE")', 'COMPLETE')],
    });
    const runIsolated = vi.fn().mockResolvedValue({
      result: {
        response: makeAgentResponse({ persona: 'child-review', content: 'approved' }),
        instruction: '',
      },
      sessionUpdates: new Map(),
      stateSync: {
        iteration: 2,
        resumePoint: makeResumePoint([], 2),
        interrupted: false,
      },
    });
    deps.getWorkflowCallRunner = () => ({
      runIsolated,
    } as unknown as ReturnType<NonNullable<ParallelRunnerDeps['getWorkflowCallRunner']>>);
    const rateLimitedResponse = makeAgentResponse({
      persona: agentStep.name,
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded',
      errorKind: 'rate_limit',
    });
    queueAgentResponse(rateLimitedResponse);
    queueAgentResponse(rateLimitedResponse);

    const result = await runner.runParallelStep(
      parentStep,
      makeState(),
      'test task',
      5,
      vi.fn(),
      undefined,
      undefined,
      eventAttribution,
    );

    expect(result.response.status).toBe('rate_limited');
    expect(result.rateLimitFallbackHandled).toBe(true);
    expect(runIsolated).toHaveBeenCalledOnce();
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['A then B', ['delegate-a', 'delegate-b']],
    ['B then A', ['delegate-b', 'delegate-a']],
  ] as const)('selects the YAML-first interrupted child resume regardless of limit rejection order: %s', async (_label, limitRejectionOrder) => {
    const { runner, deps } = makeRunner();
    const delegates = ['delegate-a', 'delegate-b'].map((name) => makeStep({
      name,
      kind: 'workflow_call',
      call: `./${name}.yaml`,
      rules: [makeRule('ABORT', 'ABORT')],
    }));
    const parentStep = makeStep({
      name: 'reviewers',
      instruction: 'Run delegated reviewers',
      parallel: delegates,
      rules: [makeRule('any("ABORT")', 'ABORT')],
    });
    const resumeStacks = new Map(delegates.map((delegate) => [delegate.name, [
      { workflow: 'test-workflow', step: 'reviewers', kind: 'agent' as const },
      {
        workflow: 'test-workflow',
        step: delegate.name,
        kind: 'workflow_call' as const,
        call_instance: 1,
      },
      { workflow: delegate.name, step: 'child-work', kind: 'agent' as const },
    ]]));
    const budget = new WorkflowStepBudget(1);
    const rejectionOrder: string[] = [];
    const resolvers = new Map<string, () => Promise<void>>();
    deps.getWorkflowCallRunner = () => ({
      runIsolated: vi.fn((subStep: WorkflowStep) => new Promise((resolve) => {
        resolvers.set(subStep.name, async () => {
          const resumeStack = resumeStacks.get(subStep.name)!;
          const limitResult = await budget.check({
            request: {
              currentIteration: 1,
              currentStep: `${subStep.name}-child-work`,
              scope: {
                kind: 'workflow_execution_scope',
                stack: resumeStack,
              },
            },
            ignoreLimit: false,
            onLimitReached: () => {
              rejectionOrder.push(subStep.name);
            },
            onMaxStepsExtended: vi.fn(),
            requestExtension: vi.fn().mockResolvedValue(null),
          });
          expect(limitResult).toEqual({ allowed: false, maxSteps: 1 });
          resolve({
            result: {
              response: makeAgentResponse({ persona: subStep.name, status: 'error', content: 'ABORT' }),
              instruction: '',
            },
            sessionUpdates: new Map(),
            stateSync: {
              iteration: subStep.name === 'delegate-a' ? 3 : 4,
              resumePoint: makeResumePoint(
                resumeStack,
                subStep.name === 'delegate-a' ? 3 : 4,
              ),
              interrupted: true,
            },
          });
        });
      })),
    } as unknown as ReturnType<NonNullable<ParallelRunnerDeps['getWorkflowCallRunner']>>);
    const state = makeState();
    vi.mocked(deps.adoptResumeCheckpoint).mockImplementation((_resumePoint, iteration) => {
      expect(state.iteration).toBe(1);
      state.iteration = iteration;
    });

    const resultPromise = runner.runParallelStep(
      parentStep,
      state,
      'test task',
      5,
      vi.fn(),
      undefined,
      undefined,
      eventAttribution,
    );
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    for (const name of limitRejectionOrder) {
      await resolvers.get(name)?.();
    }
    await resultPromise;

    expect(rejectionOrder).toEqual([limitRejectionOrder[0]]);
    expect(budget.currentMaxSteps()).toBe(1);
    expect(state.iteration).toBe(4);
    expect(deps.adoptResumeCheckpoint).toHaveBeenCalledOnce();
    expect(deps.adoptResumeCheckpoint).toHaveBeenCalledWith(
      makeResumePoint(resumeStacks.get('delegate-a')!, 3),
      4,
    );
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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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

    await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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
    expect(result.response.error).toBe(result.response.content);
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


    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

    expect(result.response.status).toBe('rate_limited');
    expect(result.response.error).toBe(result.response.content);
    expect(result.response.content).toContain('ai-antipattern-review-2nd');
    expect(result.response.content).toContain('status: rate_limited');
    expect(result.response.content).toContain('Rate limit exceeded for ai reviewer.');
    expect(result.response.content).toContain('security-review');
    expect(result.response.content).toContain('status: error');
    expect(result.response.content).toContain('failureCategory: provider_error');
    expect(result.response.content).toContain('Security reviewer failed after retry.');
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
    const result = await runner.runParallelStep(step, state, 'test task', 5, updateSession, undefined, undefined, eventAttribution);

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn(), undefined, undefined, eventAttribution);

    expect(result.response.status).toBe('error');
    expect(result.response.content).toContain('api_key=[REDACTED]');
    expect(result.response.content).toContain('Authorization: Bearer [REDACTED]');
    expect(result.response.content).not.toContain('top-secret');
    expect(result.response.content).not.toContain('sk-secret123456');
    expect(result.response.error).toBe(result.response.content);
  });
});
