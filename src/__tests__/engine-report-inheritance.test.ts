import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/evaluation/index.js')>();
  const { MockRuleEvaluator } = await import('./rule-evaluator-test-double.js');
  return { ...actual, RuleEvaluator: MockRuleEvaluator };
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
import type { WorkflowCallInvocationRecord, WorkflowConfig } from '../core/models/index.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import {
  applyDefaultMocks,
  cleanupWorkflowEngine,
  makeResponse,
  makeRule,
  makeStep,
  mockRuleEvaluationSequence,
  mockRunAgentSequence,
} from './engine-test-helpers.js';
import { makeNormalizedWorkflowCallStep } from './helpers/normalized-workflow-call-step.js';

const sourceRunSlug = '20260717-source-run';
const diagnosticName = 'review-report-inheritance.json';

function createTestDirectories(): { root: string; projectCwd: string; cwd: string; reportDir: string } {
  const root = join(tmpdir(), `takt-engine-report-inheritance-${randomUUID()}`);
  const projectCwd = join(root, 'project');
  const cwd = join(root, 'worktree');
  const reportDir = join(cwd, '.takt', 'runs', 'test-report-dir', 'reports');
  mkdirSync(reportDir, { recursive: true });
  return { root, projectCwd, cwd, reportDir };
}

function makeReviewFixWorkflow(initialStep: 'review' | 'fix' = 'review'): WorkflowConfig {
  return {
    name: 'parent',
    maxSteps: 2,
    initialStep,
    steps: [
      makeStep('review', {
        outputContracts: [{ name: 'review.md', format: '# Review' }],
        rules: [makeRule('approved', 'fix')],
      }),
      makeStep('fix', {
        instruction: 'Inherited report: {report:review.md}',
        passPreviousResponse: false,
        rules: [makeRule('fix complete', 'COMPLETE')],
      }),
    ],
  };
}

function makeWorkflowCallStep(
  name: string,
  call: string,
  next: string,
): ReturnType<typeof makeNormalizedWorkflowCallStep> {
  return makeNormalizedWorkflowCallStep({
    name,
    call,
    rules: [makeRule('COMPLETE', next)],
  });
}

function makeWorkflowCallChain(workflowCount: number): {
  workflow: WorkflowConfig;
  workflowsByName: ReadonlyMap<string, WorkflowConfig>;
  reportName: string;
  workflowCallInvocations: Record<string, WorkflowCallInvocationRecord>;
} {
  const workflows: WorkflowConfig[] = [];

  for (let index = workflowCount - 1; index >= 0; index -= 1) {
    const workflowName = `workflow-${index + 1}`;
    if (index === workflowCount - 1) {
      workflows[index] = {
        name: workflowName,
        subworkflow: { callable: true },
        maxSteps: 1,
        initialStep: 'review',
        steps: [makeStep('review', {
          outputContracts: [{ name: 'review.md', format: '# Review' }],
          rules: [makeRule('approved', 'COMPLETE')],
        })],
      };
      continue;
    }

    const childWorkflowName = `workflow-${index + 2}`;
    const callStepName = `delegate-${index + 1}`;
    workflows[index] = {
      name: workflowName,
      ...(index === 0 ? {} : { subworkflow: { callable: true } }),
      maxSteps: 2,
      initialStep: callStepName,
      steps: [
        makeWorkflowCallStep(
          callStepName,
          childWorkflowName,
          index === 0 ? 'fix' : 'COMPLETE',
        ),
        ...(index === 0
          ? [makeStep('fix', {
              instruction: '',
              passPreviousResponse: false,
              rules: [makeRule('fix complete', 'COMPLETE')],
            })]
          : []),
      ],
    };
  }

  const namespace = Array.from(
    { length: workflowCount - 1 },
    (_, index) => [
      'subworkflows',
      `iteration-${index + 1}--step-delegate-${index + 1}--workflow-workflow-${index + 2}`,
    ],
  ).flat();
  const reportName = [...namespace, 'review.md'].join('/');
  const workflow = workflows[0]!;
  const fix = workflow.steps.find((step) => step.name === 'fix')!;
  fix.instruction = `Inherited report: {report:${reportName}}`;
  const workflowCallInvocations: Record<string, WorkflowCallInvocationRecord> = {};
  const workflowCallPath = [];
  for (let index = 0; index < workflowCount - 1; index += 1) {
    const parent = workflows[index]!;
    const step = parent.steps[0]!;
    workflowCallInvocations[
      buildWorkflowCallInvocationIdentity(parent.name, step.name, workflowCallPath)
    ] = {
      call_instance: 1,
      report_namespace_segment:
        `iteration-${index + 1}--step-${step.name}--workflow-workflow-${index + 2}`,
    };
    workflowCallPath.push(
      buildWorkflowResumePointEntry(parent, step.name, 'workflow_call', 1, undefined, 1),
    );
  }

  return {
    workflow,
    workflowsByName: new Map(workflows.map((entry) => [entry.name, entry])),
    reportName,
    workflowCallInvocations,
  };
}

