import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';
import type { ProviderType } from '../shared/types/provider.js';
import type { WorkflowEngineOptions } from '../core/workflow/index.js';

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
import { InstructionBuildTransaction } from '../core/workflow/engine/instruction-build-transaction.js';
import { runAgent } from '../agents/runner.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import {
  applyDefaultMocks,
  buildDefaultWorkflowConfig,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';

type RateLimitFallbackEngineOptions = WorkflowEngineOptions & {
  rateLimitFallback?: {
    switchChain: Array<{ provider: ProviderType; model?: string }>;
  };
};

function createEngineOptions(
  tmpDir: string,
  overrides: Partial<RateLimitFallbackEngineOptions> = {},
): RateLimitFallbackEngineOptions {
  return {
    projectCwd: tmpDir,
    provider: 'claude',
    model: 'claude-sonnet',
    ...overrides,
  };
}

function makeRateLimitedResponse(
  provider: ProviderType,
  overrides: Partial<AgentResponse> = {},
): AgentResponse {
  return makeResponse({
    persona: 'plan',
    status: 'rate_limited',
    content: '',
    error: 'Rate limit exceeded. Please try again later.',
    errorKind: 'rate_limit',
    rateLimitInfo: {
      provider,
      detectedAt: new Date('2026-05-13T03:00:00.000Z'),
      source: 'stream_marker',
      resetAtRaw: '2:30pm (Asia/Tokyo)',
    },
    ...overrides,
  } as Partial<AgentResponse>);
}

function singleStepConfig(): WorkflowConfig {
  return buildDefaultWorkflowConfig({
    initialStep: 'plan',
    maxSteps: 3,
    steps: [
      makeStep('plan', {
        rules: [makeRule('continue', 'COMPLETE')],
      }),
    ],
  });
}

function parallelStepConfig(): WorkflowConfig {
  return buildDefaultWorkflowConfig({
    initialStep: 'reviewers',
    maxSteps: 3,
    steps: [
      makeStep('reviewers', {
        parallel: [
          makeStep('arch-review', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
          makeStep('security-review', {
            rules: [makeRule('done', 'COMPLETE')],
          }),
        ],
        rules: [
          makeRule('any("done")', 'COMPLETE'),
        ],
      }),
    ],
  });
}

function teamLeaderStepConfig(): WorkflowConfig {
  return buildDefaultWorkflowConfig({
    initialStep: 'implement',
    maxSteps: 3,
    steps: [
      makeStep('implement', {
        instruction: 'Implement feature',
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxConcurrency: 1,
          maxTotalParts: 20,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('done', 'COMPLETE')],
      }),
    ],
  });
}

function providerCalls(): Array<{ resolvedProvider?: string; resolvedModel?: string; sessionId?: string }> {
  return vi.mocked(runAgent).mock.calls.map((call) => {
    const options = call[2];
    return {
      resolvedProvider: options.resolvedProvider,
      resolvedModel: options.resolvedModel,
      sessionId: options.sessionId,
    };
  });
}

