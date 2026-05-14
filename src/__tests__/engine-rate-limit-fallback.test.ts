import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';
import type { ProviderType } from '../shared/types/provider.js';
import type { WorkflowEngineOptions } from '../core/workflow/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import { detectMatchedRule } from '../core/workflow/evaluation/index.js';
import { runReportPhase } from '../core/workflow/phase-runner.js';
import {
  applyDefaultMocks,
  buildDefaultWorkflowConfig,
  createTestTmpDir,
  makeResponse,
  makeRule,
  makeStep,
  mockDetectMatchedRuleSequence,
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
    status: 'rate_limited' as never,
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
          makeRule('any("done")', 'COMPLETE', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'done',
          }),
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
          maxParts: 1,
          refillThreshold: 0,
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    expect(detectMatchedRule).toHaveBeenCalledOnce();
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex', 'opencode']);
    expect(providerCalls().map((call) => call.sessionId)).toEqual([undefined, undefined, undefined]);
    expect(detectMatchedRule).toHaveBeenCalledOnce();
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
    expect(detectMatchedRule).not.toHaveBeenCalled();
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    expect(detectMatchedRule).not.toHaveBeenCalled();
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
    expect(detectMatchedRule).not.toHaveBeenCalled();
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('plan')).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual(['claude', 'codex']);
    expect(runReportPhase).toHaveBeenCalledTimes(2);
    expect(detectMatchedRule).toHaveBeenCalledOnce();
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    // Given
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[0]).not.toContain('Fallback Execution');
    expect(prompts[1]).not.toContain('Fallback Execution');
    expect(prompts[2]).toContain('Fallback Execution');
    expect(prompts[2]).toContain('claude');
    expect(prompts[2]).toContain('codex');
    expect(prompts[3]).toContain('Fallback Execution');
    expect(prompts[3]).toContain('claude');
    expect(prompts[3]).toContain('codex');
    expect(runAgent).toHaveBeenCalledTimes(4);
    expect(detectMatchedRule).toHaveBeenCalledTimes(3);
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
            makeRule('any("done")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'any',
              aggregateConditionText: 'done',
            }),
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    expect(detectMatchedRule).toHaveBeenCalledTimes(4);
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
            makeRule('any("done")', 'COMPLETE', {
              isAggregateCondition: true,
              aggregateType: 'any',
              aggregateConditionText: 'done',
            }),
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    expect(detectMatchedRule).toHaveBeenCalledTimes(4);
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
            maxParts: 1,
            refillThreshold: 0,
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
    const engine = new WorkflowEngine(config, tmpDir, 'test task', createEngineOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    mockRunAgentSequence([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts } }),
      makeResponse({ persona: 'implement.part-1', content: '[STEP:1] done' }),
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    expect(runReportPhase).toHaveBeenCalledTimes(2);
    expect(detectMatchedRule).toHaveBeenCalledOnce();
  });

  it('team_leader part が rate_limited の場合は fallback retry の part prompt に fallback notice を注入する', async () => {
    // Given
    const engine = new WorkflowEngine(teamLeaderStepConfig(), tmpDir, 'test task', createEngineOptions(tmpDir, {
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(providerCalls().map((call) => call.resolvedProvider)).toEqual([
      'claude',
      'claude',
      'claude',
      'codex',
      'codex',
      'codex',
    ]);
    const prompts = vi.mocked(runAgent).mock.calls.map((call) => call[1]);
    expect(prompts[1]).not.toContain('Fallback Execution');
    expect(prompts[4]).toContain('Fallback Execution');
    expect(prompts[4]).toContain('Previous provider/model: claude / claude-sonnet');
    expect(prompts[4]).toContain('Current provider/model: codex / gpt-5');
    expect(prompts[4]).toContain('Implement API');
    expect(runAgent).toHaveBeenCalledTimes(6);
    expect(detectMatchedRule).toHaveBeenCalledOnce();
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
