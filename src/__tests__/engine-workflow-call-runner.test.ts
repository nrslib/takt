import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getWorkflowTrustInfo } from '../infra/config/loaders/workflowTrustSource.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  buildWorkflowCallNamespaceSegment,
  parseWorkflowCallNamespaceSegment,
} from '../core/workflow/workflow-call-namespace.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockRuleEvaluationSequence,
} from './engine-test-helpers.js';
import { findWorkflowCallStep } from './testUtils/workflowCallStepTestHelper.js';
import { buildWorkflowCallInvocationRecordsFixture } from './helpers/workflow-resume-fixture.js';
import type {
  WorkflowConfig,
  WorkflowState,
  WorkflowStep,
} from '../core/models/index.js';
import { resetAnalyticsWriter } from '../features/analytics/writer.js';
import type { WorkflowCallResolver } from '../core/workflow/types.js';

import {
  createOwnedResumePoint,
  createParentWorkflow,
  createWorkflowCallOptions,
  createWorkflowCallProgressDeps,
  loadWorkflowOrThrow,
  mockPersonaResponses,
  writeWorkflow,
} from './helpers/engine-workflow-call-shared.js';

function expectedWorkflowCallNamespace(
  parentConfig: WorkflowConfig,
  stepName: string,
  occurrence: number,
  childConfig: WorkflowConfig,
): string[] {
  const runPathSegment = buildWorkflowCallSiteIdentity({
    stack: [{
      workflow: parentConfig.name,
      workflow_ref: getWorkflowReference(parentConfig),
      step: stepName,
      kind: 'workflow_call',
      occurrence,
    }],
    childWorkflow: childConfig,
  }).runPathSegment;
  return ['subworkflows', runPathSegment];
}