describe('WorkflowEngine rate limit fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('switch_chain がある場合は iteration を二重消費せず同一 step を fallback provider で再実行する', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'codex-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('plan')).toBe(1);
    expect(providerCalls()).toEqual([
      { resolvedProvider: 'claude', resolvedModel: 'claude-sonnet', sessionId: undefined },
      { resolvedProvider: 'codex', resolvedModel: 'gpt-5', sessionId: undefined },
    ]);
    expect(mockRuleEvaluation).toHaveBeenCalledOnce();
  });

  it('runSingleIteration は rate_limited 時に abort せず次回実行を fallback provider に切り替える', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'codex-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const rateLimited = await engine.runSingleIteration();
    const completed = await engine.runSingleIteration();

    // Then
    expect(rateLimited.nextStep).toBe('plan');
    expect(rateLimited.isComplete).toBe(false);
    expect(completed.nextStep).toBe('COMPLETE');
    expect(completed.isComplete).toBe(true);
    expect(engine.getState().status).toBe('completed');
    expect(engine.getState().iteration).toBe(1);
    expect(engine.getState().stepIterations.get('plan')).toBe(1);
    expect(providerCalls()).toEqual([
      { resolvedProvider: 'claude', resolvedModel: 'claude-sonnet', sessionId: undefined },
      { resolvedProvider: 'codex', resolvedModel: 'gpt-5', sessionId: undefined },
    ]);
  });

  it('fallback provider も rate_limited の場合は switch_chain の次 provider を試す', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'codex', model: 'gpt-5' },
          { provider: 'opencode', model: 'opencode/big-pickle' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeRateLimitedResponse('codex'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'opencode-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'opencode']);
    expect(providerCalls().map((call) => call.sessionId)).toEqual([undefined, undefined, undefined]);
    expect(mockRuleEvaluation).toHaveBeenCalledOnce();
  });

  it('switch_chain がすべて rate_limited の場合は同じ provider へ戻らず abort する', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'codex', model: 'gpt-5' },
          { provider: 'opencode', model: 'opencode/big-pickle' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeRateLimitedResponse('codex'),
      makeRateLimitedResponse('opencode'),
    ]);
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('aborted');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'opencode']);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(mockRuleEvaluation).not.toHaveBeenCalled();
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('switch_chain に元 provider が含まれても rate limit 後は元 provider へ戻らない', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'codex', model: 'gpt-5' },
          { provider: 'claude', model: 'claude-sonnet' },
          { provider: 'opencode', model: 'opencode/big-pickle' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeRateLimitedResponse('codex'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'opencode-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'opencode']);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it('switch_chain の同一 provider・別 model は fallback 候補として試す', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'claude', model: 'claude-opus' },
          { provider: 'codex', model: 'gpt-5' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'claude-opus-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls()).toEqual([
      { resolvedProvider: 'claude', resolvedModel: 'claude-sonnet', sessionId: undefined },
      { resolvedProvider: 'claude', resolvedModel: 'claude-opus', sessionId: undefined },
    ]);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('switch_chain の同一 provider は model 省略でも再試行しない', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'claude' },
          { provider: 'codex', model: 'gpt-5' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'codex-session' }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex']);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('switch_chain が未設定の場合は rule 評価に進まず rate_limited として abort する', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
    ]);
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('aborted');
    expect(runAgent).toHaveBeenCalledOnce();
    expect(mockRuleEvaluation).not.toHaveBeenCalled();
    expect(abortFn).toHaveBeenCalledOnce();
    const reason = abortFn.mock.calls[0]?.[1] as string;
    expect(reason).toContain('rate limit');
  });

  it('switch_chain が空配列の場合は fallback せず rate_limited として abort する', async () => {
    // Given
    const engine = new WorkflowEngine(singleStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
    ]);
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('aborted');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude']);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(mockRuleEvaluation).not.toHaveBeenCalled();
    expect(abortFn).toHaveBeenCalledOnce();
  });

  it('fallback notice は retry 1 回だけに注入し次 step へ provider override を持ち越さない', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      maxSteps: 5,
      steps: [
        makeStep('plan', {
          rules: [makeRule('plan done', 'verify')],
        }),
        makeStep('verify', {
          rules: [makeRule('verify done', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    const abortFn = vi.fn();
    engine.on('workflow:abort', abortFn);
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'plan', content: '[STEP:1] plan done', sessionId: 'codex-session' }),
      makeResponse({ persona: 'verify', content: '[STEP:1] verify done', sessionId: 'claude-session' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[0]).not.toContain('Fallback Execution');
    expect(prompts[1]).toContain('Fallback Execution');
    expect(prompts[1]).toContain('claude');
    expect(prompts[1]).toContain('codex');
    expect(prompts[2]).not.toContain('Fallback Execution');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'claude']);
  });

  it('Step B で再度 rate_limited になった場合も独立して fallback を再発火する', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      maxSteps: 5,
      steps: [
        makeStep('plan', {
          rules: [makeRule('plan done', 'verify')],
        }),
        makeStep('verify', {
          rules: [makeRule('verify done', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude', { persona: 'plan' }),
      makeResponse({ persona: 'plan', content: '[STEP:1] plan done', sessionId: 'codex-plan-session' }),
      makeRateLimitedResponse('claude', { persona: 'verify' }),
      makeResponse({ persona: 'verify', content: '[STEP:1] verify done', sessionId: 'codex-verify-session' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
    expect(state.stepIterations.get('plan')).toBe(1);
    expect(state.stepIterations.get('verify')).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'claude', 'codex']);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[1]).toContain('Fallback Execution');
    expect(prompts[3]).toContain('Fallback Execution');
  });

  it('report phase が rate_limited の場合は fallback provider で同一 step を再実行する', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      maxSteps: 3,
      steps: [
        makeStep('plan', {
          outputContracts: [{ name: 'plan.md', format: 'markdown' }],
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'claude-session' }),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'codex-session' }),
    ]);
    vi.mocked(runReportPhase)
      .mockResolvedValueOnce({
        rateLimited: true,
        response: makeRateLimitedResponse('claude', { persona: 'plan' }),
      })
      .mockResolvedValueOnce(undefined);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('plan')).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex']);
    expect(runReportPhase).toHaveBeenCalledTimes(2);
    expect(mockRuleEvaluation).toHaveBeenCalledOnce();
  });

  it('report phase が rate_limited の場合は previous response snapshot に保存しない', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'plan',
      maxSteps: 3,
      steps: [
        makeStep('plan', {
          outputContracts: [{ name: 'plan.md', format: 'markdown' }],
          rules: [makeRule('continue', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'claude-session' }),
      makeResponse({ persona: 'plan', content: '[STEP:1] continue', sessionId: 'codex-session' }),
    ]);
    vi.mocked(runReportPhase)
      .mockResolvedValueOnce({
        rateLimited: true,
        response: makeRateLimitedResponse('claude', { persona: 'plan' }),
      })
      .mockResolvedValueOnce(undefined);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const rateLimited = await engine.runSingleIteration();
    const snapshotAfterRateLimit = engine.getState().previousResponseSourcePath;
    const completed = await engine.runSingleIteration();

    // Then
    expect(rateLimited.nextStep).toBe('plan');
    expect(rateLimited.isComplete).toBe(false);
    expect(snapshotAfterRateLimit).toBeUndefined();
    expect(completed.nextStep).toBe('COMPLETE');
    expect(engine.getState().previousResponseSourcePath).toMatch(
      /^\.takt\/runs\/test-report-dir\/context\/previous_responses\/plan\.1\.\d{8}T\d{6}Z\.md$/,
    );
  });

  it('arpeggio step の fallback 後も次 step へ provider override を持ち越さない', async () => {
    // Given
    const csvPath = join(tmpDir, 'data.csv');
    const templatePath = join(tmpDir, 'template.md');
    writeFileSync(csvPath, 'name\nAlice', 'utf-8');
    writeFileSync(templatePath, 'Process {line:1}', 'utf-8');
    const config = buildDefaultWorkflowConfig({
      initialStep: 'process',
      maxSteps: 5,
      steps: [
        {
          ...makeStep('process', {
            rules: [makeRule('process done', 'verify')],
          }),
          arpeggio: {
            source: 'csv',
            sourcePath: csvPath,
            batchSize: 1,
            concurrency: 1,
            templatePath,
            merge: { strategy: 'concat' },
            maxRetries: 0,
            retryDelayMs: 0,
          },
        },
        makeStep('verify', {
          rules: [makeRule('verify done', 'COMPLETE')],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude'),
      makeResponse({ persona: 'process', content: '[STEP:1] process done', sessionId: 'codex-session' }),
      makeResponse({ persona: 'verify', content: '[STEP:1] verify done', sessionId: 'claude-session' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'claude']);
    expect(providerCalls().map((call) => call.sessionId)).toEqual([undefined, undefined, undefined]);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[0]).not.toContain('Fallback Execution');
    expect(prompts[1]).toContain('Fallback Execution');
    expect(prompts[1]).toContain('claude');
    expect(prompts[1]).toContain('codex');
    expect(prompts[2]).not.toContain('Fallback Execution');
  });

  it('parallel sub-step が rate_limited の場合は all-failed abort ではなく fallback provider で再実行する', async () => {
    const engine = new WorkflowEngine(parallelStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude', { persona: 'arch-review' }),
      makeRateLimitedResponse('claude', { persona: 'security-review' }),
      makeResponse({ persona: 'arch-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('reviewers')).toBe(1);
    expect(state.stepIterations.get('arch-review')).toBe(1);
    expect(state.stepIterations.get('security-review')).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'claude', 'codex', 'codex']);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[0]).not.toContain('Fallback Execution');
    expect(prompts[1]).not.toContain('Fallback Execution');
    expect(prompts[2]).toContain('Fallback Execution');
    expect(prompts[2]).toContain('claude');
    expect(prompts[2]).toContain('codex');
    expect(prompts[2]).toContain('arch-review');
    expect(prompts[2]).toContain('security-review');
    expect(prompts[2]).toContain('Aggregate rules were not evaluated');
    expect(prompts[2]).toContain('Rate limit exceeded. Please try again later.');
    expect(prompts[3]).toContain('Fallback Execution');
    expect(prompts[3]).toContain('claude');
    expect(prompts[3]).toContain('codex');
    expect(prompts[3]).toContain('arch-review');
    expect(prompts[3]).toContain('security-review');
    expect(prompts[3]).toContain('Aggregate rules were not evaluated');
    expect(prompts[3]).toContain('Rate limit exceeded. Please try again later.');
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(mockRuleEvaluation).toHaveBeenCalledTimes(3);
  });

  it('parallel sub-step の rate_limited は別 sub-step の command gate failure より優先して fallback provider で再実行する', async () => {
    // Given
    const gateMarkerPath = join(tmpDir, 'quality-gate-failed-once');
    const config = buildDefaultWorkflowConfig({
      initialStep: 'reviewers',
      maxSteps: 3,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('arch-review', {
              rules: [makeRule('done', 'COMPLETE')],
            }),
            makeStep('security-review', {
              qualityGates: [
                {
                  type: 'command',
                  name: 'security-quality-check',
                  command: `node -e 'const fs=require("fs"); const p=${JSON.stringify(gateMarkerPath)}; if (fs.existsSync(p)) process.exit(0); fs.writeFileSync(p, "failed"); process.exit(1);'`,
                },
              ],
              rules: [makeRule('done', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('any("done")', 'COMPLETE'),
          ],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('claude', { persona: 'arch-review' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'arch-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(existsSync(gateMarkerPath)).toBe(true);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'claude', 'codex', 'codex']);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[2]).toContain('Fallback Execution');
    expect(prompts[3]).toContain('Fallback Execution');
    expect(prompts[2]).not.toContain('Quality gate failed');
    expect(prompts[3]).not.toContain('Quality gate failed');
  });

  it('parallel sub-step の report phase が rate_limited の場合も fallback provider で再実行する', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'reviewers',
      maxSteps: 3,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('arch-review', {
              outputContracts: [{ name: 'arch-review.md', format: 'markdown' }],
              rules: [makeRule('done', 'COMPLETE')],
            }),
            makeStep('security-review', {
              outputContracts: [{ name: 'security-review.md', format: 'markdown' }],
              rules: [makeRule('done', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('any("done")', 'COMPLETE'),
          ],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({ persona: 'arch-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'arch-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
    ]);
    vi.mocked(runReportPhase)
      .mockResolvedValueOnce({
        rateLimited: true,
        response: makeRateLimitedResponse('claude', { persona: 'arch-review' }),
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('reviewers')).toBe(1);
    expect(state.stepIterations.get('arch-review')).toBe(1);
    expect(state.stepIterations.get('security-review')).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'claude', 'codex', 'codex']);
    expect(runReportPhase).toHaveBeenCalledTimes(4);
    expect(mockRuleEvaluation).toHaveBeenCalledTimes(4);
  });

  it('parallel sub-step の provider が親 step と異なる場合は rate limit した sub-step provider を再選択しない', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'reviewers',
      maxSteps: 3,
      steps: [
        makeStep('reviewers', {
          parallel: [
            makeStep('arch-review', {
              provider: 'codex',
              model: 'gpt-5',
              rules: [makeRule('done', 'COMPLETE')],
            }),
            makeStep('security-review', {
              rules: [makeRule('done', 'COMPLETE')],
            }),
          ],
          rules: [
            makeRule('any("done")', 'COMPLETE'),
          ],
        }),
      ],
    });
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [
          { provider: 'codex', model: 'gpt-5' },
          { provider: 'opencode', model: 'opencode/big-pickle' },
        ],
      },
    }));
    mockRunAgentSequence([
      makeRateLimitedResponse('codex', { persona: 'arch-review' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'arch-review', content: '[STEP:1] done' }),
      makeResponse({ persona: 'security-review', content: '[STEP:1] done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['codex', 'claude', 'opencode', 'opencode']);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[2]).toContain('Previous provider/model: codex / gpt-5');
    expect(prompts[2]).toContain('Current provider/model: opencode / opencode/big-pickle');
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(mockRuleEvaluation).toHaveBeenCalledTimes(4);
  });

  it('team_leader の report phase が rate_limited の場合は previous response snapshot に保存しない', async () => {
    // Given
    const config = buildDefaultWorkflowConfig({
      initialStep: 'implement',
      maxSteps: 3,
      steps: [
        makeStep('implement', {
          instruction: 'Implement feature',
          outputContracts: [{ name: 'implement.md', format: 'markdown' }],
          teamLeader: {
            persona: '../personas/team-leader.md',
            maxConcurrency: 1,
            maxTotalParts: 20,
            timeoutMs: 10000,
            partPersona: '../personas/coder.md',
            partAllowedTools: ['Read', 'Edit'],
            partEdit: true,
            partPermissionMode: 'edit',
          },
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    });
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
      onSessionUpdate,
    }));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeResponse({ persona: 'implement.part-1', content: '[STEP:1] done', sessionId: 'part-claude-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeResponse({ persona: 'implement.part-1', content: '[STEP:1] done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
    ]);
    vi.mocked(runReportPhase)
      .mockResolvedValueOnce({
        rateLimited: true,
        response: makeRateLimitedResponse('claude', { persona: 'implement' }),
      })
      .mockResolvedValueOnce(undefined);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const rateLimited = await engine.runSingleIteration();
    const snapshotAfterRateLimit = engine.getState().previousResponseSourcePath;
    const completed = await engine.runSingleIteration();

    // Then
    expect(rateLimited.nextStep).toBe('implement');
    expect(rateLimited.isComplete).toBe(false);
    expect(snapshotAfterRateLimit).toBeUndefined();
    expect(completed.nextStep).toBe('COMPLETE');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual([
      'claude',
      'claude',
      'claude',
      'codex',
      'codex',
      'codex',
    ]);
    expect(engine.getState().previousResponseSourcePath).toMatch(
      /^\.takt\/runs\/test-report-dir\/context\/previous_responses\/implement\.1\.\d{8}T\d{6}Z\.md$/,
    );
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-1:claude', 'part-claude-session');
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-1:claude', undefined);
    expect(runReportPhase).toHaveBeenCalledTimes(2);
    expect(mockRuleEvaluation).toHaveBeenCalledOnce();
  });

  it('team_leader part の rate-limit fallback retry は member iteration と snapshot 名を同じ論理試行に戻す', async () => {
    // Given
    const config = teamLeaderStepConfig();
    const step = config.steps[0];
    if (!step) {
      throw new Error('team leader step is required');
    }
    step.policyContents = ['member policy'];
    const previousTail = 'PREVIOUS_RESPONSE_TAIL: retain the complete review result';
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
      onSessionUpdate,
    }));
    const parts = [
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      { id: 'part-2', title: 'Tests', instruction: 'Add tests' },
    ];
    const fallbackParts = [{ id: 'part-3', title: 'Fallback API', instruction: 'Implement API with fallback' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeRateLimitedResponse('claude', { persona: 'implement.part-1', sessionId: 'part-rate-limited-session' }),
      makeResponse({ persona: 'implement.part-2', content: '[STEP:1] done', sessionId: 'part-success-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts: fallbackParts } }),
      makeResponse({ persona: 'implement.part-3', content: '[STEP:1] done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const previousResponse = makeResponse({ persona: 'review', content: `${'x'.repeat(2500)}\n${previousTail}` });
    const initialState = engine.getState();
    initialState.stepOutputs.set('review', previousResponse);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T01:02:03.000Z'));

    // When
    const rateLimited = await engine.runSingleIteration();
    const stateAfterRateLimit = engine.getState();
    expect(rateLimited.nextStep).toBe('implement');
    expect(stateAfterRateLimit.lastOutput).toBeUndefined();
    expect([...stateAfterRateLimit.stepOutputs.keys()]).toEqual(['review']);
    expect(stateAfterRateLimit.personaSessions).toEqual(new Map());
    expect(stateAfterRateLimit.stepIterations).toEqual(new Map());
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-1:claude', 'part-rate-limited-session');
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-2:claude', 'part-success-session');
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-1:claude', undefined);
    expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-2:claude', undefined);
    vi.setSystemTime(new Date('2026-06-20T01:02:04.000Z'));
    const completed = await engine.runSingleIteration();
    const state = engine.getState();

    // Then
    expect(completed.nextStep).toBe('COMPLETE');
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual([
      'claude',
      'claude',
      'claude',
      'claude',
      'codex',
      'codex',
      'codex',
    ]);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[0]).toContain(previousTail);
    expect(prompts[1]).not.toContain('Fallback Execution');
    expect(prompts[1]).toContain('Step Iteration: 1(times this step has run)');
    expect(prompts[5]).toContain('Fallback Execution');
    expect(prompts[5]).toContain('Previous provider/model: claude / claude-sonnet');
    expect(prompts[5]).toContain('Current provider/model: codex / gpt-5');
    expect(prompts[5]).toContain('Implement API with fallback');
    expect(prompts[5]).toContain('Step Iteration: 1(times this step has run)');
    expect(prompts[4]).toContain(previousTail);
    const policySnapshots = readdirSync(join(tmpDir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'))
      .filter((file) => file.startsWith('implement-part-'));
    expect(policySnapshots).toEqual(['implement-part-3.1.20260620T010204Z.md']);
    expect(runAgent).toHaveBeenCalledTimes(7);
    expect(mockRuleEvaluation).toHaveBeenCalledOnce();
  });

  it('team_leader part の rate-limit rollback は既存 part session の上書きを外部にも復元する', async () => {
    // Given
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine(teamLeaderStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      initialSessions: { 'implement.part-1:claude': 'part-original-session' },
      onSessionUpdate,
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeRateLimitedResponse('claude', { persona: 'implement.part-1', sessionId: 'part-attempt-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
    ]);

    // When
    const result = await engine.runSingleIteration();

    // Then
    expect(result.nextStep).toBe('implement');
    expect(engine.getState().personaSessions.get('implement.part-1:claude')).toBe('part-original-session');
    expect(onSessionUpdate).toHaveBeenNthCalledWith(1, 'implement.part-1:claude', 'part-attempt-session');
    expect(onSessionUpdate).toHaveBeenNthCalledWith(2, 'implement.part-1:claude', 'part-original-session');
  });

  it('team_leader part の rollback callback が throw しても後続 session と non-session state を復元する', async () => {
    // Given
    const onSessionUpdate = vi.fn((key: string, sessionId: string | undefined) => {
      if (key === 'implement.part-1:claude' && sessionId === undefined) {
        throw new Error('session rollback callback failed');
      }
    });
    const engine = new WorkflowEngine(teamLeaderStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
      onSessionUpdate,
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'team-leader',
        structuredOutput: {
          parts: [
            { id: 'part-1', title: 'API', instruction: 'Implement API' },
            { id: 'part-2', title: 'Tests', instruction: 'Add tests' },
          ],
        },
      }),
      makeRateLimitedResponse('claude', { persona: 'implement.part-1', sessionId: 'part-1-attempt-session' }),
      makeResponse({ persona: 'implement.part-2', content: '[STEP:1] done', sessionId: 'part-2-attempt-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: { done: true, reasoning: 'enough', parts: [] } }),
    ]);

    // When
    await expect(engine.runSingleIteration()).rejects.toBeInstanceOf(AggregateError);

    // Then
    const state = engine.getState();
    expect(onSessionUpdate).toHaveBeenNthCalledWith(1, 'implement.part-1:claude', 'part-1-attempt-session');
    expect(onSessionUpdate).toHaveBeenNthCalledWith(2, 'implement.part-2:claude', 'part-2-attempt-session');
    expect(onSessionUpdate).toHaveBeenNthCalledWith(3, 'implement.part-1:claude', undefined);
    expect(onSessionUpdate).toHaveBeenNthCalledWith(4, 'implement.part-2:claude', undefined);
    expect(state.personaSessions).toEqual(new Map());
    expect(state.lastOutput).toBeUndefined();
    expect(state.pendingFallback).toBeUndefined();
    expect(state.stepOutputs).toEqual(new Map());
    expect(state.stepIterations).toEqual(new Map());
  });

  it('instruction rollback が throw しても session と non-session state の補償を試行する', async () => {
    // Given
    const onSessionUpdate = vi.fn();
    const rollback = vi.spyOn(InstructionBuildTransaction.prototype, 'rollback')
      .mockImplementationOnce(() => {
        throw new Error('instruction rollback failed');
      });
    const engine = new WorkflowEngine(teamLeaderStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
      onSessionUpdate,
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'team-leader',
        structuredOutput: { parts: [{ id: 'part-1', title: 'API', instruction: 'Implement API' }] },
      }),
      makeRateLimitedResponse('claude', { persona: 'implement.part-1', sessionId: 'part-attempt-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: { done: true, reasoning: 'enough', parts: [] } }),
    ]);

    try {
      // When
      await expect(engine.runSingleIteration()).rejects.toBeInstanceOf(AggregateError);

      // Then
      const state = engine.getState();
      expect(onSessionUpdate).toHaveBeenCalledWith('implement.part-1:claude', undefined);
      expect(state.personaSessions).toEqual(new Map());
      expect(state.lastOutput).toBeUndefined();
      expect(state.pendingFallback).toBeUndefined();
      expect(state.stepOutputs).toEqual(new Map());
      expect(state.stepIterations).toEqual(new Map());
    } finally {
      rollback.mockRestore();
    }
  });

  it('team_leader part の fallback retry では auto routing が fallback provider を上書きしない', async () => {
    // Given
    const config = teamLeaderStepConfig();
    const step = config.steps[0];
    if (!step?.teamLeader) {
      throw new Error('teamLeader configuration is required');
    }
    step.teamLeader.partTags = ['implementation'];
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoRouting: {
        strategy: 'balanced',
        router: {
          provider: 'claude-sdk',
          model: 'claude-haiku-4-5-20251001',
        },
        candidates: [
          {
            name: 'balanced-claude',
            description: 'Default team leader execution',
            provider: 'claude',
            model: 'claude-sonnet',
            costTier: 'medium',
          },
        ],
        rules: {
          tags: {
            implementation: 'balanced-claude',
          },
          steps: {
            implement: 'balanced-claude',
          },
        },
      },
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeRateLimitedResponse('claude', { persona: 'implement.part-1' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeResponse({ persona: 'implement.part-1', content: '[STEP:1] done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual([
      'claude',
      'claude',
      'claude',
      'codex',
      'codex',
      'codex',
    ]);
    expect(providerCalls()[4]).toMatchObject({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
    });
  });

  it('team_leader part が leader と異なる provider で rate_limited の場合は part provider を fallback 判定に使う', async () => {
    // Given
    const engine = new WorkflowEngine(teamLeaderStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
      personaProviders: {
        '../personas/coder.md': { provider: 'opencode', model: 'opencode/big-pickle' },
      },
      rateLimitFallback: {
        switchChain: [
          { provider: 'opencode', model: 'opencode/big-pickle' },
          { provider: 'codex', model: 'gpt-5' },
        ],
      },
    }));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeRateLimitedResponse('opencode', { persona: 'implement.part-1' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeResponse({ persona: 'implement.part-1', content: '[STEP:1] done' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback }),
    ]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual([
      'claude',
      'opencode',
      'claude',
      'codex',
      'codex',
      'codex',
    ]);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[4]).toContain('Previous provider/model: opencode / opencode/big-pickle');
    expect(prompts[4]).toContain('Current provider/model: codex / gpt-5');
  });
});
