import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

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
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import {
  applyWorkflowCallOverridesToPersonaProviders,
  applyWorkflowCallOverridesToProviderRouting,
} from '../core/workflow/engine/WorkflowCallExecutor.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  buildWorkflowCallNamespaceSegment,
  parseWorkflowCallNamespaceSegment,
} from '../core/workflow/workflow-call-namespace.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeRule,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';
import { mockRuleEvaluation } from './rule-evaluator-test-double.js';
import { buildWorkflowCallInvocationRecordsFixture } from './helpers/workflow-resume-fixture.js';
import type {
  AutoRoutingConfig,
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import type { RoutingDecisionEvent } from '../features/analytics/index.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';
import { generateReportDir } from '../shared/utils/index.js';
import type { WorkflowExecutionScope } from '../core/workflow/workflow-execution-scope.js';
import { WorkflowCallProgressTracker } from '../core/workflow/workflow-call-progress-tracker.js';
import { parseWorkflowResumePoint } from '../core/workflow/resume-point-codec.js';

function createWorkflowCallProgressDeps() {
  const workflowCallProgressTracker = new WorkflowCallProgressTracker();
  return {
    sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker },
    progressLease: workflowCallProgressTracker.acquire(),
  };
}

function createOwnedResumePoint(workflow: string, step: string, iteration: number) {
  return {
    version: 2 as const,
    stack: [{ workflow, step, kind: 'agent' as const, step_iterations: {} }],
    iteration,
    max_steps: 4,
    elapsed_ms: 0,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = join(projectDir, '.takt', 'workflows', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function createParentWorkflow(projectDir: string, raw: Record<string, unknown>) {
  return normalizeWorkflowConfig(raw, projectDir);
}

function loadWorkflowOrThrow(identifier: string, projectDir: string, basePath?: string) {
  const workflow = loadWorkflowByIdentifier(identifier, projectDir, basePath ? { basePath } : undefined);
  expect(workflow).not.toBeNull();
  return workflow!;
}

function createWorkflowCallOptions(
  projectDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectCwd: projectDir,
    provider: 'mock',
    model: 'parent-model',
    selectorGitCommandRunner: new GitSelectorCommandRunner(),
    workflowCallResolver: ({
      parentWorkflow,
      step,
      projectCwd: resolverProjectCwd,
      lookupCwd,
    }: {
      parentWorkflow: Parameters<typeof resolveWorkflowCallTarget>[0];
      step: Parameters<typeof resolveWorkflowCallTarget>[1];
      projectCwd: Parameters<typeof resolveWorkflowCallTarget>[2];
      lookupCwd: string;
    }) => resolveWorkflowCallTarget(parentWorkflow, step, resolverProjectCwd, lookupCwd),
    ...overrides,
  };
}

function createWorkflowCallAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'delegate-runtime',
        description: 'Workflow call delegation',
        provider: 'mock',
        model: 'parent-model',
        routingTier: 'medium',
      },
      {
        name: 'reasoning',
        description: 'Architecture and planning',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        routingTier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      },
      {
        name: 'lightweight',
        description: 'Formatting',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        routingTier: 'low',
      },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: {
        candidates: ['lightweight', 'delegate-runtime', 'coding', 'reasoning'],
        fallback: 'reasoning',
      },
    },
    rules: {
      steps: {
        delegate: 'delegate-runtime',
      },
    },
  };
}