describe('WorkflowEngine report inheritance', () => {
  let root: string;
  let projectCwd: string;
  let cwd: string;
  let reportDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    ({ root, projectCwd, cwd, reportDir } = createTestDirectories());
  });

  afterEach(() => {
    cleanupWorkflowEngine(engine);
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves exact empty invocation evidence across current resume generation and restore', () => {
    const workflow = makeReviewFixWorkflow();
    engine = new WorkflowEngine(workflow, cwd, 'test task', { projectCwd });
    const currentResumePoint = engine.buildResumePointForStepName('review');

    expect(currentResumePoint?.workflow_call_invocations).toEqual({});
    if (currentResumePoint === undefined) {
      throw new Error('Expected a current resume point');
    }

    const restoredEngine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      resumePoint: currentResumePoint,
      startStep: 'review',
    });
    const restoredResumePoint = restoredEngine.buildResumePointForStepName('review');
    cleanupWorkflowEngine(restoredEngine);

    expect(restoredResumePoint?.workflow_call_invocations).toEqual({});
  });

  async function expectMissingReportBeforeAgent(reportName: string): Promise<void> {
    const abort = vi.fn();
    engine!.on('workflow:abort', abort);

    const state = await engine!.run();
    const expectedError = `Report reference "${reportName}" is unavailable for step "fix"`;

    expect(state.status).toBe('aborted');
    expect(abort).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'aborted' }),
      expect.stringContaining(expectedError),
      'runtime_error',
      {
        kind: 'runtime_error',
        step: 'fix',
        reason: expect.stringContaining(expectedError),
        error: expect.stringContaining(expectedError),
      },
    );
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  }

  it('does not inherit a stale report for an unexecuted step from exact empty evidence', async () => {
    const workflow = makeReviewFixWorkflow('fix');
    const sourceReportPath = join(
      cwd,
      '.takt',
      'runs',
      sourceRunSlug,
      'reports',
      'review.md',
    );
    mkdirSync(join(sourceReportPath, '..'), { recursive: true });
    writeFileSync(sourceReportPath, 'stale review', 'utf-8');

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    await expectMissingReportBeforeAgent('review.md');
    expect(existsSync(join(reportDir, 'review.md'))).toBe(false);
  });

  it('inherits a nested workflow-call report before a direct fix resume expands its body', async () => {
    const reviewerWorkflow: WorkflowConfig = {
      name: 'nested-review',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        outputContracts: [{ name: 'review.md', format: '# Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const gateWorkflow: WorkflowConfig = {
      name: 'review-gate',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'delegate',
      steps: [makeWorkflowCallStep('delegate', 'nested-review', 'COMPLETE')],
    };
    const reportName = [
      'subworkflows',
      'iteration-1--step-final-gate--workflow-review-gate',
      'subworkflows',
      'iteration-1--step-delegate--workflow-nested-review',
      'review.md',
    ].join('/');
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 2,
      initialStep: 'final-gate',
      steps: [
        makeWorkflowCallStep('final-gate', 'review-gate', 'fix'),
        makeStep('fix', {
          instruction: `Inherited report: {report:${reportName}}`,
          passPreviousResponse: false,
          rules: [makeRule('fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportPath = join(cwd, '.takt', 'runs', sourceRunSlug, 'reports', ...reportName.split('/'));
    mkdirSync(join(sourceReportPath, '..'), { recursive: true });
    writeFileSync(sourceReportPath, 'nested inherited review', 'utf-8');
    const finalGateEntry = buildWorkflowResumePointEntry(
      workflow,
      'final-gate',
      'workflow_call',
      1,
      undefined,
      1,
    );
    const delegateEntry = buildWorkflowResumePointEntry(
      gateWorkflow,
      'delegate',
      'workflow_call',
      1,
      undefined,
      1,
    );
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(
      reviewerWorkflow,
      'review',
      [finalGateEntry, delegateEntry],
      ['review.md'],
    );

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: { 'final-gate': 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(workflow.name, 'final-gate', [])]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-1--step-final-gate--workflow-review-gate',
          },
          [buildWorkflowCallInvocationIdentity(gateWorkflow.name, 'delegate', [finalGateEntry])]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-1--step-delegate--workflow-nested-review',
          },
        },
        workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
      },
      workflowCallResolver: ({ step }) => {
        if (step.call === 'review-gate') return gateWorkflow;
        if (step.call === 'nested-review') return reviewerWorkflow;
        return null;
      },
    });
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'fix complete' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await engine.run();
    const inheritedReportPath = join(reportDir, ...reportName.split('/'));
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';

    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe('nested inherited review');
    expect(instruction).toContain('Inherited report: nested inherited review');
    expect(instruction).not.toContain(inheritedReportPath);
    expect(instruction).not.toContain(sourceReportPath);
  });

  it('inherits only the participating child dynamic reports for the resumed workflow-call instance', async () => {
    const fixed = makeStep('architecture', {
      outputContracts: [{ name: 'architecture.md', format: '# Architecture' }],
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const frontend = makeStep('frontend', {
      description: 'Review frontend changes',
      outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const backend = makeStep('backend', {
      description: 'Review backend changes',
      outputContracts: [{ name: 'backend.md', format: '# Backend' }],
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const reviewers = makeStep('reviewers', {
      parallel: {
        kind: 'dynamic',
        fixed: [fixed],
        pool: [frontend, backend],
        selection: { mode: 'replace' as const },
      },
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const child: WorkflowConfig = {
      name: 'child-review',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'reviewers',
      steps: [reviewers],
    };
    const reportPrefix = [
      'subworkflows',
      'iteration-2--step-delegate--workflow-child-review',
    ];
    const architectureReport = [...reportPrefix, 'architecture.md'].join('/');
    const frontendReport = [...reportPrefix, 'frontend.md'].join('/');
    const backendReport = [...reportPrefix, 'backend.md'].join('/');
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeWorkflowCallStep('delegate', 'child-review', 'fix'),
        makeStep('fix', {
          instruction: `Architecture: {report:${architectureReport}}\nFrontend: {report:${frontendReport}}`,
          passPreviousResponse: false,
          rules: [makeRule('fix complete', 'COMPLETE')],
        }),
      ],
    };
    const delegateEntry = buildWorkflowResumePointEntry(
      workflow,
      'delegate',
      'workflow_call',
      1,
      undefined,
      2,
    );
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(child, 'reviewers', [delegateEntry], []);
    stepParticipationIndex.record(child, 'architecture', [delegateEntry], ['architecture.md'], 'reviewers');
    stepParticipationIndex.record(child, 'frontend', [delegateEntry], ['frontend.md'], 'reviewers');
    const sourceReportDir = join(cwd, '.takt', 'runs', sourceRunSlug, 'reports');
    for (const [reportName, content] of [
      [architectureReport, 'architecture finding'],
      [frontendReport, 'frontend finding'],
      [backendReport, 'backend finding'],
    ]) {
      const sourcePath = join(sourceReportDir, ...reportName.split('/'));
      mkdirSync(join(sourcePath, '..'), { recursive: true });
      writeFileSync(sourcePath, content, 'utf-8');
    }

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: { delegate: 2 },
        }],
        iteration: 2,
        elapsed_ms: 0,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(workflow.name, 'delegate', [])]: {
            call_instance: 2,
            report_namespace_segment: 'iteration-2--step-delegate--workflow-child-review',
          },
        },
        workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
      },
      workflowCallResolver: ({ step }) => step.call === 'child-review' ? child : null,
    });
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'fix complete' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await engine.run();
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';

    expect(state.status).toBe('completed');
    expect(readFileSync(join(reportDir, ...architectureReport.split('/')), 'utf-8')).toBe('architecture finding');
    expect(readFileSync(join(reportDir, ...frontendReport.split('/')), 'utf-8')).toBe('frontend finding');
    expect(existsSync(join(reportDir, ...backendReport.split('/')))).toBe(false);
    expect(instruction).toContain('Architecture: architecture finding');
    expect(instruction).toContain('Frontend: frontend finding');
  });

  it('rejects missing workflow-call invocation state before a resumed fix agent starts', async () => {
    const child: WorkflowConfig = {
      name: 'child-review',
      subworkflow: { callable: true },
      maxSteps: 1,
      initialStep: 'review',
      steps: [makeStep('review', {
        outputContracts: [{ name: 'review.md', format: '# Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 2,
      initialStep: 'delegate',
      steps: [
        makeWorkflowCallStep('delegate', 'child-review', 'fix'),
        makeStep('fix', {
          rules: [makeRule('fix complete', 'COMPLETE')],
        }),
      ],
    };
    expect(() => new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: { delegate: 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
      workflowCallResolver: ({ step }) => step.call === 'child-review' ? child : null,
    })).toThrow(
      'Invalid review report discovery state: workflow_call_invocation_missing:delegate',
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('preserves available reports and writes partial discovery diagnostics', async () => {
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 4,
      initialStep: 'available-review',
      steps: [
        makeStep('available-review', {
          outputContracts: [{ name: 'available-review.md', format: '# Available Review' }],
          rules: [makeRule('review complete', 'missing-review')],
        }),
        makeWorkflowCallStep('missing-review', 'missing-review-workflow', 'cyclic-review'),
        makeWorkflowCallStep('cyclic-review', 'parent', 'fix'),
        makeStep('fix', {
          instruction: 'Report: {report:available-review.md}',
          passPreviousResponse: false,
          rules: [makeRule('fix complete', 'COMPLETE')],
        }),
      ],
    };
    const sourceReportDir = join(cwd, '.takt', 'runs', sourceRunSlug, 'reports');
    mkdirSync(sourceReportDir, { recursive: true });
    writeFileSync(join(sourceReportDir, 'available-review.md'), 'available review', 'utf-8');
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(
      workflow,
      'available-review',
      [],
      ['available-review.md'],
    );

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: {
            'available-review': 1,
            'missing-review': 1,
            'cyclic-review': 1,
          },
        }],
        iteration: 3,
        elapsed_ms: 0,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(workflow.name, 'missing-review', [])]: {
            call_instance: 1,
            report_namespace_segment:
              'iteration-2--step-missing-review--workflow-missing-review-workflow',
          },
          [buildWorkflowCallInvocationIdentity(workflow.name, 'cyclic-review', [])]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-3--step-cyclic-review--workflow-parent',
          },
        },
        workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
      },
      workflowCallResolver: ({ step }) => step.call === 'parent' ? workflow : null,
    });
    mockRunAgentSequence([makeResponse({ persona: 'fix', content: 'fix complete' })]);
    mockRuleEvaluationSequence([{ index: 0, method: 'phase3_tag' }]);

    const state = await engine.run();
    const inheritedReportPath = join(reportDir, 'available-review.md');
    const sourceReportPath = join(sourceReportDir, 'available-review.md');
    const diagnostic = JSON.parse(readFileSync(join(reportDir, diagnosticName), 'utf-8'));
    const instruction = vi.mocked(runAgent).mock.calls[0]?.[1] ?? '';

    expect(state.status).toBe('completed');
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe('available review');
    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'partial',
      fallbackUsed: true,
      copied: [
        {
          reportName: 'available-review.md',
          sourcePath: sourceReportPath,
          targetPath: inheritedReportPath,
        },
      ],
      skipped: expect.arrayContaining([
        { reportName: '*', reason: 'workflow_call_report_unknown:missing-review-workflow' },
        { reportName: '*', reason: 'workflow_call_report_cycle:parent' },
      ]),
    }));
    expect(instruction).toContain('Report: available review');
    expect(instruction).not.toContain(sourceReportPath);
    expect(instruction).not.toContain(inheritedReportPath);
  });

  it('writes unavailable diagnostics when workflow call discovery exceeds the depth limit', async () => {
    const chain = makeWorkflowCallChain(MAX_WORKFLOW_CALL_DEPTH + 1);
    mkdirSync(join(cwd, '.takt', 'runs', sourceRunSlug, 'reports'), { recursive: true });

    engine = new WorkflowEngine(chain.workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: chain.workflow.name,
          workflow_ref: chain.workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: chain.workflowCallInvocations,
        workflow_step_participations: {},
      },
      workflowCallResolver: ({ step }) => chain.workflowsByName.get(step.call) ?? null,
    });

    await expectMissingReportBeforeAgent(chain.reportName);
    const diagnostic = JSON.parse(readFileSync(join(reportDir, diagnosticName), 'utf-8'));

    expect(diagnostic).toEqual(expect.objectContaining({
      sourceRunSlug,
      status: 'unavailable',
      fallbackUsed: true,
      copied: [],
      skipped: [
        {
          reportName: '*',
          reason: `workflow_call_report_depth_exceeded:${MAX_WORKFLOW_CALL_DEPTH}`,
        },
      ],
    }));
  });

  it('writes unavailable diagnostics when the workflow resolver throws', async () => {
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 2,
      initialStep: 'review',
      steps: [
        makeWorkflowCallStep('review', 'child-review', 'fix'),
        makeStep('fix', {
          instruction: 'Inherited report: {report:review.md}',
          passPreviousResponse: false,
          rules: [makeRule('fix complete', 'COMPLETE')],
        }),
      ],
    };
    mkdirSync(join(cwd, '.takt', 'runs', sourceRunSlug, 'reports'), { recursive: true });

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: { review: 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {
          [buildWorkflowCallInvocationIdentity(workflow.name, 'review', [])]: {
            call_instance: 1,
            report_namespace_segment: 'iteration-1--step-review--workflow-child-review',
          },
        },
        workflow_step_participations: {},
      },
      workflowCallResolver: () => {
        throw new Error('resolver exploded');
      },
    });

    await expectMissingReportBeforeAgent('review.md');
    const diagnostic = JSON.parse(readFileSync(join(reportDir, diagnosticName), 'utf-8'));

    expect(diagnostic).toEqual(expect.objectContaining({
      sourceRunSlug,
      status: 'unavailable',
      fallbackUsed: true,
      copied: [],
      skipped: [
        {
          reportName: '*',
          reason: 'workflow_call_report_resolution_failed:resolver exploded',
        },
      ],
    }));
  });

  it('does not inherit an old run report or write diagnostics during a normal run', async () => {
    const workflow = makeReviewFixWorkflow();
    const sourceReportDir = join(cwd, '.takt', 'runs', sourceRunSlug, 'reports');
    mkdirSync(sourceReportDir, { recursive: true });
    writeFileSync(join(sourceReportDir, 'review.md'), 'old review', 'utf-8');

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
    });

    await expectMissingReportBeforeAgent('review.md');
    expect(existsSync(join(reportDir, 'review.md'))).toBe(false);
    expect(existsSync(join(reportDir, diagnosticName))).toBe(false);
  });

  it('does not inherit reports or write diagnostics when the resume point targets a non-fix step', async () => {
    const workflow = makeReviewFixWorkflow('fix');
    const sourceReportDir = join(cwd, '.takt', 'runs', sourceRunSlug, 'reports');
    mkdirSync(sourceReportDir, { recursive: true });
    writeFileSync(join(sourceReportDir, 'review.md'), 'old review', 'utf-8');

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'review',
          kind: 'agent',
          occurrence: 1,
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    await expectMissingReportBeforeAgent('review.md');
    expect(existsSync(join(reportDir, 'review.md'))).toBe(false);
    expect(existsSync(join(reportDir, diagnosticName))).toBe(false);
  });

  it('writes unavailable diagnostics when resume source lacks sourceRunSlug', async () => {
    const workflow = makeReviewFixWorkflow();
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(workflow, 'review', [], ['review.md']);

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          workflow_ref: workflow.name,
          step: 'fix',
          kind: 'agent',
          occurrence: 1,
          step_iterations: { review: 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
      },
    });

    await expectMissingReportBeforeAgent('review.md');
    const diagnostic = JSON.parse(readFileSync(join(reportDir, diagnosticName), 'utf-8'));

    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'unavailable',
      fallbackUsed: true,
      copied: [],
      skipped: [{ reportName: 'review.md', reason: 'source_unavailable' }],
    }));
    expect(diagnostic).not.toHaveProperty('sourceRunSlug');
  });
});
