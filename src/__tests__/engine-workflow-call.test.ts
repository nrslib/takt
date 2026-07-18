import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn(),
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
import {
  applyWorkflowCallOverridesToPersonaProviders,
  applyWorkflowCallOverridesToProviderRouting,
} from '../core/workflow/engine/WorkflowCallExecutor.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockDetectMatchedRuleSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';
import type { AutoRoutingConfig, WorkflowConfig } from '../core/models/index.js';
import { initAnalyticsWriter } from '../features/analytics/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import { AnalyticsEmitter } from '../features/tasks/execute/analyticsEmitter.js';
import type { RoutingDecisionEvent } from '../features/analytics/index.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';

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
        costTier: 'medium',
      },
      {
        name: 'reasoning',
        description: 'Architecture and planning',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        costTier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        costTier: 'medium',
      },
      {
        name: 'lightweight',
        description: 'Formatting',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        costTier: 'low',
      },
    ],
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
      maxSteps: 2,
      steps: [
        {
          name: 'finish-child',
          persona: 'child-finisher',
          instruction: 'Finish child without delegation',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
        {
          name: 'unreachable-grandchild',
          kind: 'workflow_call',
          call: 'grandchild-that-must-not-load',
          rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
      maxSteps: 1,
      steps: [{
        name: 'child-step',
        personaDisplayName: 'Child',
        instruction: 'Run child',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Preserve CLI workflow_call overrides',
      getOptions: () => createWorkflowCallOptions(tmpDir, options),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });
    const step = parentConfig.steps[0] as never;

    expect(runner.resolveRuntime(step)).toEqual({
      providerInfo: expected,
    });
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
      maxSteps: 5,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Preserve auto workflow_call models',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        provider: 'codex',
        model: 'parent-runtime-model',
        autoRouting: createWorkflowCallAutoRoutingConfig(),
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig as never,
      createEngine,
    });
    const step = parentConfig.steps[0] as never;

    expect(runner.resolveRuntime(step)).toEqual({
      providerInfo: {
        provider: 'mock',
        providerSource: 'workflow_call',
        model: 'workflow-call-model',
        modelSource: 'workflow_call',
      },
    });

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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
max_steps: 2
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
max_steps: 2
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
max_steps: 2
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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

  it('workflow_call の step:start と loop monitor judge は child 実行と同じ provider context を使う', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
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
      max_steps: 4,
      loop_monitors: [
        {
          cycle: ['delegate', 'delegate'],
          threshold: 1,
          judge: {
            persona: 'supervisor',
            rules: [
              { condition: 'Healthy', next: 'delegate' },
              { condition: 'Unproductive', next: 'COMPLETE' },
            ],
          },
        },
      ],
      steps: [
        {
          name: 'delegate',
          kind: 'workflow_call',
          call: 'takt/coding',
          rules: [
            {
              condition: 'COMPLETE',
              next: 'delegate',
            },
          ],
        },
      ],
    });

    mockPersonaResponses({
      reviewer: 'done',
      supervisor: 'Unproductive',
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 1, method: 'ai_judge_fallback' },
    ]);

    const startedProviderInfo: Array<{ provider: string | undefined; model: string | undefined }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Align workflow_call runtime context', createWorkflowCallOptions(tmpDir, {
      provider: 'claude',
      model: 'parent-model',
      personaProviders: {
        delegate: {
          provider: 'opencode',
          model: 'opencode/delegate-model',
        },
      },
    }));
    engine.on('step:start', (step, _iteration, _instruction, providerInfo) => {
      if (step.name === 'delegate') {
        startedProviderInfo.push(providerInfo);
      }
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(startedProviderInfo).toEqual([
      { provider: 'claude', model: 'parent-model' },
      { provider: 'claude', model: 'parent-model' },
    ]);
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));
    const judgeCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('supervisor'));
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      resolvedModel: 'parent-model',
    }));
    expect(judgeCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      resolvedModel: 'parent-model',
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
          content: '{"selected_candidate":"coding"}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Route child workflow with child context', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      autoRouting: createWorkflowCallAutoRoutingConfig(),
    }));
    const routingEventsDir = join(tmpDir, '.takt', 'events');
    initAnalyticsWriter(false, join(tmpDir, 'analytics'), { routingEventsDir });
    const analyticsEmitter = new AnalyticsEmitter('run-workflow-call-routing', 'mock', 'parent-model', 'parent');
    engine.on('step:start', (_step, iteration, instruction, providerInfo, workflowName) => {
      analyticsEmitter.updateProviderInfo(
        iteration,
        providerInfo.provider ?? 'mock',
        providerInfo.model ?? '(default)',
        workflowName,
      );
    });
    engine.on('step:complete', (step, response) => {
      analyticsEmitter.onStepComplete(step, response);
    });
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

    expect(state.status).toBe('completed');
    expect(routerCalls).toHaveLength(1);
    expect(routerCall?.[1]).toContain('Workflow: takt/coding');
    expect(routerCall?.[1]).not.toContain('Workflow: parent');
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
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
      selectedCategory: 'coding',
    });
  });

  it('workflow_call child は親 options の effective auto_routing を継承して未指定 step を routing する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
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
          content: '{"selected_candidate":"coding"}',
        });
      }
      return makeResponse({
        persona: 'reviewer',
        content: 'done',
      });
    });
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Route inherited auto provider child workflow', createWorkflowCallOptions(tmpDir, {
      provider: 'mock',
      model: undefined,
      autoRouting: createWorkflowCallAutoRoutingConfig(),
    }));

    const state = await engine.run();
    const childCall = vi.mocked(runAgent).mock.calls.find(([persona]) => String(persona).includes('reviewer'));

    expect(state.status).toBeDefined();
    expect(childCall?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5',
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
      cost_tier: medium
    - name: reasoning
      description: Architecture and planning
      provider: claude-sdk
      model: claude-opus-4-20250514
      cost_tier: high
  rules:
    steps:
      review: reasoning
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
      maxSteps: 5,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Concrete override child top-level auto',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        provider: 'mock',
        model: undefined,
        autoStrategyOverride: 'performance',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
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

  it('workflow_call child workflow の strategy override 後に必要 tier が欠ける場合は child engine で拒否する', async () => {
    const onEffectiveAutoRoutingReached = vi.fn();
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
    const childConfig = {
      name: 'takt/coding',
      provider: 'mock',
      autoRouting: {
        ...createWorkflowCallAutoRoutingConfig(),
        candidates: [
          {
            name: 'delegate-runtime',
            description: 'Workflow call delegation',
            provider: 'mock',
            model: 'parent-model',
            costTier: 'medium',
          },
        ],
      },
      subworkflow: { callable: true },
      initialStep: 'review',
      maxSteps: 5,
      steps: [
        {
          name: 'review',
          persona: 'reviewer',
          instruction: 'Review child workflow',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    };
    const createEngine = vi.fn((
      workflow: WorkflowConfig,
      cwd: string,
      task: string,
      engineOptions: ConstructorParameters<typeof WorkflowEngine>[3],
    ) => new WorkflowEngine(workflow, cwd, task, engineOptions));
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Reject child auto strategy',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        provider: 'mock',
        model: undefined,
        autoStrategyOverride: 'performance',
        onEffectiveAutoRoutingReached,
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: { slug: 'test-report-dir' } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig as never,
      createEngine,
    });

    await expect(runner.run(parentConfig.steps[0] as never)).rejects.toThrow(/performance|high|candidate/i);
    expect(createEngine).toHaveBeenCalledOnce();
    expect(onEffectiveAutoRoutingReached).toHaveBeenCalledOnce();
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

  it('workflow_call cycle を検出して停止する', async () => {
    writeWorkflow(tmpDir, 'a.yaml', `name: a
subworkflow:
  callable: true
initial_step: delegate
max_steps: 5
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
max_steps: 5
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

    engine = new WorkflowEngine(loadWorkflowOrThrow('a', tmpDir), tmpDir, 'Detect workflow call cycle', createWorkflowCallOptions(tmpDir));

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
max_steps: 5
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
max_steps: 5
steps:
  - name: review
    persona: reviewer
    instruction: "Deep child"
    rules:
      - condition: done
        next: COMPLETE
`);
    }

    engine = new WorkflowEngine(loadWorkflowOrThrow('w1', tmpDir), tmpDir, 'Detect workflow depth limit', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'when rule',
      rule: 'when: "true"\n        next: COMPLETE',
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
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
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
max_steps: 5
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
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
max_steps: 5
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
max_steps: 5
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
max_steps: 5
steps:
  - name: route_context
    kind: system
    effects:
      - type: merge_pr
        pr: 42
    rules:
      - when: "true"
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    engine = new WorkflowEngine(config, tmpDir, 'Abort branch with exception', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();
    const plannerPrompt = vi.mocked(runAgent).mock.calls[2]?.[1];

    expect(state.status).toBe('completed');
    expect(plannerPrompt).toContain('Step execution failed: child exploded');
    expect(plannerPrompt).not.toContain('Review done');
  });

  it('子 workflow の step も親 run の max_steps 予算を消費する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
    ]);

    const startedIterations: Array<{ step: string; iteration: number }> = [];
    engine = new WorkflowEngine(config, tmpDir, 'Budget test', createWorkflowCallOptions(tmpDir));
    engine.on('step:start', (step, iteration) => {
      startedIterations.push({ step: step.name, iteration });
    });

    const state = await engine.run();
    const calledPersonas = vi.mocked(runAgent).mock.calls
      .map(([persona]) => typeof persona === 'string' ? persona : '');

    expect(state.status).toBe('aborted');
    expect(state.iteration).toBe(2);
    expect(startedIterations).toEqual([
      { step: 'delegate', iteration: 1 },
      { step: 'review', iteration: 2 },
    ]);
    expect(calledPersonas.some((persona) => persona.includes('fixer'))).toBe(false);
    expect(calledPersonas.some((persona) => persona.includes('supervisor'))).toBe(false);
  });

  it('子 workflow で max_steps を延長した場合も親 run へ共有予算を引き継いで継続する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    expect(state.iteration).toBe(4);
    expect(onIterationLimit).toHaveBeenCalledOnce();
    expect(startedIterations).toEqual([
      { step: 'delegate', iteration: 1 },
      { step: 'review', iteration: 2 },
      { step: 'fix', iteration: 3 },
      { step: 'final_review', iteration: 4 },
    ]);
  });

  it('ignoreIterationLimit は workflow_call 配下の child workflow にも伝搬して完走できる', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
    expect(state.iteration).toBe(4);
    expect(onIterationLimit).not.toHaveBeenCalled();
    expect(startedIterations).toEqual([
      { step: 'delegate', iteration: 1 },
      { step: 'review', iteration: 2 },
      { step: 'fix', iteration: 3 },
      { step: 'final_review', iteration: 4 },
    ]);
  });

  it('子 workflow で次 step 決定直後に max_steps へ達しても resume_point は最新 child step を指す', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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

    vi.mocked(runAgent).mockImplementationOnce(async (persona, prompt, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: prompt,
      });
      return makeResponse({
        persona: 'reviewer',
        content: 'Review done',
      });
    });
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

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
    });
    expect(capturedResumePoint?.stack[1]).toEqual(expect.objectContaining({
      workflow: 'takt/coding',
      step: 'fix',
      kind: 'agent',
    }));
    expect(capturedResumePoint?.iteration).toBe(2);
  });

  it('resolveWorkflowCallTarget は child workflow の max_steps を書き換えない', () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
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

    expect(childWorkflow?.maxSteps).toBe(5);
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
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
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
max_steps: 5
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
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Allow same-name subworkflow from another source',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.matchedRuleIndex).toBe(0);
    expect(createEngine).toHaveBeenCalledTimes(1);
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
      maxSteps: 5,
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
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
        abort: {
          kind: 'step_transition',
          reason: 'Abort due to child ABORT rule',
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Abort transition response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('child abort output');
    expect(result.response.matchedRuleIndex).toBe(1);
  });

  it('WorkflowCallRunner は non-step_transition abort で reason と lastOutput がなくても ABORT を優先する', async () => {
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
      maxSteps: 5,
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
      stepIterations: new Map(),
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
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
      }),
    });
    const runner = new WorkflowCallRunner({
      getConfig: () => parentConfig,
      state: parentState,
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Abort fallback response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const result = await runner.run(parentConfig.steps[0] as never);

    expect(result.response.content).toBe('ABORT');
    expect(result.response.matchedRuleIndex).toBe(1);
    expect(parentState.lastOutput?.content).toBe('ABORT');
  });

  it('resume_point は workflow_ref が一致する child workflow にだけ適用する', async () => {
    writeWorkflow(tmpDir, 'child-a.yaml', `name: shared/workflow
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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
max_steps: 5
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
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Resume same-name workflow by workflow_ref',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        resumePoint: {
          version: 1,
          stack: [
            { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
            {
              workflow: 'shared/workflow',
              workflow_ref: getWorkflowReference(childAConfig),
              step: 'fix',
              kind: 'agent',
            },
          ],
          iteration: 7,
          elapsed_ms: 183245,
        },
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child initial step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
  });

  it('resume_point の child step が残っていればその step から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: review
max_steps: 5
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

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child resume step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'fix', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
  });

  it('resume_point の深い child step が消えていたら直近の workflow_call から再開する', async () => {
    writeWorkflow(tmpDir, 'takt/coding.yaml', `name: takt/coding
subworkflow:
  callable: true
initial_step: delegate_review
max_steps: 5
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
max_steps: 5
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
    mockDetectMatchedRuleSequence([{ index: 0, method: 'phase1_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume nested workflow_call from nearest valid parent', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 1,
        stack: [
          { workflow: 'parent', step: 'delegate', kind: 'workflow_call' },
          { workflow: 'takt/coding', step: 'delegate_review', kind: 'workflow_call' },
          { workflow: 'takt/review-loop', step: 'review', kind: 'agent' },
        ],
        iteration: 7,
        elapsed_ms: 183245,
      },
    }));

    const state = await engine.run();
    const calledPersona = vi.mocked(runAgent).mock.calls[0]?.[0];

    expect(state.status).toBeDefined();
    expect(calledPersona).toContain('fixer');
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
      max_steps: 4,
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Workflow call report namespace',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
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
        runPathNamespace: ['subworkflows', 'iteration-1--step-delegate--workflow-takt%2Fcoding'],
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
max_steps: 3
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
max_steps: 3
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
max_steps: 3
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
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => rootWorkflow.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Nested workflow call resolver context',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
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
    ) => {
      const parentConfig = createParentWorkflow(tmpDir, {
        name: `parent-${stepName}`,
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
        max_steps: 4,
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
          getMaxSteps: () => parentConfig.maxSteps,
          updateMaxSteps: vi.fn(),
          getCwd: () => tmpDir,
          task: 'Workflow call namespace collision',
          getOptions: () => ({
            ...createWorkflowCallOptions(tmpDir),
            reportDirName: 'test-report-dir',
          }),
          sharedRuntime: { startedAtMs: Date.now() },
          resumeStackPrefix: [],
          runPaths: {
            slug: 'test-report-dir',
          } as never,
          setActiveResumePoint: vi.fn(),
          emit: vi.fn(),
          resolveWorkflowCall: () => childConfig,
          createEngine,
        }),
        step: parentConfig.steps[0] as never,
      };
    };

    const createEngineA = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const createEngineB = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({ state: createChildState() }),
    });
    const runA = createNamespaceRunner('delegate/a', 'takt:review', createEngineA);
    const runB = createNamespaceRunner('delegate:a', 'takt/review', createEngineB);

    await runA.runner.run(runA.step);
    await runB.runner.run(runB.step);

    const namespaceA = createEngineA.mock.calls[0]?.[3]?.runPathNamespace;
    const namespaceB = createEngineB.mock.calls[0]?.[3]?.runPathNamespace;

    expect(namespaceA).toEqual(['subworkflows', 'iteration-1--step-delegate%2Fa--workflow-takt%3Areview']);
    expect(namespaceB).toEqual(['subworkflows', 'iteration-1--step-delegate%3Aa--workflow-takt%2Freview']);
    expect(namespaceA).not.toEqual(namespaceB);
  });

  it('WorkflowCallRunner は同じ workflow_call step を再実行しても child namespace を衝突させない', async () => {
    const childConfig = createParentWorkflow(tmpDir, {
      name: 'takt/coding',
      initial_step: 'review',
      max_steps: 4,
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
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
      runWithResult: vi.fn().mockResolvedValue({
        state: {
          workflowName: childConfig.name,
          currentStep: 'review',
          iteration: 4,
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
    const createRunner = (iteration: number) => new WorkflowCallRunner({
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
        stepIterations: new Map(),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Workflow call namespace iteration isolation',
      getOptions: () => ({
        ...createWorkflowCallOptions(tmpDir),
        reportDirName: 'test-report-dir',
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    await createRunner(1).run(parentConfig.steps[0] as never);
    await createRunner(3).run(parentConfig.steps[0] as never);

    const firstNamespace = createEngine.mock.calls[0]?.[3]?.runPathNamespace;
    const secondNamespace = createEngine.mock.calls[1]?.[3]?.runPathNamespace;

    expect(firstNamespace).toEqual(['subworkflows', 'iteration-1--step-delegate--workflow-takt%2Fcoding']);
    expect(secondNamespace).toEqual(['subworkflows', 'iteration-3--step-delegate--workflow-takt%2Fcoding']);
    expect(firstNamespace).not.toEqual(secondNamespace);
  });

  it('parallel 内 workflow_call は child workflow 実行結果を親 parallel 集約へ渡す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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

  it('parallel 内 workflow_call 後は親 parallel step の resume point に戻す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
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

  it('parallel 内 workflow_call の iteration limit 延長を親 workflow に同期する', async () => {
    writeWorkflow(tmpDir, 'shared/two-step-review.yaml', `name: shared/two-step-review
subworkflow:
  callable: true
initial_step: child-first
max_steps: 10
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
        return makeResponse({ persona, content: 'Parent finish complete' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir, {
      onIterationLimit,
    }));

    const state = await engine.run();

    expect(onIterationLimit).toHaveBeenCalledWith({
      currentIteration: 2,
      maxSteps: 2,
      currentStep: 'child-second',
    });
    expect(state.status).toBe('completed');
    expect(state.lastOutput?.content).toBe('Parent finish complete');
    expect(state.iteration).toBe(4);
  });

  it('parallel fallback retry 中の workflow_call は fallback provider を child workflow へ渡す', async () => {
    writeWorkflow(tmpDir, 'shared/review.yaml', `name: shared/review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
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
      { resolvedProvider: 'codex', resolvedModel: 'gpt-5' },
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel review', createWorkflowCallOptions(tmpDir));

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
  });

  it('parallel 内 workflow_call は child session を sub-step 定義順で決定的に merge する', async () => {
    writeWorkflow(tmpDir, 'shared/slow-review.yaml', `name: shared/slow-review
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
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
max_steps: 3
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
      max_steps: 3,
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
        await new Promise((resolve) => setTimeout(resolve, 20));
        return makeResponse({ persona: String(persona), content: 'Slow review complete', sessionId: 'slow-session' });
      }
      if (prompt.includes('Fast child review')) {
        return makeResponse({ persona: String(persona), content: 'Fast review complete', sessionId: 'fast-session' });
      }
      throw new Error(`Unexpected prompt: ${prompt}`);
    });
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel reviews', createWorkflowCallOptions(tmpDir));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('slow-delegate')?.content).toBe('Slow review complete');
    expect(state.stepOutputs.get('fast-delegate')?.content).toBe('Fast review complete');
    expect(state.personaSessions.get('child-reviewer:mock')).toBe('fast-session');
  });

  it('parallel 内 workflow_call は更新していない inherited child session を merge しない', async () => {
    writeWorkflow(tmpDir, 'shared/update-session.yaml', `name: shared/update-session
subworkflow:
  callable: true
initial_step: child-review
max_steps: 3
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
max_steps: 3
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
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);
    engine = new WorkflowEngine(config, tmpDir, 'Run delegated parallel reviews', createWorkflowCallOptions(tmpDir, {
      initialSessions: {
        'child-reviewer:mock': 'initial-session',
      },
      onSessionUpdate: sessionUpdates,
    }));

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(state.stepOutputs.get('update-delegate')?.content).toBe('Session updated');
    expect(state.stepOutputs.get('inherit-delegate')?.content).toBe('Inherited session used');
    expect(state.personaSessions.get('child-reviewer:mock')).toBe('updated-session');
    expect(sessionUpdates).toHaveBeenCalledOnce();
    expect(sessionUpdates).toHaveBeenCalledWith('child-reviewer:mock', 'updated-session');
  });
});
