import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { runAgent } from '../agents/runner.js';
import type { WorkflowConfig, WorkflowResumePoint } from '../core/models/index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { GitSelectorCommandRunner } from '../infra/task/selector-git-command-runner.js';
import { WorkflowEngine } from './helpers/workflow-engine.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  createTestTmpDir,
  makeResponse,
  mockRunAgentSequence,
  mockRuleEvaluationSequence,
} from './engine-test-helpers.js';

function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = join(projectDir, '.takt', 'workflows', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

function writeFourLevelWorkflow(projectDir: string, maxSteps: number, recoverFromAbort = false): void {
  writeWorkflow(projectDir, 'root-resume.yaml', `name: root-resume
initial_step: delegate-one
max_steps: ${maxSteps}
steps:
  - name: delegate-one
    kind: workflow_call
    call: nested/level-one
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ${recoverFromAbort ? 'recover' : 'ABORT'}
${recoverFromAbort ? `  - name: recover
    persona: recovery-planner
    instruction: Recover after child abort
    rules:
      - condition: done
        next: COMPLETE
` : ''}`);
  writeWorkflow(projectDir, 'nested/level-one.yaml', `name: level-one
subworkflow:
  callable: true
initial_step: delegate-two
max_steps: 20
steps:
  - name: delegate-two
    kind: workflow_call
    call: ./level-two.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
  writeWorkflow(projectDir, 'nested/level-two.yaml', `name: level-two
subworkflow:
  callable: true
initial_step: delegate-three
max_steps: 20
steps:
  - name: delegate-three
    kind: workflow_call
    call: ./level-three.yaml
    rules:
      - condition: COMPLETE
        next: COMPLETE
      - condition: ABORT
        next: ABORT
`);
  writeWorkflow(projectDir, 'nested/level-three.yaml', `name: level-three
subworkflow:
  callable: true
initial_step: prepare
max_steps: 20
steps:
  - name: prepare
    persona: preparer
    instruction: Prepare leaf execution
    rules:
      - condition: done
        next: leaf
  - name: leaf
    persona: leaf-coder
    instruction: Execute leaf work
    rules:
      - condition: done
        next: COMPLETE
`);
}

function writeParentReviewRepairWorkflow(projectDir: string, recoverFromAbort = false): void {
  writeWorkflow(projectDir, 'root-revisit.yaml', `name: root-revisit
initial_step: parent-call
max_steps: 20
steps:
  - name: parent-call
    kind: workflow_call
    call: nested/revisit
    rules:
      - condition: COMPLETE
        next: parent-review
      - condition: DONE
        next: COMPLETE
      - condition: ABORT
        next: ${recoverFromAbort ? 'parent-repair' : 'ABORT'}
  - name: parent-review
    persona: parent-review
    instruction: Review the child result
    rules:
      - condition: needs_fix
        next: parent-repair
  - name: parent-repair
    persona: parent-repair
    instruction: Repair the parent result
    rules:
      - condition: done
        next: parent-call
`);
  writeWorkflow(projectDir, 'nested/revisit.yaml', `name: nested/revisit
subworkflow:
  callable: true
  returns: [DONE]
initial_step: child-review
max_steps: 20
steps:
  - name: child-review
    persona: child-review
    instruction: Review the child work
    rules:
      - condition: needs_fix
        next: child-fix
      - condition: done
        return: DONE
  - name: child-fix
    persona: child-fix
    instruction: Fix the child work
    rules:
      - condition: done
        next: COMPLETE
`);
}

function loadRootWorkflow(projectDir: string): WorkflowConfig {
  const workflow = loadWorkflowByIdentifier('root-resume', projectDir);
  if (workflow === null) {
    throw new Error('root-resume workflow was not loaded');
  }
  return workflow;
}

function loadRevisitWorkflow(projectDir: string): WorkflowConfig {
  const workflow = loadWorkflowByIdentifier('root-revisit', projectDir);
  if (workflow === null) {
    throw new Error('root-revisit workflow was not loaded');
  }
  return workflow;
}

function createOptions(
  projectDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectCwd: projectDir,
    provider: 'mock' as const,
    model: 'test-model',
    selectorGitCommandRunner: new GitSelectorCommandRunner(),
    workflowCallResolver: ({ parentWorkflow, step, projectCwd, lookupCwd }: Parameters<
      NonNullable<ConstructorParameters<typeof WorkflowEngine>[3]['workflowCallResolver']>
    >[0]) => resolveWorkflowCallTarget(parentWorkflow, step, projectCwd, lookupCwd),
    ...overrides,
  };
}

function expectFullLeafStack(
  resumePoint: WorkflowResumePoint | undefined,
  rootWorkflow: WorkflowConfig,
): asserts resumePoint is WorkflowResumePoint {
  expect(resumePoint).toBeDefined();
  expect(resumePoint!.stack).toHaveLength(4);
  expect(resumePoint!.stack.map((entry) => entry.step)).toEqual([
    'delegate-one',
    'delegate-two',
    'delegate-three',
    'leaf',
  ]);
  expect(resumePoint!.stack[0]).toEqual(expect.objectContaining({
    workflow: 'root-resume',
    workflow_ref: getWorkflowReference(rootWorkflow),
    kind: 'workflow_call',
  }));
  expect(resumePoint!.stack[3]).toEqual(expect.objectContaining({
    workflow: 'level-three',
    step: 'leaf',
    kind: 'agent',
  }));
}

describe('serial workflow_call abort resume checkpoints', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | null = null;

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
  });

  afterEach(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    cleanupWorkflowEngine(engine);
    engine = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves the four-level leaf checkpoint after a runtime abort and resumes from that leaf', async () => {
    writeFourLevelWorkflow(tmpDir, 10);
    const rootWorkflow = loadRootWorkflow(tmpDir);
    mockRunAgentSequence([makeResponse({ persona: 'preparer', content: 'done' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('leaf exploded'));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'runtime abort', createOptions(tmpDir));

    const aborted = await engine.run();
    const abortedResumePoint = engine.getResumePoint();

    expect(aborted.status).toBe('aborted');
    expect(aborted.iteration).toBe(2);
    expectFullLeafStack(abortedResumePoint, rootWorkflow);

    cleanupWorkflowEngine(engine);
    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([makeResponse({ persona: 'leaf-coder', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    const startedSteps: string[] = [];
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'runtime abort retry', createOptions(tmpDir, {
      startStep: 'delegate-one',
      resumePoint: abortedResumePoint,
    }));
    engine.on('step:start', (step) => startedSteps.push(step.name));

    const resumed = await engine.run();

    expect(resumed.status).toBe('completed');
    expect(vi.mocked(runAgent)).toHaveBeenCalledOnce();
    expect(startedSteps).toEqual(['leaf']);
    expect(engine.getResumePoint()?.stack).toEqual([
      expect.objectContaining({
        workflow: 'root-resume',
        step: 'delegate-one',
        kind: 'workflow_call',
      }),
    ]);
  });

  it('preserves the four-level pending leaf checkpoint after an iteration-limit abort', async () => {
    writeFourLevelWorkflow(tmpDir, 1);
    const rootWorkflow = loadRootWorkflow(tmpDir);
    mockRunAgentSequence([makeResponse({ persona: 'preparer', content: 'done' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'iteration abort', createOptions(tmpDir, {
      onIterationLimit: vi.fn().mockResolvedValue(null),
    }));

    const result = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(result.status).toBe('aborted');
    expect(result.iteration).toBe(1);
    expectFullLeafStack(resumePoint, rootWorkflow);
  });

  it('lets a parent recovery step replace the child abort leaf checkpoint', async () => {
    writeFourLevelWorkflow(tmpDir, 10, true);
    const rootWorkflow = loadRootWorkflow(tmpDir);
    mockRunAgentSequence([makeResponse({ persona: 'preparer', content: 'done' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('leaf exploded'));
    mockRunAgentSequence([makeResponse({ persona: 'recovery-planner', content: 'done' })]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
    ]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'recover child abort', createOptions(tmpDir));

    const result = await engine.run();

    expect(result.status).toBe('completed');
    expect(engine.getResumePoint()?.stack).toEqual([
      expect.objectContaining({
        workflow: 'root-resume',
        step: 'recover',
        kind: 'agent',
      }),
    ]);
  });

  it('returns to a parent workflow_call without reusing its child resume frame', async () => {
    writeParentReviewRepairWorkflow(tmpDir);
    const rootWorkflow = loadRevisitWorkflow(tmpDir);

    mockRunAgentSequence([makeResponse({ persona: 'child-review', content: 'needs fix' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('child fix exploded'));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'parent revisit', createOptions(tmpDir));

    const firstResult = await engine.run();
    const resumePoint = engine.getResumePoint();

    expect(firstResult.status).toBe('aborted');
    expect(resumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'root-revisit', step: 'parent-call', kind: 'workflow_call', occurrence: 1 }),
      expect.objectContaining({ workflow: 'nested/revisit', step: 'child-fix', kind: 'agent', occurrence: 1 }),
    ]);

    cleanupWorkflowEngine(engine);
    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([
      makeResponse({ persona: 'child-fix', content: 'fixed' }),
      makeResponse({ persona: 'parent-review', content: 'needs fix' }),
      makeResponse({ persona: 'parent-repair', content: 'done' }),
      makeResponse({ persona: 'child-review', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    const startedSteps: string[] = [];
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'parent revisit retry', createOptions(tmpDir, {
      startStep: 'parent-call',
      resumePoint,
    }));
    engine.on('workflow_call:start', () => {
      startedSteps.push('parent-call');
    });
    engine.on('step:start', (step, _iteration, _instruction, _providerInfo, workflowName) => {
      startedSteps.push(`${workflowName}:${step.name}`);
    });

    const resumed = await engine.run();

    expect(resumed.status).toBe('completed');
    expect(startedSteps).toEqual([
      'parent-call',
      'nested/revisit:child-fix',
      'root-revisit:parent-review',
      'root-revisit:parent-repair',
      'parent-call',
      'nested/revisit:child-review',
    ]);
  });

  it('does not reuse a consumed child frame after the child aborts before completion', async () => {
    writeParentReviewRepairWorkflow(tmpDir);
    const sourceWorkflow = loadRevisitWorkflow(tmpDir);

    mockRunAgentSequence([makeResponse({ persona: 'child-review', content: 'needs fix' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('child fix exploded'));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(sourceWorkflow, tmpDir, 'child abort source', createOptions(tmpDir));

    const sourceResult = await engine.run();
    const sourceResumePoint = engine.getResumePoint();

    expect(sourceResult.status).toBe('aborted');
    expect(sourceResumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'root-revisit', step: 'parent-call', kind: 'workflow_call' }),
      expect.objectContaining({ workflow: 'nested/revisit', step: 'child-fix', kind: 'agent' }),
    ]);

    cleanupWorkflowEngine(engine);
    writeParentReviewRepairWorkflow(tmpDir, true);
    const recoveryWorkflow = loadRevisitWorkflow(tmpDir);
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('child fix exploded again'));
    mockRunAgentSequence([
      makeResponse({ persona: 'parent-repair', content: 'done' }),
      makeResponse({ persona: 'child-review', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    const startedSteps: string[] = [];
    engine = new WorkflowEngine(recoveryWorkflow, tmpDir, 'child abort recovery', createOptions(tmpDir, {
      startStep: 'parent-call',
      resumePoint: sourceResumePoint,
    }));
    engine.on('workflow_call:start', () => {
      startedSteps.push('parent-call');
    });
    engine.on('step:start', (step, _iteration, _instruction, _providerInfo, workflowName) => {
      startedSteps.push(`${workflowName}:${step.name}`);
    });

    const recovered = await engine.run();

    expect(recovered.status).toBe('completed');
    expect(vi.mocked(runAgent).mock.calls.map(([persona]) => String(persona))).toEqual([
      'child-fix',
      'parent-repair',
      'child-review',
    ]);
    expect(startedSteps).toEqual([
      'parent-call',
      'nested/revisit:child-fix',
      'root-revisit:parent-repair',
      'parent-call',
      'nested/revisit:child-review',
    ]);
  });

  it('saves a new nested checkpoint after a resumed run aborts again', async () => {
    writeParentReviewRepairWorkflow(tmpDir);
    const rootWorkflow = loadRevisitWorkflow(tmpDir);

    mockRunAgentSequence([makeResponse({ persona: 'child-review', content: 'needs fix' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('child fix exploded'));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'nested checkpoint source', createOptions(tmpDir));
    await engine.run();
    const sourceResumePoint = engine.getResumePoint();

    cleanupWorkflowEngine(engine);
    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([makeResponse({ persona: 'child-fix', content: 'fixed' })]);
    vi.mocked(runAgent).mockRejectedValueOnce(new Error('parent review exploded'));
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'nested checkpoint second abort', createOptions(tmpDir, {
      startStep: 'parent-call',
      resumePoint: sourceResumePoint,
    }));

    const secondResult = await engine.run();
    const secondResumePoint = engine.getResumePoint();

    expect(secondResult.status).toBe('aborted');
    expect(secondResumePoint?.stack).toEqual([
      expect.objectContaining({ workflow: 'root-revisit', step: 'parent-review', kind: 'agent', occurrence: 1 }),
    ]);

    cleanupWorkflowEngine(engine);
    vi.mocked(runAgent).mockReset();
    mockRunAgentSequence([
      makeResponse({ persona: 'parent-review', content: 'needs fix' }),
      makeResponse({ persona: 'parent-repair', content: 'done' }),
      makeResponse({ persona: 'child-review', content: 'done' }),
    ]);
    mockRuleEvaluationSequence([
      { index: 0, method: 'phase3_tag' },
      { index: 0, method: 'phase3_tag' },
      { index: 1, method: 'phase3_tag' },
    ]);
    const startedSteps: string[] = [];
    engine = new WorkflowEngine(rootWorkflow, tmpDir, 'nested checkpoint retry', createOptions(tmpDir, {
      startStep: 'parent-review',
      resumePoint: secondResumePoint,
    }));
    engine.on('workflow_call:start', () => {
      startedSteps.push('parent-call');
    });
    engine.on('step:start', (step, _iteration, _instruction, _providerInfo, workflowName) => {
      startedSteps.push(`${workflowName}:${step.name}`);
    });

    const resumed = await engine.run();

    expect(resumed.status).toBe('completed');
    expect(startedSteps).toEqual([
      'root-revisit:parent-review',
      'root-revisit:parent-repair',
      'parent-call',
      'nested/revisit:child-review',
    ]);
  });
});