function mockPersonaResponses(responses: Record<string, string>, fallback = 'Parent delegate placeholder'): void {
  vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: prompt,
    });

    const personaName = typeof persona === 'string' ? persona : '';
    const matchedPersona = Object.keys(responses).find((key) => personaName.includes(key));

    return makeResponse({
      persona: personaName || 'delegate',
      content: matchedPersona ? responses[matchedPersona]! : fallback,
    });
  });
}

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

  it('callable ではない child workflow を拒否する', async () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: child
initial_step: review
max_steps: 5
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
          call: 'child',
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

    engine = new WorkflowEngine(config, tmpDir, 'Reject non-callable child', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([2, 'infinite'] as const)(
    'resolver が返す callable child の maxSteps %s を child agent 起動前に拒否する',
    async (maxSteps) => {
      const config = createParentWorkflow(tmpDir, {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 3,
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        }],
      });
      const childConfig: WorkflowConfig = {
        name: 'child',
        subworkflow: { callable: true },
        maxSteps,
        initialStep: 'review',
        steps: [{
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review',
          rules: [makeRule('done', 'COMPLETE')],
        }],
      };
      let abortReason = '';
      engine = new WorkflowEngine(config, tmpDir, 'Reject callable child maxSteps', createWorkflowCallOptions(tmpDir, {
        workflowCallResolver: () => childConfig,
      }));
      engine.on('workflow:abort', (_state, reason) => {
        abortReason = reason;
      });

      const state = await engine.run();

      expect(state.status).toBe('aborted');
      expect(abortReason).toMatch(/callable.*max_steps|max_steps.*callable/i);
      expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    },
  );

  it('workflow call context なしで callable subworkflow を直接実行する場合は開始前に拒否する', () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'shared/review',
      subworkflow: { callable: true },
      initial_step: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review child workflow',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });

    expect(() => {
      engine = new WorkflowEngine(
        config,
        tmpDir,
        'Reject direct callable execution',
        createWorkflowCallOptions(tmpDir),
      );
    }).toThrow(/callable.*workflow_call|workflow_call.*callable/i);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('公開 resume prefix を偽装しても callable subworkflow の直接実行を副作用前に拒否する', () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'shared/review',
      subworkflow: { callable: true },
      initial_step: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review child workflow',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(generateReportDir).mockClear();

    expect(() => {
      engine = new WorkflowEngine(
        config,
        tmpDir,
        'Reject forged call context',
        createWorkflowCallOptions(tmpDir, {
          resumeStackPrefix: [{
            workflow: 'forged-parent',
            step: 'delegate',
            kind: 'workflow_call',
            call_instance: 1,
          }],
        }),
      );
    }).toThrow(/callable.*workflow_call|workflow_call.*callable/i);
    expect(vi.mocked(generateReportDir)).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('イベント listener が step と scope の snapshot を変更できない', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'review',
      max_steps: 1,
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review task',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(config, tmpDir, 'Snapshot events', createWorkflowCallOptions(tmpDir));
    const observed = vi.fn();
    engine.on('phase:start', (step: WorkflowStep, ...args: unknown[]) => {
      const scope = args.at(-1) as WorkflowExecutionScope;
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(scope.stack)).toBe(true);
      expect(() => {
        (step as { name: string }).name = 'mutated';
      }).toThrow();
      expect(() => {
        (scope.stack[0] as { step: string }).step = 'mutated';
      }).toThrow();
    });
    engine.on('phase:start', (step: WorkflowStep, ...args: unknown[]) => {
      const scope = args.at(-1) as WorkflowExecutionScope;
      observed(step.name, scope.stack[0]?.step);
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(observed).toHaveBeenCalledWith('review', 'review');
    expect(config.steps[0]?.name).toBe('review');
  });

  it('workflow_call cycle を検出して停止する', async () => {
    writeWorkflow(tmpDir, 'a.yaml', `name: a
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: b
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    writeWorkflow(tmpDir, 'b.yaml', `name: b
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: a
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const rootConfig = createParentWorkflow(tmpDir, {
      name: 'root',
      max_steps: 1,
      initial_step: 'delegate',
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'a',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    engine = new WorkflowEngine(rootConfig, tmpDir, 'Detect workflow call cycle', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('workflow_call depth 制限を超えたら停止する', async () => {
    for (let index = 1; index <= 6; index++) {
      const nextName = `w${index + 1}`;
      writeWorkflow(tmpDir, `w${index}.yaml`, index < 6
        ? `name: w${index}
subworkflow:
  callable: true
initial_step: delegate
steps:
  - name: delegate
    kind: workflow_call
    call: ${nextName}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`
        : `name: w${index}
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Deep child"
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    const rootConfig = createParentWorkflow(tmpDir, {
      name: 'root',
      max_steps: 1,
      initial_step: 'delegate',
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'w1',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    engine = new WorkflowEngine(rootConfig, tmpDir, 'Detect workflow depth limit', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'when rule',
      rule: 'condition: "when(true)"\n        next: COMPLETE',
    },
    {
      label: 'ai() condition',
      rule: 'condition: ai("route to plan")\n        next: COMPLETE',
    },
  ])('loadWorkflowOrThrow は workflow_call の不正な $label を実行前に reject する', ({ rule }) => {
    writeWorkflow(tmpDir, 'invalid-parent.yaml', `name: invalid-parent
initial_step: delegate
max_steps: 5
steps:
  - name: delegate
    kind: workflow_call
    call: child
    rules:
      - ${rule}
`);

    expect(() => loadWorkflowOrThrow('invalid-parent', tmpDir)).toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('project workflow から project 外の privileged subworkflow 呼び出しを拒否する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'privileged-child.yaml');
    writeFileSync(externalWorkflowPath, `name: privileged-child
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const workflowAborted = vi.fn();
    engine = new WorkflowEngine(
      loadWorkflowOrThrow('parent', tmpDir),
      tmpDir,
      'Block privileged child',
      createWorkflowCallOptions(tmpDir),
    );
    engine.on('workflow:abort', workflowAborted);

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(workflowAborted.mock.calls.map(([, reason]) => reason)).toEqual([
      expect.stringContaining('Workflow step "delegate" cannot call privileged workflow "privileged-child" across trust boundary'),
    ]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('relative child path は呼び出し元 workflow のディレクトリ基準で解決する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(join(externalDir, 'child.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(join(tmpDir, 'child.yaml'), `name: project-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'external-reviewer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(loadWorkflowOrThrow(externalParentPath, tmpDir), tmpDir, 'Resolve relative child from parent dir', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('external-reviewer');
  });

  it('external parent の plain identifier も project -> user -> builtin の順で解決する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('external parent の named child は project 不在時に user workflow を優先する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(dirname(join(externalDir, 'takt', 'coding.yaml')), { recursive: true });
    writeFileSync(join(externalDir, 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は user workflow へ fallback できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は user workflow fallback 先の allow_git_commit を trust boundary で拒否する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    allow_git_commit: true
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "takt/coding" across trust boundary',
    );
  });

  it('source metadata を持たない project parent も user workflow fallback を解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = createParentWorkflow(tmpDir, {
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
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent の named child は builtin fallback を trust boundary で拒否する', () => {
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: default
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('default');
  });

  it('project parent は project workflow root 内 child の explicit path を呼べる', () => {
    writeWorkflow(tmpDir, 'child.yaml', `name: project-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('project-child');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('project parent は absolute child path を既存どおり解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は tilde child path を既存どおり解決できる', async () => {
    const fakeHomeDir = createTestTmpDir();
    cleanupDirs.push(fakeHomeDir);
    const testWorkflowDir = join(fakeHomeDir, '.takt', 'workflows', 'workflow-call-tilde-test');
    const userWorkflowPath = join(testWorkflowDir, 'external.yaml');
    mkdirSync(testWorkflowDir, { recursive: true });
    writeFileSync(userWorkflowPath, `name: tilde-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: tilde-reviewer
    instruction: "Tilde child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    const parentWorkflow = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 3,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: '~/.takt/workflows/workflow-call-tilde-test/external.yaml',
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

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir: () => fakeHomeDir,
    }));

    const { resolveWorkflowCallTarget: resolveWorkflowCallTargetWithMockedHomedir } = await import('../infra/config/loaders/workflowCallResolver.js');

    const childWorkflow = resolveWorkflowCallTargetWithMockedHomedir(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('tilde-child');
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('project parent は dot-segment を含む named child identifier を reject する', () => {
    mkdirSync(join(tmpDir, '.takt'), { recursive: true });
    writeFileSync(join(tmpDir, '.takt', 'outside.yaml'), `name: escaped-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: escaped-reviewer
    instruction: "Escaped child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/../../outside
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call invalid workflow identifier "takt/../../outside"',
    );
  });

  it('project parent は @scope ref を既存どおり解決できる', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const workflowsDir = join(configDir, 'repertoire', '@nrslib', 'takt-ensemble', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'expert.yaml'), `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: "@nrslib/takt-ensemble/expert"
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('external-child');
  });

  it('project parent は project に存在しない named child の user fallback を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'external-reviewer',
    });
  });

  it('default worktree root 上の parent path は worktree workflow を non-project trust として解決する', () => {
    const worktreeRoot = join(tmpDir, '..', 'takt-worktrees', basename(tmpDir));
    const worktreeDir = join(worktreeRoot, 'feature-branch');
    cleanupDirs = [...cleanupDirs, worktreeRoot];
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./takt/coding.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    mkdirSync(join(worktreeDir, '.takt', 'workflows', 'takt'), { recursive: true });
    writeFileSync(join(worktreeDir, '.takt', 'workflows', 'takt', 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: worktree-reviewer
    instruction: "Worktree child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();
    expect(getWorkflowTrustInfo(parentWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      tmpDir,
      worktreeDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'worktree-reviewer',
    });
    expect(getWorkflowTrustInfo(childWorkflow!, tmpDir)).toMatchObject({
      source: 'worktree',
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    });
  });

  it('default worktree root 上の parent path は user fallback child を許可する', () => {
    const configDir = createTestTmpDir();
    cleanupDirs.push(configDir);
    process.env.TAKT_CONFIG_DIR = configDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();

    const userWorkflowDir = join(configDir, 'workflows', 'takt');
    mkdirSync(userWorkflowDir, { recursive: true });
    writeFileSync(join(userWorkflowDir, 'coding.yaml'), `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: user-reviewer
    instruction: "User child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const worktreeRoot = join(tmpDir, '..', 'takt-worktrees', basename(tmpDir));
    const worktreeDir = join(worktreeRoot, 'feature-branch');
    cleanupDirs = [...cleanupDirs, worktreeRoot];
    const worktreeWorkflowPath = join(worktreeDir, '.takt', 'workflows', 'parent.yaml');
    mkdirSync(dirname(worktreeWorkflowPath), { recursive: true });
    writeFileSync(worktreeWorkflowPath, `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');

    const parentWorkflow = loadWorkflowByIdentifier('./.takt/workflows/parent.yaml', tmpDir, { lookupCwd: worktreeDir });
    expect(parentWorkflow).not.toBeNull();

    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow!,
      findWorkflowCallStep(parentWorkflow!, 'delegate'),
      tmpDir,
      worktreeDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'user-reviewer',
    });
  });

  it('project parent は privileged な external child path を拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('project parent は allow_git_commit を持つ external child path を拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalWorkflowPath = join(externalDir, 'child.yaml');
    writeFileSync(externalWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: external-reviewer
    allow_git_commit: true
    instruction: "External child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ${externalWorkflowPath}
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);

    const parentWorkflow = loadWorkflowOrThrow('parent', tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "external-child" across trust boundary',
    );
  });

  it('non-project parent から project child path を呼ぶ場合も path 解決できる', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: project-reviewer
    instruction: "Project child"
    rules:
      - condition: done
        next: COMPLETE
`);
    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);
    const childWorkflow = resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.name).toBe('takt/coding');
    expect(childWorkflow?.steps[0]).toMatchObject({
      kind: 'agent',
      persona: 'project-reviewer',
    });
  });

  it('non-project parent から privileged な project child を named lookup で呼ぶと拒否する', () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);
    const externalParentPath = join(externalDir, 'parent.yaml');
    writeFileSync(externalParentPath, `name: external-parent
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: takt/coding
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: route_context
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - condition: when(true)
        next: COMPLETE
`);

    const parentWorkflow = loadWorkflowOrThrow(externalParentPath, tmpDir);

    expect(() => resolveWorkflowCallTarget(
      parentWorkflow,
      findWorkflowCallStep(parentWorkflow, 'delegate'),
      tmpDir,
    )).toThrow(
      'Workflow step "delegate" cannot call privileged workflow "takt/coding" across trust boundary',
    );
  });

  it('子 workflow が ABORT したら親 workflow_call は ABORT rule で通常分岐し previous_response を引き継ぐ', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: "Review child workflow"
    rules:
      - condition: abort
        next: ABORT
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
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
              next: 'plan',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan after child abort:\n{previous_response}',
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
      reviewer: 'child abort output',
      planner: 'done',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Abort branch test', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const calledPersonas = vi.mocked(runAgent).mock.calls
      .map(([persona]) => typeof persona === 'string' ? persona : '');
    const plannerPrompt = vi.mocked(runAgent).mock.calls[1]?.[1];

    expect(state.status).toBe('completed');
    expect(calledPersonas.some((persona) => persona.includes('planner'))).toBe(true);
    expect(plannerPrompt).toContain('child abort output');
  });

  it('子 workflow が例外 abort したら親 previous_response に stale な成功出力を渡さない', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 6,
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
              next: 'plan',
            },
          ],
        },
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Replan after child abort:\n{previous_response}',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    vi.mocked(runAgent)
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        return makeResponse({
          persona: 'reviewer',
          content: 'Review done',
        });
      })
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        throw new Error('child exploded');
      })
      .mockImplementationOnce(async (persona, prompt, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: prompt,
        });
        return makeResponse({
          persona: 'planner',
          content: 'done',
        });
      });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Abort branch with exception', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const plannerPrompt = vi.mocked(runAgent).mock.calls[2]?.[1];

    expect(state.status).toBe('completed');
    expect(plannerPrompt).toContain('Step execution failed: child exploded');
    expect(plannerPrompt).not.toContain('Review done');
  });

  it('workflow_call 自体を数えず child と復帰後の親実 step だけが共通予算を消費する', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
      reviewer: 'Review done',
      fixer: 'Fix done',
      supervisor: 'approved',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const startedIterations: Array<{ step: string; iteration: number }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Budget test', createWorkflowCallOptions(tmpDir));
    engine.on('step:start', (step, iteration) => {
      expect(engine?.getState().iteration).toBe(iteration);
      expect(engine?.getResumePoint()?.iteration).toBe(iteration);
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();
    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(startedIterations).toEqual([
      { step: 'review', iteration: 1 },
      { step: 'fix', iteration: 2 },
      { step: 'final_review', iteration: 3 },
    ]);
  });

  it('子 workflow で max_steps を延長した場合も親 run へ共有予算を引き継いで継続する', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
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
      reviewer: 'Review done',
      fixer: 'Fix done',
      supervisor: 'approved',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const onIterationLimit = vi.fn().mockResolvedValueOnce(2);
    const startedIterations: Array<{ step: string; iteration: number }> = [];

    engine = new WorkflowEngine(config, tmpDir, 'Extend budget from child workflow', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));
    engine.on('step:start', (step, iteration) => {
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 2,
      maxSteps: 2,
      currentStep: 'final_review',
    }));
    expect(startedIterations).toEqual([
      { step: 'review', iteration: 1 },
      { step: 'fix', iteration: 2 },
      { step: 'final_review', iteration: 3 },
    ]);
  });

  it('ignoreIterationLimit は workflow_call 配下の child workflow にも伝搬して完走できる', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
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
      reviewer: 'Review done',
      fixer: 'Fix done',
      supervisor: 'approved',
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    const onIterationLimit = vi.fn().mockResolvedValue(null);
    const startedIterations: Array<{ step: string; iteration: number }> = [];

    engine = new WorkflowEngine(config, tmpDir, 'Ignore nested iteration limit', createWorkflowCallOptions(tmpDir, {
      ignoreIterationLimit: true,
      onIterationLimit,
    }));
    engine.on('step:start', (step, iteration) => {
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
    expect(onIterationLimit).not.toHaveBeenCalled();
    expect(startedIterations).toEqual([
      { step: 'review', iteration: 1 },
      { step: 'fix', iteration: 2 },
      { step: 'final_review', iteration: 3 },
    ]);
  });

  it('max_steps: infinite は workflow_call 配下を含む実 step 全体へ適用する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: fix
  - name: fix
    persona: fixer
    instruction: Fix
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 'infinite',
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review',
          rules: [{ condition: 'COMPLETE', next: 'supervise' }],
        },
        {
          name: 'supervise',
          persona: 'supervisor',
          instruction: 'Supervise',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    mockPersonaResponses({ reviewer: 'done', fixer: 'done', supervisor: 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    const onIterationLimit = vi.fn().mockResolvedValue(null);
    engine = new WorkflowEngine(config, tmpDir, 'Run an infinite shared budget', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(3);
    expect(onIterationLimit).not.toHaveBeenCalled();
  });

  it('上限到達時も workflow_call へ進入し child の最初の実 step で停止する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'plan',
      max_steps: 1,
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Plan',
          rules: [{ condition: 'done', next: 'delegate' }],
        },
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/review',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });
    const workflowCallResolver = vi.fn(createWorkflowCallOptions(tmpDir).workflowCallResolver!);
    mockPersonaResponses({ planner: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    let resumePointAtLimit: ReturnType<WorkflowEngine['getResumePoint']>;
    const onIterationLimit = vi.fn().mockImplementation(async () => {
      resumePointAtLimit = engine?.getResumePoint();
      return null;
    });
    engine = new WorkflowEngine(config, tmpDir, 'Enter call at the budget boundary', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver,
      onIterationLimit,
    }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(1);
    expect(workflowCallResolver).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 1,
      maxSteps: 1,
      currentStep: 'review',
    }));
    expect(onIterationLimit.mock.calls[0]?.[0].scope.stack.at(-1)?.step).toBe('review');
    expect(resumePointAtLimit?.stack).toEqual([
      expect.objectContaining({ workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 }),
      expect.objectContaining({ workflow: 'shared/review', step: 'review', kind: 'agent' }),
    ]);
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)).toEqual(['planner']);
  });

  it('nested workflow_call の階層数を共通 iteration へ加算しない', async () => {
    writeWorkflow(tmpDir, 'shared/outer.yaml', `name: shared/outer
subworkflow:
  callable: true
initial_step: delegate-inner
steps:
  - name: delegate-inner
    kind: workflow_call
    call: shared/inner
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/inner.yaml', `name: shared/inner
subworkflow:
  callable: true
initial_step: implement
steps:
  - name: implement
    persona: coder
    instruction: Implement
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 2,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/outer',
          rules: [{ condition: 'COMPLETE', next: 'supervise' }],
        },
        {
          name: 'supervise',
          persona: 'supervisor',
          instruction: 'Supervise',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    mockPersonaResponses({ coder: 'done', supervisor: 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    const startedSteps: Array<{ step: string; iteration: number }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Run nested workflow calls', createWorkflowCallOptions(tmpDir));
    engine.on('step:start', (step, iteration) => startedSteps.push({ step: step.name, iteration }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
    expect(startedSteps).toEqual([
      { step: 'implement', iteration: 1 },
      { step: 'supervise', iteration: 2 },
    ]);
  });

  it('runSingleIteration でも workflow_call を数えず child 実 step だけを数える', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: reviewer
    instruction: Review
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
        call: 'shared/review',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    mockPersonaResponses({ reviewer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const startedSteps: Array<{ step: string; iteration: number }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Run one delegated iteration', createWorkflowCallOptions(tmpDir));
    engine.on('step:start', (step, iteration) => startedSteps.push({ step: step.name, iteration }));

    const result = await engine.runSingleIteration();
    const state = engine.getState();

    expect(result.isComplete).toBe(true);
    expect(state.iteration).toBe(1);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(startedSteps).toEqual([{ step: 'review', iteration: 1 }]);
  });

  it('runSingleIteration の child 全体で延長後の共有上限を直ちに利用する', async () => {
    writeWorkflow(tmpDir, 'shared/three-step.yaml', `name: shared/three-step
subworkflow:
  callable: true
initial_step: first
steps:
  - name: first
    persona: worker
    instruction: First
    rules:
      - condition: done
        next: second
  - name: second
    persona: worker
    instruction: Second
    rules:
      - condition: done
        next: third
  - name: third
    persona: worker
    instruction: Third
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
        call: 'shared/three-step',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    mockPersonaResponses({ worker: 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    const onIterationLimit = vi.fn().mockResolvedValue(2);
    engine = new WorkflowEngine(config, tmpDir, 'Extend a single iteration call', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));

    const result = await engine.runSingleIteration();
    const state = engine.getState();

    expect(result.isComplete).toBe(true);
    expect(state.iteration).toBe(3);
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 1,
      maxSteps: 1,
      currentStep: 'second',
    }));
  });

  it('非カウント workflow_call の自己再試行を既定設定で attempt 作成前に停止する', async () => {
    writeWorkflow(tmpDir, 'shared/aborting.yaml', `name: shared/aborting
subworkflow:
  callable: true
initial_step: nested-delegate
steps:
  - name: nested-delegate
    kind: workflow_call
    call: shared/missing
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'shared/aborting',
        rules: [
          { condition: 'COMPLETE', next: 'COMPLETE' },
          { condition: 'ABORT', next: 'delegate' },
        ],
      }],
    });
    const parentLifecycle: Array<{ callInstance: number; status?: string }> = [];
    let abortReason = '';
    engine = new WorkflowEngine(config, tmpDir, 'Retry an aborting call', createWorkflowCallOptions(tmpDir));
    engine.on('workflow_call:start', (event) => {
      if (event.parentWorkflow === 'parent' && event.step === 'delegate') {
        parentLifecycle.push({ callInstance: event.callInstance });
      }
    });
    engine.on('workflow_call:complete', (event) => {
      if (event.parentWorkflow === 'parent' && event.step === 'delegate') {
        parentLifecycle.push({ callInstance: event.callInstance, status: event.result.status });
      }
    });
    engine.on('workflow:abort', (_state, reason) => {
      abortReason = reason;
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(abortReason).toContain('Loop detected');
    expect(parentLifecycle).toEqual([
      { callInstance: 1 },
      { callInstance: 1, status: 'aborted' },
    ]);
  });

  it('非カウント workflow_call の交互 cycle を既定設定で再訪前に停止する', async () => {
    writeWorkflow(tmpDir, 'shared/aborting.yaml', `name: shared/aborting
subworkflow:
  callable: true
initial_step: nested-delegate
steps:
  - name: nested-delegate
    kind: workflow_call
    call: shared/missing
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate-a',
      max_steps: 1,
      steps: [
        {
          name: 'delegate-a',
          kind: 'workflow_call',
          call: 'shared/aborting',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'delegate-b' },
          ],
        },
        {
          name: 'delegate-b',
          kind: 'workflow_call',
          call: 'shared/aborting',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'delegate-a' },
          ],
        },
      ],
    });
    const started: string[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Stop alternating calls', createWorkflowCallOptions(tmpDir));
    engine.on('workflow_call:start', (event) => {
      if (event.parentWorkflow === 'parent') {
        started.push(event.step);
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('delegate-a')).toBe(1);
    expect(state.stepIterations.get('delegate-b')).toBe(1);
    expect(started).toEqual(['delegate-a', 'delegate-b']);
  });

  it('実 step の進捗後は同じ workflow_call を再実行できる', async () => {
    writeWorkflow(tmpDir, 'shared/worker.yaml', `name: shared/worker
subworkflow:
  callable: true
initial_step: work
steps:
  - name: work
    persona: worker
    instruction: Work
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
          call: 'shared/worker',
          rules: [{ condition: 'COMPLETE', next: 'bridge' }],
        },
        {
          name: 'bridge',
          persona: 'bridge',
          instruction: 'Continue or complete',
          rules: [
            { condition: 'done', next: 'delegate' },
            { condition: 'done', next: 'COMPLETE' },
          ],
        },
      ],
    });
    mockRunAgentSequence([
      makeResponse({ persona: 'worker' }),
      makeResponse({ persona: 'bridge' }),
      makeResponse({ persona: 'worker' }),
      makeResponse({ persona: 'bridge' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    const callInstances: number[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Revisit after progress', createWorkflowCallOptions(tmpDir));
    engine.on('workflow_call:start', (event) => callInstances.push(event.callInstance));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(4);
    expect(callInstances).toEqual([1, 2]);
  });

  it('runSingleIteration でも非カウント workflow_call の自己再試行を再訪前に停止する', async () => {
    writeWorkflow(tmpDir, 'shared/aborting.yaml', `name: shared/aborting
subworkflow:
  callable: true
initial_step: nested-delegate
steps:
  - name: nested-delegate
    kind: workflow_call
    call: shared/missing
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'shared/aborting',
        rules: [
          { condition: 'COMPLETE', next: 'COMPLETE' },
          { condition: 'ABORT', next: 'delegate' },
        ],
      }],
    });
    const started: number[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Stop single-iteration retry', createWorkflowCallOptions(tmpDir));
    engine.on('workflow_call:start', (event) => {
      if (event.parentWorkflow === 'parent') {
        started.push(event.callInstance);
      }
    });

    const first = await engine.runSingleIteration();
    const second = await engine.runSingleIteration();

    expect(first).toEqual(expect.objectContaining({ isComplete: false, nextStep: 'delegate' }));
    expect(second).toEqual(expect.objectContaining({ isComplete: true, nextStep: 'ABORT' }));
    expect(engine.getState().status).toBe('aborted');
    expect(engine.getState().iteration).toBe(0);
    expect(started).toEqual([1]);
  });

  it('child resolver 失敗でも call attempt identity を保存し iteration を消費しない', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'missing/child',
        rules: [
          { condition: 'COMPLETE', next: 'COMPLETE' },
          { condition: 'ABORT', next: 'ABORT' },
        ],
      }],
    });
    const lifecycleEvents: unknown[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Fail before child execution', createWorkflowCallOptions(tmpDir, {
      workflowCallResolver: () => {
        throw new Error('resolver failed');
      },
    }));
    engine.on('workflow_call:start', (event) => lifecycleEvents.push(event));
    engine.on('workflow_call:complete', (event) => lifecycleEvents.push(event));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(0);
    expect(state.stepIterations.get('delegate')).toBe(1);
    expect(resumePoint?.stack[0]).toEqual(expect.objectContaining({
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
      call_instance: 1,
      step_iterations: { delegate: 1 },
    }));
    expect(resumePoint?.workflow_call_invocations).toEqual({
      [buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]: {
        call_instance: 1,
        child_workflow_ref: 'missing/child',
      },
    });
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({ callInstance: 1 }),
      expect.objectContaining({
        callInstance: 1,
        result: { status: 'failed', reason: 'resolver failed' },
      }),
    ]);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it('child の次実 step で上限へ達した resume point は call stack と未実行 step を指す', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'reviewer', content: 'Review done' }),
      makeResponse({ persona: 'fixer', content: 'Fix done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);

    let capturedResumePoint: ReturnType<WorkflowEngine['getResumePoint']>;
    engine = new WorkflowEngine(config, tmpDir, 'Capture latest child resume point', createWorkflowCallOptions(tmpDir, {
      onIterationLimit: vi.fn().mockImplementation(async () => {
        capturedResumePoint = engine?.getResumePoint();
        return null;
      }),
    }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(capturedResumePoint?.stack).toHaveLength(2);
    expect(capturedResumePoint?.stack[0]).toEqual({
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call',
      step_iterations: { delegate: 1 },
      call_instance: 1,
    });
    expect(capturedResumePoint?.stack[1]).toEqual(expect.objectContaining({
      workflow: 'takt/coding',
      step: 'fix',
      kind: 'agent',
    }));
    expect(capturedResumePoint?.iteration).toBe(1);
    if (!capturedResumePoint) {
      throw new Error('Expected iteration-limit resume point');
    }

    cleanupWorkflowEngine(engine);
    engine = null;
    const resumedLifecycleEvents: Array<Record<string, unknown>> = [];
    const resumedStartedSteps: Array<{ step: string; iteration: number }> = [];
    const onResumedIterationLimit = vi.fn().mockResolvedValue(1);
    engine = new WorkflowEngine(config, tmpDir, 'Resume latest child point', createWorkflowCallOptions(tmpDir, {
      initialIteration: capturedResumePoint.iteration,
      resumePoint: capturedResumePoint,
      onIterationLimit: onResumedIterationLimit,
    }));
    engine.on('workflow_call:start', (event) => resumedLifecycleEvents.push(event));
    engine.on('workflow_call:complete', (event) => resumedLifecycleEvents.push(event));
    engine.on('step:start', (step, iteration) => {
      resumedStartedSteps.push({ step: step.name, iteration });
    });

    const resumedState = await engine.run();
    const resumedPoint = engine.getResumePoint();

    expect(resumedState.status).toBe('completed');
    expect(resumedState.iteration).toBe(2);
    expect(resumedState.stepIterations.get('delegate')).toBe(1);
    expect(onResumedIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 1,
      maxSteps: 1,
      currentStep: 'fix',
    }));
    expect(resumedStartedSteps).toEqual([{ step: 'fix', iteration: 2 }]);
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)).toEqual([
      expect.stringContaining('reviewer'),
      expect.stringContaining('fixer'),
    ]);
    expect(resumedLifecycleEvents).toEqual([
      expect.objectContaining({
        step: 'delegate',
        childWorkflow: 'takt/coding',
        callInstance: 1,
      }),
      expect.objectContaining({
        step: 'delegate',
        childWorkflow: 'takt/coding',
        callInstance: 1,
        result: expect.objectContaining({ status: 'completed' }),
      }),
    ]);
    expect(resumedPoint?.workflow_call_invocations).toEqual(
      capturedResumePoint.workflow_call_invocations,
    );
  });

  it('再開した子 workflow が最初の step 前に max_steps へ達しても child checkpoint を保持する', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });
    const resumePoint = {
      version: 2 as const,
      stack: [
        { workflow: 'parent', step: 'delegate', kind: 'workflow_call' as const, call_instance: 1 },
        { workflow: 'takt/coding', step: 'fix', kind: 'agent' as const },
      ],
      iteration: 1,
      elapsed_ms: 183245,
      workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
        workflowReference: 'parent',
        step: 'delegate',
        ownerPath: [],
        childWorkflowReference: 'takt/coding',
        callInstance: 1,
      }]),
      workflow_step_participations: {},
    };
    let capturedResumePoint: ReturnType<WorkflowEngine['getResumePoint']>;
    engine = new WorkflowEngine(config, tmpDir, 'Resume child at iteration limit', createWorkflowCallOptions(tmpDir, {
      initialIteration: 1,
      resumePoint,
      onIterationLimit: vi.fn().mockImplementation(async () => {
        capturedResumePoint = engine?.getResumePoint();
        return null;
      }),
    }));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(runAgent).not.toHaveBeenCalled();
    expect(capturedResumePoint?.stack).toEqual([
      expect.objectContaining({
        workflow: 'parent',
        step: 'delegate',
        kind: 'workflow_call',
      }),
      expect.objectContaining({
        workflow: 'takt/coding',
        step: 'fix',
        kind: 'agent',
      }),
    ]);
    expect(capturedResumePoint?.iteration).toBe(1);
    expect(capturedResumePoint?.elapsed_ms).toBeGreaterThanOrEqual(resumePoint.elapsed_ms);
  });

  it('resolveWorkflowCallTarget は callable child へ max_steps default を注入しない', () => {
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
      max_steps: 2,
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

    const childWorkflow = resolveWorkflowCallTarget(
      config,
      findWorkflowCallStep(config, 'delegate'),
      tmpDir,
    );

    expect(childWorkflow?.maxSteps).toBeUndefined();
  });

  it('retry 時は resume_point.elapsed_ms を引き継いで resume_point を再構築する', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:00:10.000Z'));

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 10,
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

    engine = new WorkflowEngine(config, tmpDir, 'Retry workflow composition', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: 'parent',
          step: 'delegate',
          ownerPath: [],
          callInstance: 1,
          childWorkflowReference: 'takt/coding',
        }]),
        workflow_step_participations: {},
      },
    }));

    const resumePoint = engine.buildResumePointForStepName('delegate');

    expect(resumePoint?.iteration).toBe(7);
    expect(resumePoint?.elapsed_ms).toBe(183245);
  });

  it('同名だが別 source の child workflow path は cycle とみなさない', async () => {
    writeWorkflow(tmpDir, 'nested/child.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: child-reviewer
    instruction: "Review child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: shared/workflow
initial_step: delegate
max_steps: 10
steps:
  - name: delegate
    kind: workflow_call
    call: ./nested/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    const parentConfig = loadWorkflowOrThrow('parent', tmpDir);
    const childConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'nested', 'child.yaml'), tmpDir);
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
          lastOutput: makeResponse({ persona: 'child-reviewer', content: 'done' }),
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
      task: 'Allow same-name subworkflow from another source',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.matchedRuleIndex).toBe(0);
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('non-interactive workflow_call fails closed when only interactive result rules match', async () => {
    const executeWithRules = async (
      rules: Array<{
        condition: string;
        next: string;
        interactive_only?: boolean;
      }>,
      interactive: boolean,
      execution: 'direct' | 'isolated',
    ) => {
      const parentConfig = createParentWorkflow(tmpDir, {
        name: 'parent',
        initial_step: 'delegate',
        max_steps: 5,
        steps: [{
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules,
        }],
      });
      const childConfig = {
        name: 'child',
        initialStep: 'review',
        subworkflow: { callable: true },
        steps: [{ name: 'review' }],
      } as WorkflowConfig;
      const childState = {
        workflowName: childConfig.name,
        currentStep: 'review',
        iteration: 2,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        lastOutput: makeResponse({ persona: 'child-reviewer', content: 'done' }),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', 1]]),
        status: 'completed',
      } as WorkflowState;
      const createEngine = vi.fn().mockReturnValue({
        on: vi.fn(),
        getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 2)),
        runWithResult: vi.fn().mockResolvedValue({ state: childState }),
      });
      const runner = new WorkflowCallRunner({
        getConfig: () => parentConfig,
        state: {
          ...childState,
          workflowName: parentConfig.name,
          currentStep: 'delegate',
          iteration: 1,
          status: 'running',
        },
        projectCwd: tmpDir,
        getCwd: () => tmpDir,
        task: 'Filter interactive workflow_call rules',
        getOptions: () => createWorkflowCallOptions(tmpDir, { interactive }),
        ...createWorkflowCallProgressDeps(),
        resumeStackPrefix: [],
        runPaths: { slug: 'test-report-dir' } as never,
        setActiveResumePoint: vi.fn(),
        setActiveResumeStack: vi.fn(),
        adoptResumeCheckpoint: vi.fn(),
        emit: vi.fn(),
        resolveWorkflowCall: () => childConfig,
        createEngine,
        refreshFindingsState: vi.fn(),
      });
      const step = parentConfig.steps[0] as never;

      if (execution === 'direct') {
        return (await runner.run(step)).response.matchedRuleIndex;
      }
      return (await runner.runIsolated(step)).result.response.matchedRuleIndex;
    };

    const regularRules = [
      { condition: 'COMPLETE', next: 'ABORT', interactive_only: true },
      { condition: 'COMPLETE', next: 'COMPLETE' },
    ];
    await expect(executeWithRules(regularRules, false, 'direct')).resolves.toBe(1);
    await expect(executeWithRules(regularRules, false, 'isolated')).resolves.toBe(1);

    const interactiveOnlyRules = [
      { condition: 'COMPLETE', next: 'COMPLETE', interactive_only: true },
    ];
    await expect(executeWithRules(interactiveOnlyRules, false, 'direct'))
      .rejects.toBeInstanceOf(RuleDetectionExhaustedError);
    await expect(executeWithRules(interactiveOnlyRules, false, 'isolated'))
      .rejects.toBeInstanceOf(RuleDetectionExhaustedError);
    await expect(executeWithRules(interactiveOnlyRules, true, 'direct')).resolves.toBe(0);
    await expect(executeWithRules(interactiveOnlyRules, true, 'isolated')).resolves.toBe(0);
  });

  it('WorkflowCallRunner は step_transition abort では abortReason 文字列より child の最終出力を優先する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      subworkflow: {
        callable: true,
      },
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const childState = {
      workflowName: childConfig.name,
      currentStep: 'review',
      iteration: 2,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      lastOutput: makeResponse({ persona: 'child-reviewer', content: 'child abort output' }),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'aborted',
    } as WorkflowState;
    const runWithResult = vi.fn().mockResolvedValue({
      state: childState,
      abort: {
        kind: 'step_transition',
        reason: 'Abort due to child ABORT rule',
      },
    });
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 2)),
      runWithResult,
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
      task: 'Abort transition response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('child abort output');
    expect(result.response.matchedRuleIndex).toBe(1);
  });

  it('WorkflowCallRunner は child の rule_no_match abort reason を親の ABORT 応答へ伝播する', async () => {
    const parentConfig = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'child',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
    });
    const childConfig = {
      name: 'child',
      initialStep: 'review',
      subworkflow: {
        callable: true,
      },
      steps: [{ name: 'review' }],
    } as WorkflowConfig;
    const parentState = {
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
    } as WorkflowState;
    const childState = {
      workflowName: childConfig.name,
      currentStep: 'review',
      iteration: 2,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'aborted',
    } as WorkflowState;
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 2)),
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
        abort: {
          kind: 'rule_no_match',
          reason: 'rule_no_match',
        },
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: parentState,
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Abort fallback response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('rule_no_match');
    expect(result.response.matchedRuleIndex).toBe(1);
    expect(parentState.lastOutput?.content).toBe('rule_no_match');
  });

  it('resume_point は workflow_ref が一致する child workflow にだけ適用する', async () => {
    writeWorkflow(tmpDir, 'child-a.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: child-a-reviewer
    instruction: "Review child workflow A"
    rules:
      - condition: done
        next: COMPLETE
  - name: fix
    persona: child-a-fixer
    instruction: "Fix child workflow A"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'child-b.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: child-b-reviewer
    instruction: "Review child workflow B"
    rules:
      - condition: done
        next: COMPLETE
  - name: fix
    persona: child-b-fixer
    instruction: "Fix child workflow B"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'parent.yaml', `name: parent
initial_step: delegate
max_steps: 10
steps:
  - name: delegate
    kind: workflow_call
    call: ./child-b.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    const parentConfig = loadWorkflowOrThrow('parent', tmpDir);
    const childAConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'child-a.yaml'), tmpDir);
    const childConfig = loadWorkflowOrThrow(join(tmpDir, '.takt', 'workflows', 'child-b.yaml'), tmpDir);
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 2)),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 8,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'child-b-reviewer', content: 'done' }),
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
        iteration: 7,
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
      task: 'Resume same-name workflow by workflow_ref',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        resumePoint: {
          version: 2,
          stack: [
            { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
            {
              workflow: 'shared/workflow',
              workflow_ref: getWorkflowReference(childAConfig),
              step: 'fix',
              kind: 'agent',
            },
          ],
          iteration: 7,
          elapsed_ms: 183245,
          workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
            workflowReference: 'parent',
            step: 'delegate',
            ownerPath: [],
            callInstance: 1,
            childWorkflowReference: getWorkflowReference(childAConfig),
          }]),
          workflow_step_participations: {},
        },
      }),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await runner.run(parentConfig.steps[0] as never);

    expect(createEngine.mock.calls[0]?.[3]?.startStep).toBeUndefined();
  });

  it('resume_point の child step が消えていたら child initial_step から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: fix
steps:
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({ fixer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child initial step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: 'parent',
          step: 'delegate',
          ownerPath: [],
          callInstance: 1,
          childWorkflowReference: 'takt/coding',
        }]),
        workflow_step_participations: {},
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona, state.lastOutput?.content).toContain('fixer');
  });

  it('resume_point の child step が残っていればその step から再開する', async () => {
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
        next: fix
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
          rules: [
            {
              condition: 'COMPLETE',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({ fixer: 'done' });
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child resume step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          {
            workflow: 'parent',
            step: 'delegate',
            kind: 'workflow_call',
            call_instance: 1,
            step_iterations: { delegate: 1 },
          },
          {
            workflow: 'takt/coding',
            step: 'fix',
            kind: 'agent',
            step_iterations: { review: 4, fix: 6 },
          },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-7--step-delegate--workflow-takt%2Fcoding',
          },
        },
        workflow_step_participations: {},
      },
    }));
    const startFn = vi.fn();
    engine.on('step:start', startFn);

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];
    const fixStart = startFn.mock.calls.find((call) => (call[0] as WorkflowStep).name === 'fix');

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(8);
    expect(calledPersona, state.lastOutput?.content).toContain('fixer');
    expect(fixStart?.[1]).toBe(8);
    expect(fixStart?.[2]).toContain('Step Iteration: 7');
    expect(fixStart?.[6]).toBe(7);
    expect(startFn.mock.calls.some((call) => (call[0] as WorkflowStep).name === 'delegate')).toBe(false);
    const invocation = engine.getResumePoint()?.workflow_call_invocations[
      buildWorkflowCallInvocationIdentity('parent', 'delegate', [])
    ];
    expect(invocation?.call_instance).toBe(1);
    expect(invocation?.child_workflow_ref).toMatch(/^project:sha256:[a-f0-9]{64}$/);
  });

  it('resume_point の深い child step が消えていたら直近の workflow_call から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: delegate_review
steps:
  - name: delegate_review
    kind: workflow_call
    call: takt/review-loop
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'takt/review-loop.yaml', `name: takt/review-loop
subworkflow:
  callable: true
initial_step: fix
steps:
  - name: fix
    persona: fixer
    instruction: "Fix child workflow"
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
      persona: 'fixer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume nested workflow_call from nearest valid parent', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call', call_instance: 1 },
          {
            workflow: 'takt/coding',
            step: 'delegate_review',
            kind: 'workflow_call',
            call_instance: 1,
          },
          { workflow: 'takt/review-loop', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([
          {
            workflowReference: 'parent',
            step: 'delegate',
            ownerPath: [],
            callInstance: 1,
            childWorkflowReference: 'takt/coding',
          },
          {
            workflowReference: 'takt/coding',
            step: 'delegate_review',
            ownerPath: [{
              workflow: 'parent',
              step: 'delegate',
              kind: 'workflow_call',
              call_instance: 1,
            }],
            callInstance: 1,
            childWorkflowReference: 'takt/review-loop',
          },
        ]),
        workflow_step_participations: {},
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona, state.lastOutput?.content).toContain('fixer');
  });

  it('WorkflowCallRunner は child engine に subworkflow report namespace を渡す', async () => {
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
            {
              condition: 'ABORT',
              next: 'ABORT',
            },
          ],
        },
      ],
    });
    const childConfig = createParentWorkflow(tmpDir, {
      name: 'takt/coding',
      initial_step: 'review',
      subworkflow: {
        callable: true,
      },
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          output_contracts: {
            report: [
              {
                name: '00-child-report.md',
                format: 'markdown',
              },
            ],
          },
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });

    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 1)),
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
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Workflow call report namespace',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await runner.run(parentConfig.steps[0] as never);

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Workflow call report namespace',
      expect.objectContaining({
        reportDirName: 'test-report-dir',
        runPathNamespace: [
          'subworkflows',
          buildWorkflowCallNamespaceSegment(
            buildWorkflowCallInvocationIdentity('parent', 'delegate', []),
            'takt/coding',
            1,
          ),
        ],
      }),
    );
  });

  it('WorkflowCallRunner は継承した resolver でも nested child の relative call を直近親基準で解決する', async () => {
    const externalDir = createTestTmpDir();
    cleanupDirs.push(externalDir);

    const rootWorkflowPath = join(externalDir, 'root.yaml');
    const childWorkflowPath = join(externalDir, 'child', 'child.yaml');
    const nestedWorkflowPath = join(externalDir, 'child', 'nested.yaml');
    const wrongNestedWorkflowPath = join(externalDir, 'nested.yaml');

    mkdirSync(dirname(childWorkflowPath), { recursive: true });
    writeFileSync(rootWorkflowPath, `name: external-root
initial_step: delegate
max_steps: 3
steps:
  - name: delegate
    kind: workflow_call
    call: ./child/child.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(childWorkflowPath, `name: external-child
subworkflow:
  callable: true
initial_step: delegate_nested
steps:
  - name: delegate_nested
    kind: workflow_call
    call: ./nested.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`, 'utf-8');
    writeFileSync(nestedWorkflowPath, `name: nested-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: nested-reviewer
    instruction: "Nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');
    writeFileSync(wrongNestedWorkflowPath, `name: wrong-nested-child
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: wrong-reviewer
    instruction: "Wrong nested child"
    rules:
      - condition: done
        next: COMPLETE
`, 'utf-8');

    const rootWorkflow = loadWorkflowOrThrow(rootWorkflowPath, tmpDir);
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: 'external-child',
          currentStep: 'delegate_nested',
          iteration: 2,
          stepOutputs: new Map(),
          structuredOutputs: new Map(),
          systemContexts: new Map(),
          effectResults: new Map(),
          lastOutput: makeResponse({ persona: 'delegate_nested', content: 'done' }),
          userInputs: [],
          personaSessions: new Map(),
          stepIterations: new Map(),
          status: 'completed',
        },
      }),
    });
    const resolveWorkflowCall: WorkflowCallResolver = ({
      parentWorkflow,
      step,
      projectCwd,
      lookupCwd,
    }) => resolveWorkflowCallTarget(
      parentWorkflow,
      step,
      projectCwd,
      lookupCwd,
      {
        sourcePath: getWorkflowSourcePath(rootWorkflow),
        trustInfo: getWorkflowTrustInfo(rootWorkflow, projectCwd),
      },
    );
    const runner = new WorkflowCallRunner({
      getConfig: () => rootWorkflow,
      state: {
        workflowName: rootWorkflow.name,
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
      task: 'Nested workflow call resolver context',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall,
      createEngine,
    });

    await runner.run(rootWorkflow.steps[0] as never);

    const childWorkflow = createEngine.mock.calls[0]?.[0];
    const childResolver = createEngine.mock.calls[0]?.[3]?.workflowCallResolver as (args: {
      parentWorkflow: Parameters<typeof resolveWorkflowCallTarget>[0];
      step: Parameters<typeof resolveWorkflowCallTarget>[1];
      projectCwd: Parameters<typeof resolveWorkflowCallTarget>[2];
      lookupCwd: string;
    }) => ReturnType<typeof resolveWorkflowCallTarget>;

    const nestedWorkflow = childResolver({
      parentWorkflow: childWorkflow,
      step: findWorkflowCallStep(childWorkflow, 'delegate_nested'),
      projectCwd: tmpDir,
      lookupCwd: tmpDir,
    });

    expect(nestedWorkflow).not.toBeNull();
    expect(nestedWorkflow?.name).toBe('nested-child');
  });

  it('WorkflowCallRunner は slug が同じ別名でも child namespace を衝突させない', async () => {
    const createChildState = () => ({
      workflowName: 'child',
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
      status: 'completed' as const,
    });
    const createState = (workflowName: string, stepName: string) => ({
      workflowName,
      currentStep: stepName,
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running' as const,
    });
    const createNamespaceRunner = (
      stepName: string,
      childWorkflowName: string,
      createEngine: ReturnType<typeof vi.fn>,
      parentWorkflowName = `parent-${stepName}`,
      resumeStackPrefix: Array<{
        workflow: string;
        step: string;
        kind: 'agent' | 'workflow_call';
        call_instance?: number;
      }> = [],
      findingCallNamespace?: string,
    ) => {
      const parentConfig = createParentWorkflow(tmpDir, {
        name: parentWorkflowName,
        initial_step: stepName,
        max_steps: 4,
        steps: [
          {
            name: stepName,
            kind: 'workflow_call',
            call: childWorkflowName,
            rules: [
              {
                condition: 'COMPLETE',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });
      const childConfig = createParentWorkflow(tmpDir, {
        name: childWorkflowName,
        initial_step: 'review',
        subworkflow: {
          callable: true,
        },
        steps: [
          {
            name: 'review',
            persona: 'reviewer',
            instruction: 'Review child workflow',
            rules: [
              {
                condition: 'done',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      });

      return {
        runner: new WorkflowCallRunner({
          getConfig: () => parentConfig,
          state: createState(parentConfig.name, stepName),
          projectCwd: tmpDir,
          getCwd: () => tmpDir,
          task: 'Workflow call namespace collision',
          getOptions: () => ({
            ...createWorkflowCallOptions(tmpDir),
            reportDirName: 'test-report-dir',
            ...(findingCallNamespace === undefined ? {} : { findingCallNamespace }),
          }),
          ...createWorkflowCallProgressDeps(),
          resumeStackPrefix,
          runPaths: {
            slug: 'test-report-dir',
          } as never,
          setActiveResumePoint: vi.fn(),
          setActiveResumeStack: vi.fn(),
          adoptResumeCheckpoint: vi.fn(),
          emit: vi.fn(),
          resolveWorkflowCall: () => childConfig,
          createEngine,
        }),
        step: parentConfig.steps[0] as never,
      };
    };

    const createEngineA = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child-a', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const createEngineB = vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child-b', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const runA = createNamespaceRunner('delegate/a', 'takt:review', createEngineA);
    const runB = createNamespaceRunner('delegate:a', 'takt/review', createEngineB);

    await runA.runner.run(runA.step);
    await runB.runner.run(runB.step);

    const namespaceA = createEngineA.mock.calls[0]?.[3]?.runPathNamespace;
    const namespaceB = createEngineB.mock.calls[0]?.[3]?.runPathNamespace;

    expect(namespaceA?.[0]).toBe('subworkflows');
    expect(namespaceB?.[0]).toBe('subworkflows');
    expect(parseWorkflowCallNamespaceSegment(namespaceA?.[1])).toEqual(
      expect.objectContaining({ callInstance: 1 }),
    );
    expect(parseWorkflowCallNamespaceSegment(namespaceB?.[1])).toEqual(
      expect.objectContaining({ callInstance: 1 }),
    );
    expect(namespaceA).not.toEqual(namespaceB);

    const createOwnerCollisionEngine = () => vi.fn().mockReturnValue({
      on: vi.fn(),
      getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', 1)),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const createEngineOwnerA = createOwnerCollisionEngine();
    const createEngineOwnerB = createOwnerCollisionEngine();
    const ownerA = createNamespaceRunner(
      'b/c',
      'child',
      createEngineOwnerA,
      'parent',
      [{ workflow: 'parent', step: 'a', kind: 'agent' }],
    );
    const ownerB = createNamespaceRunner(
      'c',
      'child',
      createEngineOwnerB,
      'parent',
      [{ workflow: 'parent', step: 'a/b', kind: 'agent' }],
    );

    await ownerA.runner.run(ownerA.step);
    await ownerB.runner.run(ownerB.step);

    expect(createEngineOwnerA.mock.calls[0]?.[3]?.runPathNamespace)
      .not.toEqual(createEngineOwnerB.mock.calls[0]?.[3]?.runPathNamespace);

    const createEngineParentCall = createOwnerCollisionEngine();
    const parentCall = createNamespaceRunner('a', 'child', createEngineParentCall, 'parent');
    await parentCall.runner.run(parentCall.step);
    const parentFindingNamespace = createEngineParentCall.mock.calls[0]?.[3]?.findingCallNamespace as string;
    const parentRunNamespace = createEngineParentCall.mock.calls[0]?.[3]?.runPathNamespace as string[];

    const createEngineNestedCall = createOwnerCollisionEngine();
    const nestedCall = createNamespaceRunner(
      'b',
      'grandchild',
      createEngineNestedCall,
      'child',
      [{
        workflow: 'parent',
        step: 'a',
        kind: 'workflow_call',
        call_instance: 1,
      }],
      parentFindingNamespace,
    );
    await nestedCall.runner.run(nestedCall.step);

    const createEngineFlatCall = createOwnerCollisionEngine();
    const flatCall = createNamespaceRunner('a#1/b', 'grandchild', createEngineFlatCall, 'parent');
    await flatCall.runner.run(flatCall.step);

    const nestedFindingNamespace = createEngineNestedCall.mock.calls[0]?.[3]?.findingCallNamespace as string;
    const nestedRunNamespace = createEngineNestedCall.mock.calls[0]?.[3]?.runPathNamespace as string[];
    const flatFindingNamespace = createEngineFlatCall.mock.calls[0]?.[3]?.findingCallNamespace as string;
    expect(nestedFindingNamespace).not.toBe(flatFindingNamespace);
    expect(nestedFindingNamespace.split('/')).toEqual([
      parentRunNamespace.at(-1),
      nestedRunNamespace.at(-1),
    ]);
  });

  it('WorkflowCallRunner は同じ workflow_call step を再実行しても child namespace を衝突させない', async () => {
    const childConfig = createParentWorkflow(tmpDir, {
      name: 'takt/coding',
      initial_step: 'review',
      subworkflow: {
        callable: true,
      },
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [
            {
              condition: 'done',
              next: 'COMPLETE',
            },
          ],
        },
      ],
    });
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
    const createEngine = vi.fn().mockImplementation((...args: unknown[]) => {
      const childIteration = (args[3] as { initialIteration: number }).initialIteration + 1;
      return {
        on: vi.fn(),
        getOwnedResumePoint: vi.fn(() => createOwnedResumePoint('child', 'review', childIteration)),
        runWithResult: vi.fn().mockResolvedValue({
          state: {
            workflowName: childConfig.name,
            currentStep: 'review',
            iteration: childIteration,
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
      };
    });
    const createRunner = (iteration: number, callInstance: number) => new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: {
        workflowName: parentConfig.name,
        currentStep: 'delegate',
        iteration,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map([['delegate', callInstance - 1]]),
        status: 'running',
      },
      projectCwd: tmpDir,
      getCwd: () => tmpDir,
      task: 'Workflow call namespace iteration isolation',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      ...createWorkflowCallProgressDeps(),
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      setActiveResumeStack: vi.fn(),
      adoptResumeCheckpoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await createRunner(0, 1).run(parentConfig.steps[0] as never);
    await createRunner(0, 2).run(parentConfig.steps[0] as never);
    await createRunner(7, 1).run(parentConfig.steps[0] as never);

    const firstNamespace = createEngine.mock.calls[0]?.[3]?.runPathNamespace;
    const secondNamespace = createEngine.mock.calls[1]?.[3]?.runPathNamespace;
    const sameInvocationAtDifferentIteration = createEngine.mock.calls[2]?.[3]?.runPathNamespace;
    const firstFindingNamespace = createEngine.mock.calls[0]?.[3]?.findingCallNamespace;
    const secondFindingNamespace = createEngine.mock.calls[1]?.[3]?.findingCallNamespace;

    expect(parseWorkflowCallNamespaceSegment(firstNamespace?.[1])?.callInstance).toBe(1);
    expect(parseWorkflowCallNamespaceSegment(secondNamespace?.[1])?.callInstance).toBe(2);
    expect(firstNamespace).not.toEqual(secondNamespace);
    expect(sameInvocationAtDifferentIteration).toEqual(firstNamespace);
    expect(firstFindingNamespace).toBe(firstNamespace?.[1]);
    expect(secondFindingNamespace).toBe(secondNamespace?.[1]);
  });

  it('parallel 内 workflow_call は child workflow 実行結果を親 parallel 集約へ渡す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
                { condition: 'ABORT', next: 'ABORT' },
              ],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        return makeResponse({ persona, content: 'Child review complete' });
      }
      if (persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const delegatedOutput = state.stepOutputs.get('delegate-review');
    const parentOutput = state.stepOutputs.get('reviewers');

    expect(state.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(delegatedOutput?.content).toBe('Child review complete');
    expect(parentOutput?.content).toContain('## delegate-review\nChild review complete');
    expect(parentOutput?.content).toContain('## local-review\nLocal review complete');
  });

  it('実 Engine の full run は正常完了後に root progress lease を解放する', async () => {
    const tracker = new WorkflowCallProgressTracker();
    const config = createParentWorkflow(tmpDir, {
      name: 'lease-normal',
      initial_step: 'work',
      max_steps: 1,
      steps: [{
        name: 'work',
        persona: 'worker',
        instruction: 'Work',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    mockRunAgentSequence([makeResponse({ persona: 'worker' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(config, tmpDir, 'Release normal lease', createWorkflowCallOptions(tmpDir, {
      sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker: tracker },
    }));

    expect(tracker.activeBranchCount()).toBe(0);
    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('実 Engine の full run は実行例外後にも root progress lease を解放する', async () => {
    const tracker = new WorkflowCallProgressTracker();
    const failure = new Error('step start listener failed');
    const config = createParentWorkflow(tmpDir, {
      name: 'lease-error',
      initial_step: 'work',
      max_steps: 1,
      steps: [{
        name: 'work',
        persona: 'worker',
        instruction: 'Work',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    });
    engine = new WorkflowEngine(config, tmpDir, 'Release failed lease', createWorkflowCallOptions(tmpDir, {
      sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker: tracker },
    }));
    engine.on('step:start', () => {
      throw failure;
    });

    await expect(engine.run()).rejects.toBe(failure);

    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('実 Engine の single iteration は非終端で root lease を保持し終端時に解放する', async () => {
    const tracker = new WorkflowCallProgressTracker();
    const config = createParentWorkflow(tmpDir, {
      name: 'lease-single-iteration',
      initial_step: 'first',
      max_steps: 2,
      steps: [
        {
          name: 'first',
          persona: 'first',
          instruction: 'First',
          rules: [{ condition: 'done', next: 'second' }],
        },
        {
          name: 'second',
          persona: 'second',
          instruction: 'Second',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    mockRunAgentSequence([
      makeResponse({ persona: 'first' }),
      makeResponse({ persona: 'second' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Retain single iteration lease', createWorkflowCallOptions(tmpDir, {
      sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker: tracker },
    }));

    const first = await engine.runSingleIteration();

    expect(first.isComplete).toBe(false);
    expect(tracker.activeBranchCount()).toBe(1);

    const second = await engine.runSingleIteration();

    expect(second.isComplete).toBe(true);
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('nested child Engine は完了時に自身の progress lease だけを解放する', async () => {
    const tracker = new WorkflowCallProgressTracker();
    const childConfig: WorkflowConfig = {
      name: 'lease-child',
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [makeRule('done', 'COMPLETE')],
      }],
    };
    const config = createParentWorkflow(tmpDir, {
      name: 'lease-parent',
      initial_step: 'delegate',
      max_steps: 1,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: childConfig.name,
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    mockRunAgentSequence([makeResponse({ persona: 'review' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const activeCountsAtCompletion: number[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Release nested child lease', createWorkflowCallOptions(tmpDir, {
      sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker: tracker },
      workflowCallResolver: () => childConfig,
    }));
    engine.on('workflow_call:complete', () => {
      activeCountsAtCompletion.push(tracker.activeBranchCount());
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(activeCountsAtCompletion).toEqual([1]);
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('parallel workflow_call child Engine は完了時に自身の progress lease だけを解放する', async () => {
    const tracker = new WorkflowCallProgressTracker();
    const childConfig: WorkflowConfig = {
      name: 'parallel-lease-child',
      subworkflow: { callable: true },
      initialStep: 'review',
      steps: [{
        name: 'review',
        persona: 'reviewer',
        instruction: 'Review',
        rules: [makeRule('done', 'COMPLETE')],
      }],
    };
    const config = createParentWorkflow(tmpDir, {
      name: 'parallel-lease-parent',
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [{
        name: 'reviewers',
        instruction: 'Review',
        parallel: [{
          name: 'delegate-review',
          kind: 'workflow_call',
          call: childConfig.name,
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    mockRunAgentSequence([makeResponse({ persona: 'review' })]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    const activeCountsAtCompletion: number[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Release parallel child lease', createWorkflowCallOptions(tmpDir, {
      sharedRuntime: { startedAtMs: Date.now(), workflowCallProgressTracker: tracker },
      workflowCallResolver: () => childConfig,
    }));
    engine.on('workflow_call:complete', () => {
      activeCountsAtCompletion.push(tracker.activeBranchCount());
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(activeCountsAtCompletion).toEqual([1]);
    expect(tracker.activeBranchCount()).toBe(0);
  });

  it('workflow_call vars は parallel caller から nested reviewer instruction まで継承される', async () => {
    writeWorkflow(tmpDir, 'shared/nested-review.yaml', `name: shared/nested-review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: nested-reviewer
    instruction: "mode={var:review_mode}; domain={var:domain}"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: nested-review
steps:
  - name: nested-review
    kind: workflow_call
    call: shared/nested-review
    vars:
      domain: frontend
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 4,
      steps: [{
        name: 'reviewers',
        instruction: 'Run reviewers',
        parallel: [{
          name: 'delegate-review',
          kind: 'workflow_call',
          call: 'shared/review',
          vars: {
            review_mode: 'follow_up',
            domain: 'base',
          },
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        }, {
          name: 'local-review',
          persona: 'local-reviewer',
          instruction: 'Review locally; mode={var:review_mode}',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'nested-reviewer' || persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run nested review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const nestedPrompt = vi.mocked(runAgent).mock.calls.find(([persona]) => (
      persona === 'nested-reviewer'
    ))?.[1];
    const localPrompt = vi.mocked(runAgent).mock.calls.find(([persona]) => (
      persona === 'local-reviewer'
    ))?.[1];

    expect(state.status).toBe('completed');
    expect(nestedPrompt).toContain('mode=follow_up; domain=frontend');
    expect(nestedPrompt).not.toContain('{var:');
    expect(localPrompt).toContain('mode=unspecified');
  });

  it('initial review の後は follow-up review だけを再実行する', async () => {
    writeWorkflow(tmpDir, 'shared/round-review.yaml', `name: shared/round-review
subworkflow:
  callable: true
  returns:
    - needs_fix
initial_step: review
steps:
  - name: review
    persona: round-reviewer
    instruction: "mode={var:review_mode}"
    rules:
      - condition: needs_fix
        return: needs_fix
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'review-do-while',
      initial_step: 'initial-review',
      max_steps: 20,
      steps: [{
        name: 'initial-review',
        kind: 'workflow_call',
        call: 'shared/round-review',
        vars: { review_mode: 'initial' },
        rules: [{ condition: 'COMPLETE', next: 'fix' }],
      }, {
        name: 'fix',
        persona: 'fixer',
        instruction: 'Fix the current findings',
        rules: [{ condition: 'fixed', next: 'follow-up-review' }],
      }, {
        name: 'follow-up-review',
        kind: 'workflow_call',
        call: 'shared/round-review',
        vars: { review_mode: 'follow_up' },
        rules: [
          { condition: 'needs_fix', next: 'fix' },
          { condition: 'COMPLETE', next: 'COMPLETE' },
        ],
      }],
    });
    const reviewPrompts: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'round-reviewer') {
        reviewPrompts.push(prompt);
        return makeResponse({ persona, content: 'Review complete' });
      }
      if (persona === 'fixer') {
        return makeResponse({ persona, content: 'Fix complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 1, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Review until complete', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(reviewPrompts.map((prompt) => (
      prompt.match(/mode=(initial|follow_up)/)?.[1]
    ))).toEqual(['initial', 'follow_up', 'follow_up']);
  });

  it('non-interactive parallel workflow_call の no-match は親 fallback rule より先に中断する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-first
steps:
  - name: child-first
    persona: child-reviewer
    instruction: "First child review"
    rules:
      - condition: done
        next: child-second
  - name: child-second
    persona: child-reviewer
    instruction: "Second child review"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 10,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [
                {
                  condition: 'COMPLETE',
                  next: 'COMPLETE',
                  interactive_only: true,
                },
              ],
            },
          ],
          rules: [
            { condition: 'when(true)', next: 'finish' },
          ],
        },
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish after parent fallback',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      return makeResponse({ persona: String(persona), content: 'done' });
    });
    vi.mocked(mockRuleEvaluation).mockReturnValue({ index: 0, method: 'auto_select' });
    engine = new WorkflowEngine(config, tmpDir, 'Reject parallel workflow call no-match', createWorkflowCallOptions(tmpDir, {
      interactive: false,
    }));
    const abortFn = vi.fn();
    const firstLifecycleInstances: number[] = [];
    engine.on('workflow:abort', abortFn);
    engine.on('workflow_call:start', (event) => firstLifecycleInstances.push(event.callInstance));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(state.status).toBe('aborted');
    expect(abortFn).toHaveBeenCalledWith(expect.anything(), 'rule_no_match', 'rule_no_match');
    expect(firstLifecycleInstances).toEqual([1]);
    expect(resumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'parent', step: 'reviewers', kind: 'agent' }),
      expect.objectContaining({
        workflow: 'parent',
        step: 'delegate-review',
        kind: 'workflow_call',
        call_instance: 1,
      }),
      expect.objectContaining({
        workflow: 'shared/review',
        step: 'child-second',
        kind: 'agent',
      }),
    ]);
    if (resumePoint === undefined) {
      throw new Error('Expected parallel workflow_call no-match resume point');
    }
    const parsedResumePoint = parseWorkflowResumePoint(
      JSON.parse(JSON.stringify(resumePoint)) as unknown,
    );
    expect(parsedResumePoint).toEqual(resumePoint);

    cleanupWorkflowEngine(engine);
    engine = null;
    const resumedLifecycleInstances: number[] = [];
    const resumedEngine = new WorkflowEngine(
      config,
      tmpDir,
      'Resume parallel workflow call no-match',
      createWorkflowCallOptions(tmpDir, {
        interactive: true,
        resumePoint: parsedResumePoint,
        startStep: parsedResumePoint.stack[0]!.step,
        initialIteration: parsedResumePoint.iteration,
      }),
    );
    resumedEngine.on('workflow_call:start', (event) => {
      resumedLifecycleInstances.push(event.callInstance);
    });
    const resumedStartedSteps: string[] = [];
    resumedEngine.on('step:start', (step) => resumedStartedSteps.push(step.name));

    const resumedState = await resumedEngine.run();

    expect(resumedState.status).toBe('completed');
    expect(resumedLifecycleInstances).toEqual([1]);
    expect(resumedStartedSteps).toEqual(['reviewers', 'child-second', 'finish']);
    expect(vi.mocked(runAgent).mock.calls.filter(([, prompt]) => prompt.includes('First child review'))).toHaveLength(1);
    expect(vi.mocked(runAgent).mock.calls.filter(([, prompt]) => prompt.includes('Second child review'))).toHaveLength(2);
  });

  it('parallel 内 workflow_call 後は親 parallel step の resume point に戻す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        return makeResponse({ persona, content: 'Child review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(state.status).toBe('completed');
    expect(resumePoint?.stack).toHaveLength(1);
    expect(resumePoint?.stack[0]).toEqual(expect.objectContaining({
      workflow: 'parent',
      step: 'reviewers',
    }));
  });

  it('parallel child 中断 stack を codec 後も同じ call instance と child step から再開する', async () => {
    writeWorkflow(tmpDir, 'shared/resumable-review.yaml', `name: shared/resumable-review
subworkflow:
  callable: true
initial_step: child-first
steps:
  - name: child-first
    persona: child-reviewer
    instruction: "First resumable child step"
    rules:
      - condition: done
        next: child-second
  - name: child-second
    persona: child-reviewer
    instruction: "Second resumable child step"
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [{
        name: 'reviewers',
        instruction: 'Run resumable reviewers',
        parallel: [{
          name: 'delegate-review',
          kind: 'workflow_call',
          call: 'shared/resumable-review',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        }],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    let secondAttempts = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('Second resumable child step')) {
        secondAttempts += 1;
        return secondAttempts === 1
          ? makeResponse({ persona: String(persona), status: 'error', error: 'interrupt child' })
          : makeResponse({ persona: String(persona), content: 'Second complete' });
      }
      if (prompt.includes('First resumable child step')) {
        return makeResponse({ persona: String(persona), content: 'First complete' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((step) => (
      step.name === 'reviewers' && secondAttempts === 1
        ? undefined
        : { index: 0, method: 'phase3_tag' }
    ));
    const firstLifecycleInstances: number[] = [];
    engine = new WorkflowEngine(config, tmpDir, 'Interrupt parallel child', createWorkflowCallOptions(tmpDir, {
      onIterationLimit: vi.fn().mockResolvedValue(3),
    }));
    engine.on('workflow_call:start', (event) => firstLifecycleInstances.push(event.callInstance));

    const interruptedState = await engine.run();
    const interruptedResumePoint = engine.getResumePoint();

    expect(interruptedState.status).toBe('aborted');
    expect(interruptedState.iteration).toBe(3);
    expect(interruptedResumePoint?.max_steps).toBe(5);
    expect(interruptedResumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'parent', step: 'reviewers', kind: 'agent' }),
      expect.objectContaining({
        workflow: 'parent',
        step: 'delegate-review',
        kind: 'workflow_call',
        call_instance: 1,
      }),
      expect.objectContaining({
        workflow: 'shared/resumable-review',
        step: 'child-second',
        kind: 'agent',
      }),
    ]);
    expect(firstLifecycleInstances).toEqual([1]);
    if (interruptedResumePoint === undefined) {
      throw new Error('Expected interrupted parallel resume point');
    }
    const parsedResumePoint = parseWorkflowResumePoint(
      JSON.parse(JSON.stringify(interruptedResumePoint)) as unknown,
    );
    const resumedChildWorkflow = loadWorkflowOrThrow('shared/resumable-review', tmpDir);
    expect({
      resumeEntry: parsedResumePoint.stack[2],
      workflowReference: getWorkflowReference(resumedChildWorkflow),
    }).toEqual({
      resumeEntry: expect.objectContaining({
        workflow: 'shared/resumable-review',
        workflow_ref: getWorkflowReference(resumedChildWorkflow),
        step: 'child-second',
      }),
      workflowReference: getWorkflowReference(resumedChildWorkflow),
    });

    cleanupWorkflowEngine(engine);
    engine = null;
    const resumedLifecycleInstances: number[] = [];
    const resumedEngine = new WorkflowEngine(
      config,
      tmpDir,
      'Resume parallel child',
      createWorkflowCallOptions(tmpDir, {
        resumePoint: parsedResumePoint,
        startStep: parsedResumePoint.stack[0]!.step,
        initialIteration: parsedResumePoint.iteration,
        onIterationLimit: vi.fn().mockResolvedValue(null),
      }),
    );
    resumedEngine.on('workflow_call:start', (event) => {
      resumedLifecycleInstances.push(event.callInstance);
    });
    let resumedAbortReason: string | undefined;
    const resumedStartedSteps: string[] = [];
    resumedEngine.on('workflow:abort', (_state, reason) => {
      resumedAbortReason = reason;
    });
    resumedEngine.on('step:start', (step) => resumedStartedSteps.push(step.name));

    const resumedState = await resumedEngine.run();

    expect({
      status: resumedState.status,
      reason: resumedAbortReason,
      startedSteps: resumedStartedSteps,
    }).toEqual({
      status: 'completed',
      reason: undefined,
      startedSteps: ['reviewers', 'child-second'],
    });
    expect(resumedState.iteration).toBe(5);
    expect(resumedLifecycleInstances).toEqual([1]);
    expect(vi.mocked(runAgent).mock.calls.filter(([, prompt]) => (
      prompt.includes('First resumable child step')
    ))).toHaveLength(1);
    expect(vi.mocked(runAgent).mock.calls.filter(([, prompt]) => (
      prompt.includes('Second resumable child step')
    ))).toHaveLength(2);
    expect(resumedEngine.getResumePoint()?.max_steps).toBe(5);
  });

  it('parallel 内 workflow_call の iteration limit 延長を親 workflow に同期する', async () => {
    writeWorkflow(tmpDir, 'shared/two-step-review.yaml', `name: shared/two-step-review
subworkflow:
  callable: true
initial_step: child-first
steps:
  - name: child-first
    persona: child-reviewer
    instruction: "First child step"
    rules:
      - condition: done
        next: child-second
  - name: child-second
    persona: child-reviewer
    instruction: "Second child step"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 2,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/two-step-review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'finish' },
          ],
        },
        {
          name: 'finish',
          persona: 'finisher',
          instruction: 'Finish parent workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });
    const onIterationLimit = vi.fn().mockResolvedValueOnce(3);
    let finishAttempts = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('First child step')) {
        return makeResponse({ persona: String(persona), content: 'First child complete' });
      }
      if (prompt.includes('Second child step')) {
        return makeResponse({ persona: String(persona), content: 'Second child complete' });
      }
      if (persona === 'finisher') {
        finishAttempts += 1;
        if (finishAttempts === 1) {
          return makeResponse({ persona, status: 'error', error: 'interrupt after extension' });
        }
        return makeResponse({ persona, content: 'Parent finish complete' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));
    const observedMaxSteps: Array<number | 'infinite'> = [];
    engine.on('step:start', (...args) => observedMaxSteps.push(args[7] as number | 'infinite'));

    const state = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 2,
      maxSteps: 2,
      currentStep: 'child-second',
    }));
    expect(onIterationLimit.mock.calls[0]?.[0].scope.stack.at(-1)?.step).toBe('child-second');
    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(4);
    expect(resumePoint?.max_steps).toBe(5);
    expect(resumePoint?.stack.at(-1)).toEqual(expect.objectContaining({
      workflow: 'parent',
      step: 'finish',
    }));
    expect(observedMaxSteps).toEqual([2, 2, 5, 5]);

    const resumedIterationLimit = vi.fn().mockResolvedValue(null);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const resumedEngine = new WorkflowEngine(
      config,
      tmpDir,
      'Resume delegated parallel review',
      createWorkflowCallOptions(tmpDir, {
        resumePoint,
        startStep: resumePoint?.stack[0]?.step,
        initialIteration: resumePoint?.iteration,
        onIterationLimit: resumedIterationLimit,
      }),
    );
    let resumedAbortReason: string | undefined;
    const resumedStartedSteps: string[] = [];
    resumedEngine.on('workflow:abort', (_state, reason) => {
      resumedAbortReason = reason;
    });
    resumedEngine.on('step:start', (step) => resumedStartedSteps.push(step.name));

    const resumedState = await resumedEngine.run();

    expect({
      status: resumedState.status,
      reason: resumedAbortReason,
      currentStep: resumedState.currentStep,
      startedSteps: resumedStartedSteps,
    }).toEqual({
      status: 'completed',
      reason: undefined,
      currentStep: 'finish',
      startedSteps: ['finish'],
    });
    expect(resumedState.iteration).toBe(5);
    expect(resumedEngine.getResumePoint()?.max_steps).toBe(5);
    expect(resumedIterationLimit).not.toHaveBeenCalled();
  });

  it('parallel fallback retry は rate-limited agent slot だけを再実行する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Review through child workflow"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 4,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'shared/review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    const childProviderCalls: Array<{ resolvedProvider: string | undefined; resolvedModel: string | undefined }> = [];
    let localAttempts = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'child-reviewer') {
        childProviderCalls.push({
          resolvedProvider: options?.resolvedProvider,
          resolvedModel: options?.resolvedModel,
        });
        return makeResponse({ persona, content: 'Child review complete' });
      }
      if (persona === 'local-reviewer') {
        localAttempts += 1;
        if (localAttempts === 1) {
          return makeResponse({
            persona,
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
        }
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir, {
      rateLimitFallback: {
        switchChain: [{ provider: 'codex', model: 'gpt-5' }],
      },
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(localAttempts).toBe(2);
    expect(childProviderCalls).toEqual([
      { resolvedProvider: 'mock', resolvedModel: 'parent-model' },
    ]);
  });

  it('parallel 内 workflow_call の解決失敗は parent parallel の error として集約する', async () => {
    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'delegate-review',
              kind: 'workflow_call',
              call: 'missing/review',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
            {
              name: 'local-review',
              persona: 'local-reviewer',
              instruction: 'Review locally',
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
              ],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (persona === 'local-reviewer') {
        return makeResponse({ persona, content: 'Local review complete' });
      }
      throw new Error(`Unexpected persona: ${String(persona)}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));
    const localPhaseScopes: WorkflowExecutionScope[] = [];
    engine.on('phase:start', (step, ...args) => {
      if (step.name === 'local-review') {
        localPhaseScopes.push(args.at(-1) as WorkflowExecutionScope);
      }
    });
    engine.on('phase:complete', (step, ...args) => {
      if (step.name === 'local-review') {
        localPhaseScopes.push(args.at(-1) as WorkflowExecutionScope);
      }
    });

    const state = await engine.run();
    const delegatedOutput = state.stepOutputs.get('delegate-review');
    const parentOutput = state.stepOutputs.get('reviewers');

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(delegatedOutput?.status).toBe('error');
    expect(delegatedOutput?.error).toContain('references unknown workflow "missing/review"');
    expect(parentOutput?.status).toBe('error');
    expect(parentOutput?.content).toContain('delegate-review');
    expect(parentOutput?.content).toContain('references unknown workflow "missing/review"');
    expect(parentOutput?.content).not.toContain('did not return session updates');
    expect(localPhaseScopes).toHaveLength(2);
    expect(localPhaseScopes[0]).toEqual(localPhaseScopes[1]);
    expect(localPhaseScopes[0]?.stack).toEqual([
      expect.objectContaining({ workflow: 'parent', step: 'reviewers', kind: 'agent' }),
    ]);
  });

  it.each(['slow', 'fast'] as const)(
    'parallel 内 workflow_call は %s child の完了が遅くても共有予算と成果物を決定的に merge する',
    async (delayedChild) => {
    writeWorkflow(tmpDir, 'shared/slow-review.yaml', `name: shared/slow-review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Slow child review"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/fast-review.yaml', `name: shared/fast-review
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Fast child review"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 1,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'slow-delegate',
              kind: 'workflow_call',
              call: 'shared/slow-review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
            {
              name: 'fast-delegate',
              kind: 'workflow_call',
              call: 'shared/fast-review',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('Slow child review')) {
        if (delayedChild === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return makeResponse({ persona: String(persona), content: 'Slow review complete', sessionId: 'slow-session' });
      }
      if (prompt.includes('Fast child review')) {
        if (delayedChild === 'fast') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return makeResponse({ persona: String(persona), content: 'Fast review complete', sessionId: 'fast-session' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    const onIterationLimit = vi.fn().mockResolvedValue(2);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel reviews', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));

    const state = await engine.run();
    const invocations = Object.entries(engine.getResumePoint()?.workflow_call_invocations ?? {});
    const reportNamespaces = invocations.map(([identity, invocation]) => buildWorkflowCallNamespaceSegment(
      identity,
      invocation.child_workflow_ref,
      invocation.call_instance,
    )).sort();

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(2);
    expect(engine.getResumePoint()?.iteration).toBe(state.iteration);
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(onIterationLimit).toHaveBeenCalledWith(expect.objectContaining({
      currentIteration: 1,
      maxSteps: 1,
      currentStep: 'child-review',
    }));
    expect(state.stepOutputs.get('slow-delegate')?.content).toBe('Slow review complete');
    expect(state.stepOutputs.get('fast-delegate')?.content).toBe('Fast review complete');
    expect(state.personaSessions.get('["child-reviewer","mock","parent-model"]')).toBe('fast-session');
    expect(invocations.map(([identity]) => JSON.parse(identity).step)).toEqual(
      expect.arrayContaining(['fast-delegate', 'slow-delegate']),
    );
    expect(new Set(invocations.map(([, invocation]) => invocation.child_workflow_ref)).size).toBe(2);
    for (const namespace of reportNamespaces) {
      expect(existsSync(join(
        tmpDir,
        '.takt',
        'runs',
        'test-report-dir',
        'reports',
        'subworkflows',
        namespace,
      ))).toBe(true);
    }
  });

  it('parallel 内 workflow_call は更新していない inherited child session を merge しない', async () => {
    writeWorkflow(tmpDir, 'shared/update-session.yaml', `name: shared/update-session
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Update inherited session"
    rules:
      - condition: done
        next: COMPLETE
`);
    writeWorkflow(tmpDir, 'shared/inherit-session.yaml', `name: shared/inherit-session
subworkflow:
  callable: true
initial_step: child-review
steps:
  - name: child-review
    persona: child-reviewer
    instruction: "Use inherited session"
    rules:
      - condition: done
        next: COMPLETE
`);

    const config = createParentWorkflow(tmpDir, {
      name: 'parent',
      initial_step: 'reviewers',
      max_steps: 3,
      steps: [
        {
          name: 'reviewers',
          instruction: 'Run reviewers',
          parallel: [
            {
              name: 'update-delegate',
              kind: 'workflow_call',
              call: 'shared/update-session',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
            {
              name: 'inherit-delegate',
              kind: 'workflow_call',
              call: 'shared/inherit-session',
              rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    });
    const sessionUpdates = vi.fn();
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      if (prompt.includes('Update inherited session')) {
        return makeResponse({ persona: String(persona), content: 'Session updated', sessionId: 'updated-session' });
      }
      if (prompt.includes('Use inherited session')) {
        return makeResponse({ persona: String(persona), content: 'Inherited session used', sessionId: undefined });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel reviews', createWorkflowCallOptions(tmpDir, {
      initialSessions: {
        '["child-reviewer","mock","parent-model"]': 'initial-session',
      },
      onSessionUpdate: sessionUpdates,
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('update-delegate')?.content).toBe('Session updated');
    expect(state.stepOutputs.get('inherit-delegate')?.content).toBe('Inherited session used');
    expect(state.personaSessions.get('["child-reviewer","mock","parent-model"]')).toBe('updated-session');
    expect(sessionUpdates).toHaveBeenCalledOnce();
    expect(sessionUpdates).toHaveBeenCalledWith('["child-reviewer","mock","parent-model"]', 'updated-session');
  });

  it('workflow_call の実 child Engine が commit した selection を親 resume point に保持する', async () => {
    writeWorkflow(tmpDir, 'shared/dynamic.yaml', `name: shared/dynamic
subworkflow:
  callable: true
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture
          instruction: Review architecture
          rules:
            - condition: approved
      pool:
        - name: frontend
          persona: frontend
          description: Review frontend changes
          instruction: Review frontend
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-dynamic-selection',
      initial_step: 'delegate',
      max_steps: 5,
      steps: [{
        name: 'delegate',
        kind: 'workflow_call',
        call: 'shared/dynamic',
        rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(options?.outputSchema === undefined
          ? {}
          : { structuredOutput: { selected_ids: ['frontend'], rationale: 'Frontend review is required.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review frontend changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
    }));

    const state = await engine.run();
    const selections = Object.values(engine.getResumePoint()?.dynamic_parallel_selections ?? {});

    expect(state.status, state.lastOutput?.content).toBe('completed');
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      selected_pool_ids: ['frontend'],
      effective_selection_ids: ['architecture', 'frontend'],
    });
  });

  it('親子の dynamic selection を child round の resume 後も個別に復元する', async () => {
    writeWorkflow(tmpDir, 'shared/child-dynamic.yaml', `name: shared/child-dynamic
subworkflow:
  callable: true
initial_step: child-reviewers
steps:
  - name: child-reviewers
    parallel:
      fixed:
        - name: child-architecture
          persona: child-architecture
          instruction: Review child architecture
          rules:
            - condition: approved
      pool:
        - name: frontend
          persona: frontend
          description: Review frontend changes
          instruction: Review frontend
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-and-child-dynamic',
      initial_step: 'parent-reviewers',
      max_steps: 5,
      steps: [
        {
          name: 'parent-reviewers',
          parallel: {
            fixed: [{
              name: 'parent-architecture',
              persona: 'parent-architecture',
              instruction: 'Review parent architecture',
              rules: [{ condition: 'approved' }],
            }],
            pool: [{
              name: 'api',
              persona: 'api',
              description: 'Review API changes',
              instruction: 'Review API',
              rules: [{ condition: 'approved' }],
            }],
          },
          rules: [{ condition: 'all("approved")', next: 'delegate' }],
        },
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'shared/child-dynamic',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
        },
      ],
    });
    const persisted: import('../core/models/types.js').WorkflowResumePoint[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      const selectedId = options?.outputSchema === undefined
        ? undefined
        : JSON.stringify(options.outputSchema).includes('"api"') ? 'api' : 'frontend';
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(selectedId === undefined
          ? {}
          : { structuredOutput: { selected_ids: [selectedId], rationale: 'Required review.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review parent and child changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
      onDynamicParallelSelectionPersisted: (resumePoint) => {
        persisted.push(resumePoint);
      },
    }));

    const firstState = await engine.run();
    const childRoundResumePoint = persisted.at(-1);
    if (childRoundResumePoint === undefined) {
      throw new Error('Expected the child dynamic round resume point');
    }

    expect(firstState.status, firstState.lastOutput?.content).toBe('completed');
    expect(Object.values(childRoundResumePoint.dynamic_parallel_selections ?? {})).toHaveLength(2);
    expect(childRoundResumePoint.stack.map((entry) => entry.step)).toEqual([
      'delegate',
      'child-reviewers',
    ]);
    const [invocation] = Object.values(childRoundResumePoint.workflow_call_invocations ?? {});
    expect(invocation?.call_instance).toBe(1);
    expect(invocation?.child_workflow_ref).toMatch(/^project:sha256:[a-f0-9]{64}$/);

    vi.mocked(runAgent).mockClear();
    engine = new WorkflowEngine(config, tmpDir, 'Resume child review', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
      resumePoint: childRoundResumePoint,
      startStep: childRoundResumePoint.stack[0]?.step,
      initialIteration: childRoundResumePoint.iteration,
    }));
    const resumedState = await engine.run();
    const resumedSelections = [...resumedState.dynamicParallelSelections.values()];
    const selectorCalls = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => options?.outputSchema !== undefined);

    expect(resumedState.status, resumedState.lastOutput?.content).toBe('completed');
    expect(selectorCalls).toHaveLength(0);
    expect(resumedSelections).toHaveLength(2);
    expect(resumedSelections.map((selection) => selection.selected_pool_ids))
      .toEqual(expect.arrayContaining([['api'], ['frontend']]));
  });

  it('parallel sibling workflow_call child Engines retain both canonical selections in the parent resume point', async () => {
    const writeDynamicChild = (name: string, selectedPoolId: string) => writeWorkflow(tmpDir, `shared/${name}.yaml`, `name: shared/${name}
subworkflow:
  callable: true
initial_step: reviewers
steps:
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture-${name}
          instruction: Review architecture
          rules:
            - condition: approved
      pool:
        - name: ${selectedPoolId}
          persona: ${selectedPoolId}
          description: Review ${selectedPoolId} changes
          instruction: Review ${selectedPoolId}
          rules:
            - condition: approved
    rules:
      - condition: all("approved")
        next: COMPLETE
`);
    writeDynamicChild('left', 'frontend');
    writeDynamicChild('right', 'backend');
    const config = createParentWorkflow(tmpDir, {
      name: 'parent-parallel-dynamic-selections',
      initial_step: 'delegates',
      max_steps: 5,
      steps: [{
        name: 'delegates',
        parallel: [
          { name: 'left-call', kind: 'workflow_call', call: 'shared/left', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
          { name: 'right-call', kind: 'workflow_call', call: 'shared/right', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
        ],
        rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
      }],
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
      const selectedId = options?.outputSchema !== undefined
        && JSON.stringify(options.outputSchema).includes('backend')
        ? 'backend'
        : 'frontend';
      return makeResponse({
        persona: typeof persona === 'string' ? persona : 'selector',
        content: 'approved',
        ...(options?.outputSchema === undefined
          ? {}
          : { structuredOutput: { selected_ids: [selectedId], rationale: 'Required review.' } }),
      });
    });
    vi.mocked(mockRuleEvaluation).mockImplementation((_step, selection) => ({
      index: 0,
      method: selection === undefined ? 'aggregate' : 'phase3_tag',
    }));
    engine = new WorkflowEngine(config, tmpDir, 'Review frontend and backend changes', createWorkflowCallOptions(tmpDir, {
      selectorProvider: { provider: 'mock', providerOptions: {}, nativeTools: [] },
    }));
    const state = await engine.run();
    const selections = Object.values(engine.getResumePoint()?.dynamic_parallel_selections ?? {});

    expect(state.status, state.lastOutput?.content).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(6);
    expect(selections.map((selection) => selection.selected_pool_ids)).toEqual(expect.arrayContaining([
      ['frontend'],
      ['backend'],
    ]));
    expect(new Set(selections.map((selection) => selection.identity)).size).toBe(2);
  });

  it('異なる parallel 親に属する同名 workflow_call を別 owner identity と namespace で記録する', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: review
steps:
  - name: review
    persona: child-reviewer
    instruction: Review child
    rules:
      - condition: done
        next: COMPLETE
`);
    const config = createParentWorkflow(tmpDir, {
      name: 'parallel-owner-parent',
      initial_step: 'fanout_a',
      max_steps: 4,
      steps: [
        {
          name: 'fanout_a',
          parallel: [{
            name: 'delegate',
            kind: 'workflow_call',
            call: 'shared/review',
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          }],
          rules: [{ condition: 'all("COMPLETE")', next: 'fanout_b' }],
        },
        {
          name: 'fanout_b',
          parallel: [{
            name: 'delegate',
            kind: 'workflow_call',
            call: 'shared/review',
            rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
          }],
          rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }],
        },
      ],
    });
    mockPersonaResponses({ 'child-reviewer': 'done' });
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run both fanouts', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const invocationEntries = Object.entries(
      engine.getResumePoint()?.workflow_call_invocations ?? {},
    );

    expect(state.status, state.lastOutput?.content).toBe('completed');
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(invocationEntries).toHaveLength(2);
    expect(invocationEntries.map(([identity]) => identity)).toEqual(expect.arrayContaining([
      expect.stringContaining('"step":"fanout_a"'),
      expect.stringContaining('"step":"fanout_b"'),
    ]));
    expect(invocationEntries.map(([identity]) => JSON.parse(identity))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'delegate',
        owners: [expect.objectContaining({ kind: 'agent', step: 'fanout_a' })],
      }),
      expect.objectContaining({
        step: 'delegate',
        owners: [expect.objectContaining({ kind: 'agent', step: 'fanout_b' })],
      }),
    ]));
  });
});
