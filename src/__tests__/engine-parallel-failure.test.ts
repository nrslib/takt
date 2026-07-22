import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
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

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { runStatusJudgmentPhase } from '../core/workflow/phase-runner.js';
import { StructuredOutputSchemaError } from '../core/workflow/engine/structured-output-schema-validator.js';
import { initDebugLogger, resetDebugLogger } from '../shared/utils/index.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';

function buildParallelOnlyConfig(): WorkflowConfig {
  return {
    name: 'test-parallel-failure',
    description: 'Test parallel failure handling',
    maxSteps: 10,
    initialStep: 'reviewers',
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            rules: [
              makeRule('approved', 'COMPLETE'),
              makeRule('needs_fix', 'fix'),
            ],
          }),
          makeStep('security-review', {
            rules: [
              makeRule('approved', 'COMPLETE'),
              makeRule('needs_fix', 'fix'),
            ],
          }),
        ],
        rules: [
          makeRule('all("approved")', 'done'),
          makeRule('any("needs_fix")', 'fix'),
        ],
      }),
      makeStep('done', {
        rules: [
          makeRule('completed', 'COMPLETE'),
        ],
      }),
      makeStep('fix', {
        rules: [
          makeRule('fixed', 'reviewers'),
        ],
      }),
    ],
  };
}

