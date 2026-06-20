import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { makeRule, makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

import { executeAgent } from '../agents/agent-usecases.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';

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
      makeRule('all("approved")', 'COMPLETE', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
      makeRule('any("needs_fix")', 'fix', {
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateConditionText: 'needs_fix',
      }),
    ],
  });
}

function makeRunner(): { runner: ParallelRunner; deps: ParallelRunnerDeps } {
  const deps: ParallelRunnerDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
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
    detectRuleIndex: vi.fn(),
    structuredCaller: {
      evaluateCondition: vi.fn(),
      judgeStatus: vi.fn(),
      decomposeTask: vi.fn(),
      requestMoreParts: vi.fn(),
    },
    runQualityGates: vi.fn().mockResolvedValue({ ok: true }),
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
    vi.mocked(detectMatchedRule).mockImplementation(async (step) => {
      return step.name === 'security-review'
        ? { index: 0, method: 'phase1_tag' }
        : undefined;
    });
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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

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

    const result = await runner.runParallelStep(step, state, 'test task', 5, vi.fn());

    expect(result.response.status).toBe('error');
    expect(result.response.content).toContain('api_key=[REDACTED]');
    expect(result.response.content).toContain('Authorization: Bearer [REDACTED]');
    expect(result.response.content).not.toContain('top-secret');
    expect(result.response.content).not.toContain('sk-secret123456');
    expect(result.response.error).toBe(result.response.content);
  });
});