describe('WorkflowCallRunner integration', () => {
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
    const runWithResult = vi.fn().mockResolvedValue({
      state: childState,
      abort: {
        kind: 'step_transition',
        reason: 'Abort due to child ABORT rule',
        failure: {
          kind: 'step_transition',
          step: 'review',
          reason: 'Abort due to child ABORT rule',
          error: 'Abort due to child ABORT rule',
        },
      },
    });
    const createEngine = vi.fn().mockReturnValue({
      on: vi.fn(),
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
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Abort transition response',
      getOptions: () => createWorkflowCallOptions(tmpDir),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    const result = await runner.run(step, execution);

    expect(result.response.content).toBe('child abort output');
    expect(result.response.matchedRuleIndex).toBe(1);
    expect(result.workflowCallFailure).toEqual({
      kind: 'step_transition',
      step: 'review',
      reason: 'Abort due to child ABORT rule',
      error: 'Abort due to child ABORT rule',
    });
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
      runWithResult: vi.fn().mockResolvedValue({
        state: childState,
        abort: {
          kind: 'rule_no_match',
          reason: 'rule_no_match',
          failure: {
            kind: 'rule_no_match',
            step: 'review',
            reason: 'rule_no_match',
            error: 'rule_no_match',
          },
        },
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
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    const result = await runner.run(step, execution);

    expect(result.response.content).toBe('rule_no_match');
    expect(result.response.matchedRuleIndex).toBe(1);
    expect(parentState.lastOutput?.content).toBe('rule_no_match');
    expect(result.workflowCallFailure).toEqual({
      kind: 'rule_no_match',
      step: 'review',
      reason: 'rule_no_match',
      error: 'rule_no_match',
    });
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
        stepIterations: new Map([['delegate', 1]]),
        status: 'running',
      },
      projectCwd: tmpDir,
      getMaxSteps: () => parentConfig.maxSteps,
      updateMaxSteps: vi.fn(),
      getCwd: () => tmpDir,
      task: 'Resume same-name workflow by workflow_ref',
      getOptions: () => createWorkflowCallOptions(tmpDir, {
        resumePoint: {
          version: 2,
          stack: [
            {
              workflow: 'parent',
              workflow_ref: getWorkflowReference(parentConfig),
              step: 'delegate',
              kind: 'workflow_call',
              occurrence: 1,
              call_instance: 1,
            },
            {
              workflow: 'shared/workflow',
              workflow_ref: getWorkflowReference(childAConfig),
              step: 'fix',
              kind: 'agent',
              occurrence: 1,
            },
          ],
          iteration: 7,
          elapsed_ms: 183245,
          workflow_call_invocations: {
            [buildWorkflowCallInvocationIdentity(
              getWorkflowReference(parentConfig),
              'delegate',
              [],
            )]: {
              call_instance: 1,
              report_namespace_segment: expectedWorkflowCallNamespace(
                parentConfig,
                'delegate',
                1,
                childConfig,
              )[1]!,
            },
          },
          workflow_step_participations: {},
        },
      }),
      sharedRuntime: { startedAtMs: Date.now() },
      resumeStackPrefix: [],
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    await runner.run(step, execution);

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
    const childConfig = loadWorkflowOrThrow('takt/coding', tmpDir);

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child initial step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          {
            workflow: 'parent',
            workflow_ref: getWorkflowReference(config),
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 1,
            call_instance: 1,
          },
          {
            workflow: 'takt/coding',
            workflow_ref: getWorkflowReference(childConfig),
            step: 'review',
            kind: 'agent',
            occurrence: 1,
          },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {
          '{"workflow":"parent","step":"delegate","calls":[]}': {
            call_instance: 1,
            report_namespace_segment: expectedWorkflowCallNamespace(
              config,
              'delegate',
              1,
              childConfig,
            )[1]!,
          },
        },
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
    const childConfig = loadWorkflowOrThrow('takt/coding', tmpDir);

    vi.mocked(runAgent).mockResolvedValueOnce(makeResponse({
      persona: 'fixer',
      content: 'done',
    }));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    engine = new WorkflowEngine(config, tmpDir, 'Resume workflow_call from child resume step', createWorkflowCallOptions(tmpDir, {
      initialIteration: 7,
      resumePoint: {
        version: 2,
        stack: [
          {
            workflow: 'parent',
            workflow_ref: getWorkflowReference(config),
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 3,
            call_instance: 3,
            step_iterations: { delegate: 3 },
          },
          {
            workflow: 'takt/coding',
            workflow_ref: getWorkflowReference(childConfig),
            step: 'fix',
            kind: 'agent',
            occurrence: 7,
            step_iterations: { review: 4, fix: 6 },
          },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity('parent', 'delegate', [])]: {
            call_instance: 3,
            report_namespace_segment: expectedWorkflowCallNamespace(
              config,
              'delegate',
              3,
              childConfig,
            )[1]!,
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

    expect(state.status).toBeDefined();
    expect(calledPersona, state.lastOutput?.content).toContain('fixer');
    expect(fixStart?.[2]).toContain('Step Iteration: 7');
    expect(fixStart?.[6]).toBe(7);
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
    const childConfig = loadWorkflowOrThrow('takt/coding', tmpDir);
    const nestedChildConfig = loadWorkflowOrThrow('takt/review-loop', tmpDir);

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
          {
            workflow: 'parent',
            workflow_ref: getWorkflowReference(config),
            step: 'delegate',
            kind: 'workflow_call',
            occurrence: 1,
            call_instance: 1,
          },
          {
            workflow: 'takt/coding',
            workflow_ref: getWorkflowReference(childConfig),
            step: 'delegate_review',
            kind: 'workflow_call',
            occurrence: 1,
            call_instance: 1,
          },
          {
            workflow: 'takt/review-loop',
            workflow_ref: getWorkflowReference(nestedChildConfig),
            step: 'review',
            kind: 'agent',
            occurrence: 1,
          },
        ],
        iteration: 7,
        elapsed_ms: 183245,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(getWorkflowReference(config), 'delegate', [])]: {
            call_instance: 1,
            report_namespace_segment: expectedWorkflowCallNamespace(
              config,
              'delegate',
              1,
              childConfig,
            )[1]!,
          },
          [buildWorkflowCallInvocationIdentity(
            getWorkflowReference(childConfig),
            'delegate_review',
            [{
              workflow: 'parent',
              workflow_ref: getWorkflowReference(config),
              step: 'delegate',
              kind: 'workflow_call',
              occurrence: 1,
              call_instance: 1,
            }],
          )]: {
            call_instance: 1,
            report_namespace_segment: buildWorkflowCallSiteIdentity({
              stack: [
                {
                  workflow: 'parent',
                  workflow_ref: getWorkflowReference(config),
                  step: 'delegate',
                  kind: 'workflow_call',
                  occurrence: 1,
                  call_instance: 1,
                },
                {
                  workflow: 'takt/coding',
                  workflow_ref: getWorkflowReference(childConfig),
                  step: 'delegate_review',
                  kind: 'workflow_call',
                  occurrence: 1,
                  call_instance: 1,
                },
              ],
              childWorkflow: nestedChildConfig,
            }).runPathSegment,
          },
        },
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
        stepIterations: new Map([['delegate', 1]]),
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
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    await runner.run(step, execution);

    expect(createEngine).toHaveBeenCalledWith(
      childConfig,
      tmpDir,
      'Workflow call report namespace',
      expect.objectContaining({
        reportDirName: 'test-report-dir',
        runPathNamespace: expectedWorkflowCallNamespace(
          parentConfig,
          'delegate',
          1,
          childConfig,
        ),
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
        stepIterations: new Map([['delegate', 1]]),
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
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall,
      createEngine,
    });

    const step = rootWorkflow.steps[0] as never;
    const execution = runner.activateInvocation(step, 1, 1, []);
    await runner.run(step, execution);

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
      stepIterations: new Map([[stepName, 1]]),
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
          consumeWorkflowCallContinuation: vi.fn(),
          runPaths: {
            slug: 'test-report-dir',
          } as never,
          setActiveResumePoint: vi.fn(),
          emit: vi.fn(),
          resolveWorkflowCall: () => childConfig,
          createEngine,
        }),
        step: parentConfig.steps[0] as never,
        expectedNamespace: expectedWorkflowCallNamespace(
          parentConfig,
          stepName,
          1,
          childConfig,
        ),
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

    const executionA = runA.runner.activateInvocation(runA.step, 1, 1, []);
    const executionB = runB.runner.activateInvocation(runB.step, 1, 1, []);
    await runA.runner.run(runA.step, executionA);
    await runB.runner.run(runB.step, executionB);

    const namespaceA = createEngineA.mock.calls[0]?.[3]?.runPathNamespace;
    const namespaceB = createEngineB.mock.calls[0]?.[3]?.runPathNamespace;

    expect(namespaceA).toEqual(runA.expectedNamespace);
    expect(namespaceB).toEqual(runB.expectedNamespace);
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
        stepIterations: new Map([['delegate', iteration]]),
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
      consumeWorkflowCallContinuation: vi.fn(),
      runPaths: {
        slug: 'test-report-dir',
      } as never,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: () => childConfig,
      createEngine,
    });

    const step = parentConfig.steps[0] as never;
    const firstRunner = createRunner(1);
    const secondRunner = createRunner(3);
    const firstExecution = firstRunner.activateInvocation(step, 1, 1, []);
    const secondExecution = secondRunner.activateInvocation(step, 3, 3, []);
    await firstRunner.run(step, firstExecution);
    await secondRunner.run(step, secondExecution);

    const firstNamespace = createEngine.mock.calls[0]?.[3]?.runPathNamespace;
    const secondNamespace = createEngine.mock.calls[1]?.[3]?.runPathNamespace;

    expect(firstNamespace).toEqual(expectedWorkflowCallNamespace(
      parentConfig,
      'delegate',
      1,
      childConfig,
    ));
    expect(secondNamespace).toEqual(expectedWorkflowCallNamespace(
      parentConfig,
      'delegate',
      3,
      childConfig,
    ));
    expect(firstNamespace).not.toEqual(secondNamespace);
  });

});
