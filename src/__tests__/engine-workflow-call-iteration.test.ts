import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

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
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';
import { buildWorkflowCallInvocationRecordsFixture } from './helpers/workflow-resume-fixture.js';
import type {
  WorkflowConfig,
  WorkflowState,
} from '../core/models/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';

import {
  createOwnedResumePoint,
  createParentWorkflow,
  createWorkflowCallOptions,
  createWorkflowCallProgressDeps,
  loadWorkflowOrThrow,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

describe('WorkflowEngine workflow_call iteration budget and abort', () => {
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
});