describe('WorkflowEngine Integration: Parallel Step Partial Failure', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    resetDebugLogger();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should retry a sub-step once with a fresh session when the provider errors', async () => {
    const config = buildParallelOnlyConfig();
    const delegatedAgentUsage = vi.fn();
    const providerStream = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      model: 'retry-model',
      onDelegatedAgentUsage: delegatedAgentUsage,
      onProviderStream: providerStream,
    });

    const mock = vi.mocked(runAgent);
    const archAttemptsAtRetryStart = vi.fn();
    const nextArchResponse = vi.fn<(persona: Parameters<typeof runAgent>[0]) => AgentResponse>()
      .mockImplementationOnce((persona) => makeResponse({
        persona,
        status: 'error',
        content: '',
        error: 'assistant message cycle budget exceeded',
        providerUsage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          usageMissing: false,
        },
      }))
      .mockImplementationOnce((persona) => {
        archAttemptsAtRetryStart(delegatedAgentUsage.mock.calls.filter(([context]) => (
          context.step === 'arch-review'
        )).length);
        return makeResponse({
          persona,
          content: 'approved',
          providerUsage: {
            inputTokens: 11,
            outputTokens: 5,
            totalTokens: 16,
            usageMissing: false,
          },
        });
      });
    mock.mockImplementation(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      options?.onStream?.({
        type: 'init',
        data: { model: options.resolvedModel ?? '(default)', sessionId: `session-${String(persona)}` },
      });
      if (String(persona).includes('arch-review')) {
        return nextArchResponse(persona);
      }
      return makeResponse({ persona: String(persona), content: 'approved' });
    });

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' }, // arch-review（再試行後）→ approved
      { index: 0, method: 'phase3_tag' }, // security-review → approved
      { index: 0, method: 'aggregate' },  // 親 reviewers → done
      { index: 0, method: 'phase3_tag' }, // done → COMPLETE
    ]);

    const state = await engine.run();
    const archRunCalls = mock.mock.calls.filter(([persona]) => String(persona).includes('arch-review'));

    // 1席の一過性エラーで走行が落ちず、再試行で完走する
    expect(state.status).toBe('completed');
    expect(nextArchResponse).toHaveBeenCalledTimes(2);
    expect(archRunCalls).toHaveLength(2);
    // 再試行は resume を切った新しいセッションで行われる
    expect(archRunCalls[1]?.[2]?.sessionId).toBeUndefined();
    expect(archAttemptsAtRetryStart).toHaveBeenCalledWith(1);
    expect(delegatedAgentUsage.mock.calls
      .filter(([context]) => context.step === 'arch-review')
      .map(([context, result]) => ({
        ...context,
        success: result.success,
        totalTokens: result.usage?.totalTokens,
      }))).toEqual([
      {
        step: 'arch-review',
        stepType: 'parallel',
        provider: 'mock',
        providerModel: 'retry-model',
        success: false,
        totalTokens: 10,
      },
      {
        step: 'arch-review',
        stepType: 'parallel',
        provider: 'mock',
        providerModel: 'retry-model',
        success: true,
        totalTokens: 16,
      },
    ]);
    expect(providerStream.mock.calls
      .map(([context]) => context)
      .filter((event) => event.step === 'arch-review')).toEqual([
      { step: 'arch-review', provider: 'mock', providerModel: 'retry-model' },
      { step: 'arch-review', provider: 'mock', providerModel: 'retry-model' },
    ]);
  });

  it('should invalidate only the exhausted parallel sub-step session', async () => {
    const config = buildParallelOnlyConfig();
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      onSessionUpdate,
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: String(persona),
        userInstruction: instruction,
      });
      if (String(persona).includes('arch-review')) {
        return makeResponse({ persona: String(persona), content: 'unclear', sessionId: 'arch-session' });
      }
      return makeResponse({ persona: String(persona), content: 'approved', sessionId: 'security-session' });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => {
      if (step.name === 'arch-review') {
        throw new RuleDetectionExhaustedError('arch-review');
      }
      return { index: 0, method: 'phase3_tag' };
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.personaSessions.has('../personas/arch-review.md:mock')).toBe(false);
    expect(state.personaSessions.get('../personas/security-review.md:mock')).toBe('security-session');
    expect(onSessionUpdate).toHaveBeenCalledWith('../personas/arch-review.md:mock', undefined);
  });

  it('should keep a newer sibling session when a shared session key later exhausts rule detection', async () => {
    const config = buildParallelOnlyConfig();
    const reviewers = config.steps[0]!;
    reviewers.parallel = [
      makeStep('stale-review', {
        persona: 'coder',
        rules: [makeRule('approved', 'COMPLETE')],
      }),
      makeStep('fresh-review', {
        persona: 'coder',
        rules: [makeRule('approved', 'COMPLETE')],
      }),
    ];
    reviewers.rules = [makeRule('all("approved")', 'COMPLETE')];
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      initialSessions: { 'coder:mock': 'session-old' },
      onSessionUpdate,
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      if (instruction.includes('stale-review')) {
        return makeResponse({ persona: String(persona), content: 'unclear', sessionId: 'session-old' });
      }
      return makeResponse({ persona: String(persona), content: 'approved', sessionId: 'session-newer' });
    });
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'stale-review') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { label: 'approved', method: 'phase3_tag' };
      }
      return { label: 'approved', method: 'phase3_tag' };
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => {
      if (step.name === 'stale-review') {
        throw new RuleDetectionExhaustedError('stale-review');
      }
      return { index: 0, method: 'phase3_tag' };
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.personaSessions.get('coder:mock')).toBe('session-newer');
    expect(onSessionUpdate).not.toHaveBeenCalledWith('coder:mock', undefined);
  });

  it('should abort with parent error when one sub-step rejects and another approves', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[SECURITY-REVIEW:1] approved' });
    });

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('Step "reviewers" failed');
    expect(reason).toContain('arch-review');
    expect(reason).toContain('Claude Code process exited with code 1');
    expect(reason).not.toContain('Status not found for step "reviewers"');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('error');
    expect(reviewersOutput!.content).toContain('arch-review');
    expect(reviewersOutput!.content).toContain('status: error');
    expect(reviewersOutput!.content).toContain('failureCategory: none');
    expect(reviewersOutput!.content).toContain('Claude Code process exited with code 1');
    expect(reviewersOutput!.content).toContain('aggregate');

    const archReviewOutput = state.stepOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.status).toBe('error');
    expect(archReviewOutput!.error).toContain('exit');

    const securityReviewOutput = state.stepOutputs.get('security-review');
    expect(securityReviewOutput).toBeDefined();
    expect(securityReviewOutput!.status).toBe('done');
  });

  it('should report all rejected sub-step errors through the parent error response', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));
    mock.mockRejectedValueOnce(new Error('Claude Code process exited with code 1'));

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('Step "reviewers" failed');
    expect(reason).toContain('arch-review');
    expect(reason).toContain('security-review');
    expect(reason).not.toContain('All parallel sub-steps failed');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('error');
    expect(reviewersOutput!.content).toContain('arch-review');
    expect(reviewersOutput!.content).toContain('security-review');
    expect(reviewersOutput!.content).toContain('status: error');
  });

  it('should preserve rejected sub-step error detail in the parent diagnostic', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Rate limit exceeded. Please try again later.'));
    mock.mockRejectedValueOnce(new Error('Rate limit exceeded. Please try again later.'));

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('Rate limit exceeded. Please try again later.');
    expect(reason).not.toContain('Status not found for step "reviewers"');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('Rate limit exceeded. Please try again later.');
  });

  it('should record failed sub-step error message in stepOutputs', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Session resume failed'));
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[SECURITY-REVIEW:1] approved' });
    });

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    const archReviewOutput = state.stepOutputs.get('arch-review');
    expect(archReviewOutput).toBeDefined();
    expect(archReviewOutput!.error).toBe('Session resume failed');
    expect(archReviewOutput!.content).toBe('');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('error');
    expect(reviewersOutput!.error).toContain('Session resume failed');
  });

  it('should redact sensitive rejected sub-step error detail from parent abort reason', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
    const debugLogFile = join(tmpDir, 'parallel-debug.log');
    initDebugLogger({ enabled: true, logFile: debugLogFile }, tmpDir);

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Provider failed with api_key=top-secret and Authorization: Bearer sk-secret123456'));
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[SECURITY-REVIEW:1] approved' });
    });

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]![1] as string;
    expect(reason).toContain('api_key=[REDACTED]');
    expect(reason).toContain('Authorization: Bearer [REDACTED]');
    expect(reason).not.toContain('top-secret');
    expect(reason).not.toContain('sk-secret123456');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput?.error).toBe(reviewersOutput?.content);
    expect(reviewersOutput?.content).not.toContain('top-secret');
    expect(reviewersOutput?.content).not.toContain('sk-secret123456');

    const debugLog = readFileSync(debugLogFile, 'utf-8');
    expect(debugLog).toContain('api_key=[REDACTED]');
    expect(debugLog).toContain('Authorization: Bearer [REDACTED]');
    expect(debugLog).not.toContain('top-secret');
    expect(debugLog).not.toContain('sk-secret123456');
  });

  it('should promote a blocked sub-step to blocked parent response', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({
        persona: 'arch-review',
        status: 'blocked',
        content: 'Need user clarification before review can continue',
      });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[SECURITY-REVIEW:1] approved' });
    });

    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);

    const blockedFn = vi.fn();
    const abortFn = vi.fn();
    engine.on('step:blocked', blockedFn);
    engine.on('workflow:abort', abortFn);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(blockedFn).toHaveBeenCalledOnce();
    expect(abortFn).toHaveBeenCalledOnce();

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('blocked');
    expect(reviewersOutput!.content).toContain('arch-review');
    expect(reviewersOutput!.content).toContain('status: blocked');
    expect(reviewersOutput!.content).toContain('failureCategory: none');
    expect(reviewersOutput!.content).toContain('Need user clarification before review can continue');
    expect(reviewersOutput!.content).toContain('aggregate');
    expect(state.previousResponseSourcePath).toMatch(
      /^\.takt\/runs\/test-report-dir\/context\/previous_responses\/reviewers\.1\.\d{8}T\d{6}Z\.md$/,
    );
    const snapshot = readFileSync(join(tmpDir, state.previousResponseSourcePath!), 'utf-8');
    expect(snapshot).toBe(reviewersOutput!.content);
  });

  it('should abort when sub-step phase3 throws instead of falling back to phase1 tags', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'arch-review') {
        throw new Error('Phase 3 failed for arch-review');
      }
      return { label: '', method: 'auto_select' };
    });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'arch-review', content: '[STEP:1] done' });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'security-review', content: '[STEP:1] done' });
    });
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return makeResponse({ persona: 'done', content: 'completed' });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.stepOutputs.get('arch-review')?.status).toBe('error');
    expect(vi.mocked(mockRuleEvaluation).mock.calls.some(([step]) => step.name === 'arch-review')).toBe(false);
  });

  it('should fail the parallel boundary on a sub-step Phase 3 schema error instead of using a matching Phase 1 tag', async () => {
    const config = buildParallelOnlyConfig();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
    vi.mocked(runStatusJudgmentPhase).mockImplementation(async (step) => {
      if (step.name === 'arch-review') {
        throw new StructuredOutputSchemaError('Structured output schema is invalid');
      }
      return { label: '', method: 'auto_select' };
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return makeResponse({ persona: String(persona), content: '[ARCH-REVIEW:1] approved' });
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(runStatusJudgmentPhase).toHaveBeenCalled();
    expect(
      vi.mocked(mockRuleEvaluation).mock.calls.some(([step]) => step.name === 'arch-review'),
    ).toBe(false);
  });
});
