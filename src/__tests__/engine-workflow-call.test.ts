import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

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

vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/workflow/phase-runner.js')>()),
  runReportPhase: vi.fn(),
  runStatusJudgmentPhase: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { runAgent } from '../agents/runner.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import {
  applyWorkflowCallOverridesToPersonaProviders,
  applyWorkflowCallOverridesToProviderRouting,
} from '../core/workflow/engine/WorkflowCallExecutor.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeRule,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import type {
  WorkflowConfig,
} from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import type { RoutingDecisionEvent } from '../features/analytics/index.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';

import {
  createOwnedResumePoint,
  createParentWorkflow,
  createWorkflowCallAutoRoutingConfig,
  createWorkflowCallOptions,
  createWorkflowCallProgressDeps,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

describe('WorkflowEngine workflow_call integration', () => {
  let tmpDir: string;
  let cleanupDirs: string[];
  let engine: WorkflowEngine | null = null;
  const originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
    execFileSync('git', ['init', '--quiet'], { cwd: tmpDir });
    execFileSync('git', [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      'commit', '--quiet', '--allow-empty', '-m', 'baseline',
    ], { cwd: tmpDir });
    cleanupDirs = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    resetAnalyticsWriter();
    if (engine) {
      cleanupWorkflowEngine(engine);
      engine = null;
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未到達の workflow_call は engine 構築時にも実行時にも解決しない', async () => {
    const onEffectiveAutoRoutingReached = vi.fn();
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-unreachable-child',
      initial_step: 'finish',
      max_steps: 2,
      steps: [
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish without delegation',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'unreachable-child',
          kind: 'workflow_call',
          call: 'child-that-must-not-load',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });
    const workflowCallResolver = vi.fn(() => {
      throw new Error('unreachable resolver invoked');
    });

    engine = new WorkflowEngine(config, tmpDir, 'Finish directly', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
      autoStrategyOverride: 'performance',
      onEffectiveAutoRoutingReached,
    }));
    expect(workflowCallResolver).not.toHaveBeenCalled();
    mockPersonaResponses({ finisher: 'done' });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'phase3_tag' });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(workflowCallResolver).not.toHaveBeenCalled();
    expect(onEffectiveAutoRoutingReached).not.toHaveBeenCalled();
  });

  it('strategy override がない場合は到達した child 内の未到達 workflow_call を解決しない', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-child-that-finishes-directly',
      initial_step: 'call-child',
      max_steps: 3,
      steps: [{
        name: 'call-child',
        kind: 'workflow_call',
        call: 'child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    const childConfig: WorkflowConfig = {
      name: 'child',
      provider: 'mock',
      subworkflow: { callable: true },
      initialStep: 'finish-child',
      steps: [
        {
          name: 'finish-child',
          persona: 'child-finisher',
          instruction: 'Finish child without delegation',
          rules: [makeRule('done', 'COMPLETE')],
        },
        {
          name: 'unreachable-grandchild',
          kind: 'workflow_call',
          call: 'grandchild-that-must-not-load',
          rules: [makeRule('COMPLETE', 'COMPLETE')],
        },
      ],
    };
    const workflowCallResolver = vi.fn((input: Parameters<WorkflowCallResolver>[0]) => {
      if (input.step.call === 'child') {
        return childConfig;
      }
      throw new Error('unreachable grandchild resolver invoked');
    });

    engine = new WorkflowEngine(config, tmpDir, 'Run child directly', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
    }));
    mockPersonaResponses({ 'child-finisher': 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(workflowCallResolver).toHaveBeenCalledOnce();
    expect(workflowCallResolver.mock.calls[0]?.[0].step.call).toBe('child');
  });

  it('到達した workflow_call は実行時に解決し resolver 例外を伝播する', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-with-broken-child',
      initial_step: 'call-child',
      max_steps: 1,
      steps: [{
        name: 'call-child',
        kind: 'workflow_call',
        call: 'missing-child',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    const workflowCallResolver = vi.fn(() => {
      throw new Error('resolver boom');
    });
    const workflowAborted = vi.fn();

    engine = new WorkflowEngine(config, tmpDir, 'Resolve child at runtime', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
    }));
    engine.on('workflow:abort', workflowAborted);
    expect(workflowCallResolver).not.toHaveBeenCalled();

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('call-child')).toBe(1);
    expect(workflowCallResolver).toHaveBeenCalledOnce();
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringContaining('resolver boom'),
    ]);
  });

  it('workflow_call concrete provider override replaces child provider entries and clears stale models', () => {
    const personaProviders = applyWorkflowCallOverridesToPersonaProviders({
      reviewer: {
        provider: 'mock',
        model: 'child-review-model',
      },
    }, { provider: 'claude' });
    const providerRouting = applyWorkflowCallOverridesToProviderRouting({
      steps: {
        review: {
          provider: 'mock',
          model: 'child-step-model',
        },
      },
      tags: {
        implementation: {
          provider: 'codex',
          model: 'gpt-5',
        },
      },
    }, { provider: 'claude' });

    expect(personaProviders).toEqual({
      reviewer: {
        provider: 'claude',
      },
    });
    expect(providerRouting).toEqual({
      personas: undefined,
      steps: {
        review: {
          provider: 'claude',
        },
      },
      tags: {
        implementation: {
          provider: 'claude',
        },
      },
    });
  });

  it.each([
    {
      name: 'provider only',
      options: {
        provider: 'codex',
        providerSource: 'cli',
        model: 'mock/parent-model',
        modelSource: 'project',
      },
      expected: {
        provider: 'codex',
        providerSource: 'cli',
        model: 'claude/workflow-call-model',
        modelSource: 'workflow_call',
      },
    },
    {
      name: 'model only',
      options: {
        provider: 'mock',
        providerSource: 'project',
        model: 'codex/cli-model',
        modelSource: 'cli',
      },
      expected: {
        provider: 'claude',
        providerSource: 'workflow_call',
        model: 'codex/cli-model',
        modelSource: 'cli',
      },
    },
    {
      name: 'provider and model',
      options: {
        provider: 'codex',
        providerSource: 'cli',
        model: 'codex/cli-model',
        modelSource: 'cli',
      },
      expected: {
        provider: 'codex',
        providerSource: 'cli',
        model: 'codex/cli-model',
        modelSource: 'cli',
      },
    },
  ] as const)('preserves CLI $name over workflow_call overrides through child engine execution', async ({ options, expected }) => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'takt/coding',
        overrides: { provider: 'claude', model: 'claude/workflow-call-model' },
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    const childConfig: WorkflowConfig = {
      name: 'takt/coding',
      subworkflow: { callable: true },
      initialStep: 'child-step',
      steps: [{
        name: 'child-step',
        personaDisplayName: 'Child',
        instruction: 'Run child',
        rules: [makeRule('done', 'COMPLETE')],
      }],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'child-step',
          iteration: 1,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'child-step', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Preserve CLI workflow_call overrides',
      getOptions: () => createWorkflowCallOptions(tmpDir, options),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });
    const step = parentConfig.steps[0] as never;

    await runner.run(step);

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Preserve CLI workflow_call overrides',
      expect.objectContaining(expected),
    );
  });

  it('workflow_call concrete provider and model override wins over child and inherited auto_routing defaults', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: { provider: 'mock', model: 'workflow-call-model' },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'takt/coding',
      provider: 'claude',
      model: 'child-top-level-model',
      autoRouting: createWorkflowCallAutoRoutingConfig(),
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [makeRule('done', 'COMPLETE')],
        },
      ],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 1,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Preserve auto workflow_call models',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        provider: 'codex',
        model: 'parent-runtime-model',
        autoRouting: createWorkflowCallAutoRoutingConfig(),
      }),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig as never,
      createEngine,
    });
    const step = parentConfig.steps[0] as never;

    await runner.run(step);

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Preserve auto workflow_call models',
      expect.objectContaining({
        provider: 'mock',
        model: 'workflow-call-model',
        autoRouting: createWorkflowCallAutoRoutingConfig(),
      }),
    );
  });

  it('子 workflow の最終出力を親 step の previous_response に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'final_review',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'final_review',
          persona: 'supervisor',
          instruction: 'Review child output:\n{previous_response}',
          rules: [
            {
              condition: 'approved',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Child review complete',
      supervisor: 'approved',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Implement workflow composition', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const finalPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(finalPrompt).toContain('Child review complete');
  });

  it('子 workflow の step:rate_limited イベントを親 engine に中継する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Relay rate limit', createWorkflowCallOptions(tmpDir));
    const rateLimited = makeResponse({
      persona: 'reviewer',
      status: 'rate_limited',
      content: '',
      error: 'Rate limit exceeded. Please try again later.',
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'mock',
        detectedAt: new Date('2026-05-13T03:00:00.000Z'),
        source: 'sdk_error',
      },
    } as Partial<ReturnType<typeof makeResponse>>);
    mockRunAgentSequence([rateLimited]);
    const onRateLimited = vi.fn();
    engine.on('step:rate_limited', onRateLimited);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(onRateLimited).toHaveBeenCalledOnce();
    expect(onRateLimited.mock.calls[0]?.[0]).toMatchObject({ name: 'limited' });
    expect(onRateLimited.mock.calls[0]?.[1]).toMatchObject({ status: 'rate_limited' });
  });

  it('workflow_call 子 workflow の空 switch_chain は親 fallback を継承しない', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
rate_limit_fallback:
  switch_chain: []
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Child disables fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'claude-sonnet',
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'reviewer',
        status: 'rate_limited',
        content: '',
        error: 'Rate limit exceeded. Please try again later.',
        errorKind: 'rate_limit',
        rateLimitInfo: {
          provider: 'claude',
          detectedAt: new Date('2026-05-13T03:00:00.000Z'),
          source: 'sdk_error',
        },
      } as Partial<ReturnType<typeof makeResponse>>),
      makeResponse({ persona: 'reviewer', content: 'done' }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProvider).toBe('claude');
  });

  it('workflow_call 子 workflow の rate_limit_fallback 空オブジェクトは親 fallback を継承しない', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
subworkflow:
  callable: true
rate_limit_fallback: {}
initial_step: limited
steps:
  - name: limited
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Child disables fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'claude-sonnet',
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));
    mockRunAgentSequence([
      makeResponse({
        persona: 'reviewer',
        status: 'rate_limited',
        content: '',
        error: 'Rate limit exceeded. Please try again later.',
        errorKind: 'rate_limit',
        rateLimitInfo: {
          provider: 'claude',
          detectedAt: new Date('2026-05-13T03:00:00.000Z'),
          source: 'sdk_error',
        },
      } as Partial<ReturnType<typeof makeResponse>>),
      makeResponse({ persona: 'reviewer', content: 'done' }),
    ]);

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]?.resolvedProvider).toBe('claude');
  });

  it('親 task を child workflow の agent prompt へデフォルト伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Child task context:\\n{task}"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const parentTask = 'Propagate parent task into child workflow';
    engine = new WorkflowEngine(config, tmpDir, parentTask, createWorkflowCallOptions(tmpDir));

    await engine.run();

    const childPrompt = vi.mocked(runAgent).mock.calls[0]?.[1];

    expect(childPrompt).toContain(parentTask);
  });

  it('親 workflow は child workflow の return 値で分岐できる', async () => {
    writeWorkflow(tmpDir, 'shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ok, retry_plan]
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: retry
        return: retry_plan
      - condition: done
        return: ok
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          rules: [
            {
              condition: 'retry_plan',
              next: 'plan',
            },
            {
              condition: 'ok',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan from child output:\n{previous_response}',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'Child requested replan',
      planner: 'done',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Branch on child return', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const planPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(planPrompt).toContain('Child requested replan');
  });

  it('engine 実行時に予約語 callable return を持つ child workflow を reject する', async () => {
    writeWorkflow(tmpDir, 'shared/review-loop.yaml', `name: shared/review-loop
subworkflow:
  callable: true
  returns: [ABORT]
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          rules: [
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    const workflowAborted = vi.fn();
    engine = new WorkflowEngine(
      config,
      tmpDir,
      'Reject reserved child return names',
      createWorkflowCallOptions(tmpDir),
    );
    engine.on('workflow:abort', workflowAborted);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringMatching(/subworkflow\.returns must not include reserved result/),
    ]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call overrides を子 workflow の agent 実行へ伝搬する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.providerOptions).toMatchObject({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call が provider だけ override した場合は親 model を引き継がない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider only', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
  });

  it('workflow_call が provider だけ override した場合は child personaProviders の stale model を引き継がない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider without stale persona model', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'reviewer-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
  });

  it('workflow_call が provider だけ override した場合は child providerRouting の stale model を引き継がない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider without stale routing model', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      providerRouting: {
        steps: {
          review: {
            provider: 'opencode',
            model: 'opencode/stale-review-model',
            providerOptions: {
              codex: { reasoningEffort: 'high' },
            },
          },
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
    expect(options?.providerOptions).toMatchObject({
      codex: { reasoningEffort: 'high' },
    });
  });

  it('workflow_call が provider を override しても child personaProviders の provider_options を保持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider: 'codex',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Keep child persona provider options on workflow_call override', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      providerOptions: {
        codex: { networkAccess: false },
      },
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'reviewer-model',
          providerOptions: {
            codex: { reasoningEffort: 'high' },
          },
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBeUndefined();
    expect(options?.providerOptions).toEqual({
      codex: {
        networkAccess: false,
        reasoningEffort: 'high',
      },
    });
  });

  it('workflow_call が model だけ override しても child personaProviders の provider 解決を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            model: 'opencode/override-model',
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child model with persona provider fallback', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        reviewer: {
          provider: 'opencode',
          model: 'opencode/reviewer-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('opencode');
    expect(options?.resolvedModel).toBe('opencode/override-model');
  });

  it.each([
    {
      name: 'provider only',
      overrides: { provider: 'opencode' },
      engineOptions: { provider: 'claude', model: 'parent-model' },
    },
    {
      name: 'provider with bare model',
      overrides: { provider: 'opencode', model: 'big-pickle' },
      engineOptions: { provider: 'claude', model: 'parent-model' },
    },
    {
      name: 'inherited opencode provider with bare model',
      overrides: { model: 'big-pickle' },
      engineOptions: { provider: 'opencode', model: 'opencode/parent-model' },
    },
  ])('workflow_call overrides は OpenCode の不正 model 契約を拒否する: $name', async ({ overrides, engineOptions }) => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides,
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    engine = new WorkflowEngine(
      config,
      tmpDir,
      'Reject invalid OpenCode workflow_call override',
      createWorkflowCallOptions(tmpDir, engineOptions),
    );

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call が provider_options だけ override した場合は親 provider/model を維持する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
      workflow_config: {
        provider: 'claude',
        model: 'parent-model',
        provider_options: {
          claude: {
            allowed_tools: ['Read'],
          },
        },
      },
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: {
            provider_options: {
              codex: {
                network_access: true,
              },
            },
          },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Override child provider options only', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: 'cli-model',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
    expect(options?.providerOptions).toMatchObject({
      claude: {
        allowedTools: ['Read'],
      },
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は親 step に継承済みの provider 設定を子 workflow に引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      workflow_config: {
        provider: 'codex',
        model: 'gpt-5-codex',
        provider_options: {
          codex: {
            network_access: true,
          },
        },
      },
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
            {
              condition: 'ABORT',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Inherited child provider', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('codex');
    expect(options?.resolvedModel).toBe('gpt-5-codex');
    expect(options?.providerOptions).toMatchObject({
      codex: {
        networkAccess: true,
      },
    });
  });

  it('workflow_call は step 名と personaProviders の衝突で child 入口 provider を変えない', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Avoid personaProviders collision on workflow_call', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        delegate: {
          provider: 'opencode',
          model: 'opencode/delegate-model',
        },
      },
    }));

    await engine.run();

    const options = vi.mocked(runAgent).mock.calls[0]?.[2];

    expect(options?.resolvedProvider).toBe('claude');
    expect(options?.resolvedModel).toBe('parent-model');
  });

  it('workflow_call wrapper の provider を解決せず child 実 step だけを step event と usage 対象にする', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    provider: mock
    model: child-model
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const startedSteps: Array<{
      step: string;
      iteration: number;
      provider: string | undefined;
      model: string | undefined;
      resumeStep: string;
    }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Run provider-less workflow call wrapper', createWorkflowCallOptions(tmpDir, {
      provider: undefined,
      model: undefined,
    }));
    engine.on('step:start', (step, iteration, _instruction, providerInfo, _workflowName, resumeStepName) => {
      startedSteps.push({
        step: step.name,
        iteration,
        provider: providerInfo.provider,
        model: providerInfo.model,
        resumeStep: resumeStepName,
      });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1);
    expect(startedSteps).toEqual([
      {
        step: 'review',
        iteration: 1,
        provider: 'mock',
        model: 'child-model',
        resumeStep: 'delegate',
      },
    ]);
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'mock',
      resolvedModel: 'child-model',
    }));
  });

  it('workflow_call wrapper は非計数のまま child system だけが共有予算を消費する', async () => {
    const childConfig: WorkflowConfig = {
      name: 'child-system',
      subworkflow: { callable: true },
      initialStep: 'route-context',
      steps: [{
        name: 'route-context',
        kind: 'system',
        rules: [makeRule('when(true)', 'COMPLETE')],
      }],
    };
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-system-budget',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child-system',
          rules: [{ condition: 'COMPLETE', next: 'final-review' }],
        },
        {
          name: 'final-review',
          persona: 'supervisor',
          instruction: 'Review the routed context',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    const lifecycle: string[] = [];
    const started: Array<{ step: string; iteration: number; provider?: string }> = [];
    let systemCheckpoint: ReturnType<WorkflowEngine['getResumePoint']>;
    const iterationLimit = vi.fn();
    engine = new WorkflowEngine(config, tmpDir, 'Run child system budget', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver: () => childConfig,
    }));
    engine.on('workflow_call:start', () => lifecycle.push('start'));
    engine.on('workflow_call:complete', () => lifecycle.push('complete'));
    engine.on('step:start', (step, iteration, _instruction, providerInfo) => {
      started.push({
        step: step.name,
        iteration,
        ...(providerInfo?.provider === undefined ? {} : { provider: providerInfo.provider }),
      });
      if (step.name === 'route-context') systemCheckpoint = engine?.getResumePoint();
    });
    engine.on('iteration:limit', iterationLimit);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(started).toEqual([{ step: 'route-context', iteration: 1 }]);
    expect(lifecycle).toEqual(['start', 'complete']);
    expect(systemCheckpoint).toEqual(expect.objectContaining({
      iteration: 1,
      stack: [
        expect.objectContaining({ step: 'delegate', kind: 'workflow_call', call_instance: 1 }),
        expect.objectContaining({
          step: 'route-context',
          kind: 'system',
          step_iterations: { 'route-context': 1 },
        }),
      ],
    }));
    expect(iterationLimit).toHaveBeenCalledWith(
      1,
      1,
      'final-review',
      expect.objectContaining({
        stack: [expect.objectContaining({ step: 'final-review', kind: 'agent' })],
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('child provider 解決失敗は親 iteration を消費せず call attempt だけを保存する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'takt/coding',
        rules: [
          { condition: 'COMPLETE', next: 'COMPLETE' },
          { condition: 'ABORT', next: 'ABORT' },
        ],
      }],
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const startedSteps: string[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Fail child provider validation', createWorkflowCallOptions(tmpDir, {
      provider: undefined,
      model: undefined,
    }));
    engine.on('workflow_call:start', (event) => lifecycleEvents.push(event));
    engine.on('workflow_call:complete', (event) => lifecycleEvents.push(event));
    engine.on('step:start', (step) => startedSteps.push(step.name));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(startedSteps).toEqual([]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(resumePoint?.stack[0]).toEqual(expect.objectContaining({
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
      call_instance: 1,
      step_iterations: { delegate: 1 },
    }));
    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents[0]).toEqual(expect.objectContaining({
      step: 'delegate',
      childWorkflow: 'takt/coding',
      callInstance: 1,
    }));
    expect(lifecycleEvents[1]).toEqual(expect.objectContaining({
      step: 'delegate',
      childWorkflow: 'takt/coding',
      callInstance: 1,
      result: {
        status: 'failed',
        reason: 'Step "review" has no resolved provider',
      },
    }));
  });

  it('workflow_call child workflow の AI router は child workflow 名で判定する', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T10:00:00.000Z'));
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
workflow_config:
  provider: mock
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"required_tier":"medium","reason_codes":["focused-change"]}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Route child workflow with child context', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      autoRouting: createWorkflowCallAutoRoutingConfig(),
    }));
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    const routingEventsDir = join(tmpDir, '.takt', 'events');
    initAnalyticsWriter(false, join(tmpDir, 'analytics'), { routingEventsDir });
    const analyticsEmitter = new AnalyticsEmitter('run-workflow-call-routing', false);
    engine.on('routing:decision', (step, response, instruction, providerInfo, stepType, durationMs, iteration, workflowName) => {
      analyticsEmitter.onRoutingDecision(
        step,
        response,
        instruction,
        providerInfo,
        stepType,
        durationMs,
        iteration,
        workflowName,
      );
    });

    const state = await engine.run();
    const routerCalls = vi.mocked(runAgent).mock.calls.filter(([persona]) => persona === 'auto-router');
    const routerCall = routerCalls[0];
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(abortReasons).toEqual([]);
    expect(state.status).toBe('completed');
    expect(routerCalls).toHaveLength(1);
    expect(routerCall?.[1]).toContain('"name":"review"');
    expect(routerCall?.[1]).toContain('"instruction":"Review child workflow"');
    expect(routerCall?.[1]).not.toContain('parent');
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'mock',
      resolvedModel: 'parent-model',
    }));
    const records = readFileSync(join(routingEventsDir, '2026-02-18.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as RoutingDecisionEvent);
    const childRoutingEvent = records.find((event) => (
      event.type === 'routing_decision' && event.stepName === 'review'
    ));
    expect(childRoutingEvent).toMatchObject({
      type: 'routing_decision',
      stepName: 'review',
      workflowName: 'takt/coding',
      selectedCategory: 'delegate-runtime',
    });
  });

  it('workflow_call child は親 options の effective auto_routing を継承して未指定 step を routing する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'auto-router') {
        return makeResponse({
          persona: 'auto-router',
          content: '{"required_tier":"medium","reason_codes":["focused-change"]}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Route inherited auto provider child workflow', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoRouting: createWorkflowCallAutoRoutingConfig(),
    }));

    const state = await engine.run();
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(state.status).toBeDefined();
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'mock',
      resolvedModel: 'parent-model',
    }));
  });

  it('workflow_call は child workflow 自前の auto_routing への strategy override を実 engine で1回だけ通知する', async () => {
    const onEffectiveAutoRoutingReached = vi.fn();
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
workflow_config:
  provider: mock
auto_routing:
  strategy: balanced
  router:
    provider: claude-sdk
    model: claude-haiku-4-5-20251001
  candidates:
    - name: delegate-runtime
      description: Workflow call delegation
      provider: mock
      model: mock/parent-model
      routing_tier: medium
    - name: reasoning
      description: Architecture and planning
      provider: claude-sdk
      model: claude-opus-4-20250514
      routing_tier: high
  default_pool: general
  candidate_pools:
    general:
      candidates: [delegate-runtime, reasoning]
      fallback: reasoning
  rules:
    steps:
      review: reasoning
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review child workflow
    rules:
      - condition: done
        next: COMPLETE
`);
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      return makeResponse({ persona: 'reviewer', content: 'done' });
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(parentConfig, tmpDir, 'Override child auto strategy', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoStrategyOverride: 'performance',
      onEffectiveAutoRoutingReached,
    }));
    const state = await engine.run();
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(state.status).toBe('completed');
    expect(onEffectiveAutoRoutingReached).toHaveBeenCalledOnce();
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude-sdk',
      resolvedModel: 'claude-opus-4-20250514',
    }));
  });

  it('workflow_call concrete provider override があっても strategy override の適用を child engine に委譲する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 4,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          overrides: { provider: 'mock' },
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'takt/coding',
      provider: 'claude',
      autoRouting: createWorkflowCallAutoRoutingConfig(),
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [makeRule('done', 'COMPLETE')],
        },
      ],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 2)),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'reviewer', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', 1]]),
        status: 'running',
      },
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Concrete override child top-level auto',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        provider: 'mock',
        model: undefined,
        autoStrategyOverride: 'performance',
      }),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig as never,
      createEngine,
    });

    await expect(runner.run(parentConfig.steps[0] as never)).resolves.toBeDefined();

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Concrete override child top-level auto',
      expect.objectContaining({
        provider: 'mock',
        autoStrategyOverride: 'performance',
        autoRouting: expect.objectContaining({ strategy: 'balanced' }),
      }),
    );
  });
});
