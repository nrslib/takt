import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';

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
import type { SelectorGitCommandRunner } from '../core/workflow/dynamic-parallel/selector-git-command-runner.js';
import {
  makeResponse,
  makeStep,
  makeRule,
  mockRuleEvaluationSequence,
  createTestTmpDir,
  applyDefaultMocks,
  makeResolvedFacetPool,
} from './engine-test-helpers.js';

const emptySelectorGitCommandRunner: SelectorGitCommandRunner = {
  async run() {
    return { output: Buffer.alloc(0), bytes: 0 };
  },
};

function buildDynamicFacetFailureConfig(): WorkflowConfig {
  return {
    name: 'parallel-facet-failure',
    description: 'Test parallel facet selection failures',
    maxSteps: 1,
    initialStep: 'reviewers',
    steps: [{
      name: 'reviewers',
      personaDisplayName: 'reviewers',
      instruction: 'Review',
      parallel: [{
        name: 'security',
        persona: 'security-reviewer',
        personaDisplayName: 'security-reviewer',
        instruction: 'Review security',
        dynamicFacets: { pool: 'security-facets', maxSelected: 1 },
        rules: [makeRule('approved', 'COMPLETE')],
      }],
      rules: [makeRule('all("approved")', 'COMPLETE')],
    }],
    facetPools: {
      'security-facets': makeResolvedFacetPool('security-facets', [
        { id: 'web', content: 'WEB SECURITY FACET' },
        { id: 'cli', content: 'CLI SECURITY FACET' },
      ]),
    },
  };
}

function buildDynamicParallelFixedFacetFailureConfig(): WorkflowConfig {
  const config = buildDynamicFacetFailureConfig();
  const reviewers = config.steps[0]!;
  const fixed = Array.isArray(reviewers.parallel)
    ? reviewers.parallel[0]!
    : reviewers.parallel.fixed[0]!;
  reviewers.parallel = {
    kind: 'dynamic',
    fixed: [fixed],
    pool: [{ ...fixed, name: 'pool-security', description: 'Pool security' }],
    selection: { mode: 'replace' },
  };
  return config;
}

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

  it('should abort dynamic parallel fixed children before any reviewer runs when facet selection fails (DFP-018)', async () => {
    const config = buildDynamicParallelFixedFacetFailureConfig();
    const abortReasons: string[] = [];
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', providerOptions: {} },
      selectorGitCommandRunner: emptySelectorGitCommandRunner,
    });
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    vi.mocked(runAgent).mockImplementation(async (persona, _instruction, options) => {
      if (options?.outputSchema !== undefined) {
        const isFacetSelector = options.internalSystemPrompt?.includes('dynamic facet selector') === true;
        return makeResponse({
          persona: persona ?? 'selector',
          structuredOutput: isFacetSelector
            ? { selected_ids: ['web', 'cli'], rationale: 'invalid overflow' }
            : { selected_ids: ['pool-security'], rationale: 'select the pool child' },
        });
      }
      return makeResponse({ persona: persona ?? 'reviewer', content: 'approved' });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(abortReasons).toHaveLength(1);
    expect(vi.mocked(runAgent).mock.calls.filter(([, , options]) => options?.outputSchema === undefined))
      .toHaveLength(0);
  });

  it('should wait for every facet selector before starting parallel reviewers (DFP-018)', async () => {
    const config = buildDynamicFacetFailureConfig();
    const reviewers = config.steps[0]!;
    const security = Array.isArray(reviewers.parallel)
      ? reviewers.parallel[0]!
      : reviewers.parallel.fixed[0]!;
    reviewers.parallel = [security, { ...security, name: 'cli-security' }];
    let releaseSlowFailure: (() => void) | undefined;
    const slowFailure = new Promise<void>((resolve) => {
      releaseSlowFailure = resolve;
    });
    const reviewerCalls: string[] = [];
    const engine = new WorkflowEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      provider: 'mock',
      selectorProvider: { provider: 'mock', providerOptions: {} },
      selectorGitCommandRunner: emptySelectorGitCommandRunner,
    });
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      if (options?.outputSchema !== undefined) {
        if (instruction.includes('Step:\nsecurity\n')) {
          setImmediate(() => releaseSlowFailure?.());
          return makeResponse({
            persona: persona ?? 'selector',
            structuredOutput: { selected_ids: ['web'], rationale: 'valid selection' },
          });
        }
        await slowFailure;
        return makeResponse({
          persona: persona ?? 'selector',
          structuredOutput: { selected_ids: ['unknown'], rationale: 'delayed invalid selection' },
        });
      }
      reviewerCalls.push(String(persona));
      return makeResponse({ persona: persona ?? 'reviewer', content: 'approved' });
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(reviewerCalls).toEqual([]);
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
    expect(reason).toBe('Claude Code process exited with code 1');
    expect(abortFn.mock.calls[0]![3]).toMatchObject({
      kind: 'step_error',
      step: 'arch-review',
      reason,
      error: 'Claude Code process exited with code 1',
    });

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('error');
    expect(reviewersOutput!.content).toContain(reason);

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
    expect(reason).toBe('Claude Code process exited with code 1');
    expect(abortFn.mock.calls[0]![3]).toMatchObject({
      kind: 'step_error',
      step: 'arch-review',
      reason,
      error: 'Claude Code process exited with code 1',
    });

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.status).toBe('error');
    expect(reviewersOutput!.content).toContain(reason);
    expect(reviewersOutput!.error).toBe('Claude Code process exited with code 1');
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
    expect(reason).toBe('Rate limit exceeded. Please try again later.');

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain(reason);
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

  it('should redact sensitive rejected sub-step error detail from abort reason and failure metadata', async () => {
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
    expect(abortFn.mock.calls[0]![3]).toMatchObject({
      kind: 'step_error',
      step: 'arch-review',
      reason,
      error: 'Provider failed with api_key=[REDACTED] and Authorization: Bearer [REDACTED]',
    });

    const reviewersOutput = state.stepOutputs.get('reviewers');
    expect(reviewersOutput?.error).toBe(
      'Provider failed with api_key=[REDACTED] and Authorization: Bearer [REDACTED]',
    );
    expect(reviewersOutput?.content).not.toContain('top-secret');
    expect(reviewersOutput?.content).not.toContain('sk-secret123456');

    const debugLog = readFileSync(debugLogFile, 'utf-8');
    expect(debugLog).toContain('api_key=[REDACTED]');
    expect(debugLog).toContain('Authorization: Bearer [REDACTED]');
    expect(debugLog).not.toContain('top-secret');
    expect(debugLog).not.toContain('sk-secret123456');
  });

});
