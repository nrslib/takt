import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StepExecutor, type StepExecutorDeps } from '../core/workflow/engine/StepExecutor.js';
import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import { createStructuredOutputNormalizerRegistry } from '../core/workflow/engine/structured-output-normalizer.js';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/index.js';
import { makeStep } from './test-helpers.js';

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: vi.fn(),
}));

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
import {
  needsStatusJudgmentPhase,
  runReportPhase,
  ReportPhaseGenerationError,
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
    content: 'phase 1 output',
    timestamp: new Date('2026-06-30T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReportStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name: 'review',
    persona: 'reviewer',
    instruction: 'Review the change',
    outputContracts: [{ name: 'review.md', format: 'markdown' }],
    ...overrides,
  });
}

function makeStepExecutor(): StepExecutor {
  const deps: StepExecutorDeps = {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'claude', model: 'claude-sonnet' }),
    } as unknown as StepExecutorDeps['optionsBuilder'],
    getCwd: () => '/tmp/project',
    getProjectCwd: () => '/tmp/project',
    getReportDir: () => '.takt/runs/test/reports',
    getRunPaths: () => ({
      slug: 'test-run',
      runRootRel: '.takt/runs/test',
      reportsRel: '.takt/runs/test/reports',
      contextRel: '.takt/runs/test/context',
      contextKnowledgeRel: '.takt/runs/test/context/knowledge',
      contextPolicyRel: '.takt/runs/test/context/policy',
      contextPreviousResponsesRel: '.takt/runs/test/context/previous_responses',
      logsRel: '.takt/runs/test/logs',
      metaRel: '.takt/runs/test/meta.json',
      runRootAbs: '/tmp/project/.takt/runs/test',
      reportsAbs: '/tmp/project/.takt/runs/test/reports',
      contextAbs: '/tmp/project/.takt/runs/test/context',
      contextKnowledgeAbs: '/tmp/project/.takt/runs/test/context/knowledge',
      contextPolicyAbs: '/tmp/project/.takt/runs/test/context/policy',
      contextPreviousResponsesAbs: '/tmp/project/.takt/runs/test/context/previous_responses',
      logsAbs: '/tmp/project/.takt/runs/test/logs',
      metaAbs: '/tmp/project/.takt/runs/test/meta.json',
    }),
    getLanguage: () => undefined,
    getInteractive: () => false,
    getWorkflowSteps: () => [{ name: 'review' }],
    getWorkflowDefinitionSteps: () => [makeStep({ name: 'review' })],
    getWorkflowName: () => 'test-workflow',
    getWorkflowDescription: () => undefined,
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
  return new StepExecutor(deps);
}

function makeParallelRunner(): ParallelRunner {
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
      normalizeStructuredOutput: vi.fn((_step: WorkflowStep, response: AgentResponse) => response),
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
  return new ParallelRunner(deps);
}

function makeParallelStep(subStep: WorkflowStep): WorkflowStep {
  return makeStep({
    name: 'reviewers',
    instruction: 'Run reviewers',
    parallel: [subStep],
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(needsStatusJudgmentPhase).mockReturnValue(true);
  vi.mocked(runStatusJudgmentPhase).mockResolvedValue({
    tag: 'complete',
    ruleIndex: 0,
    method: 'phase3_tag',
  });
});

describe('ReportPhaseGenerationError soft error', () => {
  it('continues StepExecutor to Phase 3 when report phase raises ReportPhaseGenerationError', async () => {
    const executor = makeStepExecutor();
    const step = makeReportStep();
    const state = makeState();
    vi.mocked(runReportPhase).mockRejectedValue(new ReportPhaseGenerationError('report failed'));

    const response = await executor.applyPostExecutionPhases(
      step,
      state,
      1,
      makeDoneResponse(),
      vi.fn(),
    );

    expect(runReportPhase).toHaveBeenCalledOnce();
    expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(response.matchedRuleIndex).toBe(0);
    expect(response.matchedRuleMethod).toBe('phase3_tag');
  });

  it('rethrows generic report errors from StepExecutor instead of continuing to Phase 3', async () => {
    const executor = makeStepExecutor();
    const step = makeReportStep();
    vi.mocked(runReportPhase).mockRejectedValue(new Error('generic report failure'));

    await expect(executor.applyPostExecutionPhases(
      step,
      makeState(),
      1,
      makeDoneResponse(),
      vi.fn(),
    )).rejects.toThrow('generic report failure');

    expect(runStatusJudgmentPhase).not.toHaveBeenCalled();
  });

  it('continues ParallelRunner sub-step to Phase 3 when report phase raises ReportPhaseGenerationError', async () => {
    const runner = makeParallelRunner();
    const subStep = makeReportStep({ name: 'security-review', persona: 'security-review' });
    const state = makeState();
    queueAgentResponse(makeDoneResponse({ persona: 'security-review' }));
    vi.mocked(runReportPhase).mockRejectedValue(new ReportPhaseGenerationError('report failed'));

    const result = await runner.runParallelStep(makeParallelStep(subStep), state, 'review task', 5, vi.fn());

    expect(runReportPhase).toHaveBeenCalledOnce();
    expect(runStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(state.stepOutputs.get('security-review')?.matchedRuleIndex).toBe(0);
    expect(result.response.status).toBe('done');
  });

  it('propagates generic report errors from ParallelRunner as sub-step errors', async () => {
    const runner = makeParallelRunner();
    const subStep = makeReportStep({ name: 'security-review', persona: 'security-review' });
    queueAgentResponse(makeDoneResponse({ persona: 'security-review' }));
    vi.mocked(runReportPhase).mockRejectedValue(new Error('generic report failure'));

    const result = await runner.runParallelStep(makeParallelStep(subStep), makeState(), 'review task', 5, vi.fn());

    expect(runStatusJudgmentPhase).not.toHaveBeenCalled();
    expect(result.response.status).toBe('error');
    expect(result.response.error).toContain('generic report failure');
  });

  it('keeps blank-content structured output responses successful in ParallelRunner', async () => {
    const runner = makeParallelRunner();
    const subStep = makeStep({
      name: 'structured-review',
      persona: 'structured-review',
      instruction: 'Return structured output',
    });
    const state = makeState();
    queueAgentResponse(makeDoneResponse({
      persona: 'structured-review',
      content: '',
      structuredOutput: { result: 'ok' },
    }));
    vi.mocked(needsStatusJudgmentPhase).mockReturnValue(false);

    const result = await runner.runParallelStep(makeParallelStep(subStep), state, 'review task', 5, vi.fn());

    expect(state.stepOutputs.get('structured-review')?.status).toBe('done');
    expect(result.response.status).toBe('done');
  });

  it('keeps blank-content structured output responses successful in StepExecutor', async () => {
    const executor = makeStepExecutor();
    const step = makeStep({
      name: 'structured-review',
      persona: 'structured-review',
      instruction: 'Return structured output',
      structuredOutput: {
        schemaRef: 'structured-review',
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    const state = makeState();
    queueAgentResponse(makeDoneResponse({
      persona: 'structured-review',
      content: '',
      structuredOutput: { result: 'ok' },
    }));
    vi.mocked(needsStatusJudgmentPhase).mockReturnValue(false);
    vi.spyOn(executor, 'persistPreviousResponseSnapshot').mockReturnValue('');

    const result = await executor.runNormalStep(step, state, 'review task', 5, vi.fn());

    expect(result.response.status).toBe('done');
    expect(result.response.structuredOutput).toEqual({ result: 'ok' });
  });
});
