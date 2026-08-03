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
import { buildDynamicParallelSelectionIdentity } from '../core/workflow/dynamic-parallel/identity.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
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
import {
  buildWorkflowCallInvocationRecordsFixture,
  buildWorkflowCallNamespaceFixture,
  type WorkflowCallInvocationFixture,
} from './helpers/workflow-resume-fixture.js';

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
      ...(index === 0
        ? { maxSteps: 2 }
        : { subworkflow: { callable: true } }),
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

  const workflow = workflows[0]!;
  const workflowCallInvocationFixtures: WorkflowCallInvocationFixture[] = [];
  const workflowCallPath = [];
  const namespace: string[] = [];
  for (let index = 0; index < workflowCount - 1; index += 1) {
    const parent = workflows[index]!;
    const step = parent.steps[0]!;
    const segment = buildWorkflowCallNamespaceFixture(
      parent.name,
      step.name,
      workflowCallPath,
      workflows[index + 1]!.name,
      1,
    );
    workflowCallInvocationFixtures.push({
      workflowReference: parent.name,
      step: step.name,
      ownerPath: [...workflowCallPath],
      callInstance: 1,
      childWorkflowReference: workflows[index + 1]!.name,
    });
    namespace.push('subworkflows', segment);
    workflowCallPath.push(
      buildWorkflowResumePointEntry(parent, step.name, 'workflow_call', undefined, 1),
    );
  }
  const reportName = [...namespace, 'review.md'].join('/');
  const fix = workflow.steps.find((step) => step.name === 'fix')!;
  fix.instruction = `Inherited report: {report:${reportName}}`;

  return {
    workflow,
    workflowsByName: new Map(workflows.map((entry) => [entry.name, entry])),
    reportName,
    workflowCallInvocations: buildWorkflowCallInvocationRecordsFixture(
      workflowCallInvocationFixtures,
    ),
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
    await expect(engine!.run()).rejects.toThrow(
      `Report reference "${reportName}" is unavailable for step "fix"`,
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
      provider: 'mock',
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{ workflow: workflow.name, step: 'fix', kind: 'agent' }],
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
      initialStep: 'review',
      steps: [makeStep('review', {
        outputContracts: [{ name: 'review.md', format: '# Review' }],
        rules: [makeRule('approved', 'COMPLETE')],
      })],
    };
    const gateWorkflow: WorkflowConfig = {
      name: 'review-gate',
      subworkflow: { callable: true },
      initialStep: 'delegate',
      steps: [makeWorkflowCallStep('delegate', 'nested-review', 'COMPLETE')],
    };
    const finalGateSegment = buildWorkflowCallNamespaceFixture(
      'parent', 'final-gate', [], gateWorkflow.name, 1,
    );
    const delegateSegment = buildWorkflowCallNamespaceFixture(
      gateWorkflow.name,
      'delegate',
      [{
        workflow: 'parent',
        step: 'final-gate',
        kind: 'workflow_call',
        call_instance: 1,
      }],
      reviewerWorkflow.name,
      1,
    );
    const reportName = [
      'subworkflows',
      finalGateSegment,
      'subworkflows',
      delegateSegment,
      'review.md',
    ].join('/');
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 3,
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
    const finalGateEntry = buildWorkflowResumePointEntry(
      workflow,
      'final-gate',
      'workflow_call',
      undefined,
      1,
    );
    const delegateEntry = buildWorkflowResumePointEntry(
      gateWorkflow,
      'delegate',
      'workflow_call',
      undefined,
      1,
    );
    const sourceReportPath = join(
      cwd,
      '.takt',
      'runs',
      sourceRunSlug,
      'reports',
      'subworkflows',
      finalGateSegment,
      'subworkflows',
      delegateSegment,
      'review.md',
    );
    mkdirSync(join(sourceReportPath, '..'), { recursive: true });
    writeFileSync(sourceReportPath, 'nested inherited review', 'utf-8');
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(
      reviewerWorkflow,
      'review',
      [finalGateEntry, delegateEntry],
      ['review.md'],
    );
    const workflowCallInvocations = buildWorkflowCallInvocationRecordsFixture([
      {
        workflowReference: workflow.name,
        step: 'final-gate',
        ownerPath: [],
        callInstance: 1,
        childWorkflowReference: gateWorkflow.name,
      },
      {
        workflowReference: gateWorkflow.name,
        step: 'delegate',
        ownerPath: [finalGateEntry],
        callInstance: 1,
        childWorkflowReference: reviewerWorkflow.name,
      },
    ]);
    const resumePoint = {
      version: 2 as const,
      stack: [{
        workflow: workflow.name,
        step: 'fix',
        kind: 'agent' as const,
        step_iterations: { 'final-gate': 1 },
      }],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: workflowCallInvocations,
      workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
    };
    writeFileSync(
      join(cwd, '.takt', 'runs', sourceRunSlug, 'meta.json'),
      JSON.stringify({ resume_point: resumePoint }),
      'utf-8',
    );

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      provider: 'mock',
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint,
      workflowCallResolver: ({ step }) => {
        if (step.call === 'review-gate') return gateWorkflow;
        if (step.call === 'nested-review') return reviewerWorkflow;
        return null;
      },
    });
    const inheritanceDiagnostic = JSON.parse(
      readFileSync(join(reportDir, diagnosticName), 'utf-8'),
    ) as {
      status: string;
      copied: Array<{ reportName: string }>;
      skipped: Array<{ reportName: string; reason: string }>;
    };
    expect(inheritanceDiagnostic).toMatchObject({
      status: 'copied',
      copied: [{ reportName }],
      skipped: [],
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

  it('inherits only the selected child dynamic reports for the resumed workflow-call instance', async () => {
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
      initialStep: 'reviewers',
      steps: [reviewers],
    };
    const delegateSegment = buildWorkflowCallNamespaceFixture(
      'parent', 'delegate', [], child.name, 2,
    );
    const reportPrefix = [
      'subworkflows',
      delegateSegment,
    ];
    const architectureReport = [...reportPrefix, 'architecture.md'].join('/');
    const frontendReport = [...reportPrefix, 'frontend.md'].join('/');
    const backendReport = [...reportPrefix, 'backend.md'].join('/');
    const workflow: WorkflowConfig = {
      name: 'parent',
      maxSteps: 3,
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
      undefined,
      2,
    );
    const reviewersEntry = buildWorkflowResumePointEntry(
      child,
      'reviewers',
      'agent',
    );
    const identity = buildDynamicParallelSelectionIdentity(child, 'reviewers', [delegateEntry]);
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(child, 'reviewers', [delegateEntry], []);
    stepParticipationIndex.record(
      child,
      'architecture',
      [delegateEntry, reviewersEntry],
      ['architecture.md'],
    );
    stepParticipationIndex.record(
      child,
      'frontend',
      [delegateEntry, reviewersEntry],
      ['frontend.md'],
    );
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
      provider: 'mock',
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          step: 'fix',
          kind: 'agent',
          step_iterations: { delegate: 2 },
        }],
        iteration: 2,
        elapsed_ms: 0,
        dynamic_parallel_selections: {
          [identity]: {
            identity,
            step_name: 'reviewers',
            round: 1,
            selected_pool_ids: ['frontend'],
            effective_selection_ids: ['architecture', 'frontend'],
          },
        },
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: workflow.name,
          step: 'delegate',
          ownerPath: [],
          callInstance: 2,
          childWorkflowReference: child.name,
        }]),
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
    const persisted = vi.fn();
    expect(() => new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          step: 'fix',
          kind: 'agent',
          step_iterations: { delegate: 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
      workflowCallResolver: ({ step }) => step.call === 'child-review' ? child : null,
      onDynamicParallelSelectionPersisted: persisted,
    })).toThrow(
      'Invalid review report discovery state: workflow_call_invocation_missing:delegate',
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
  });

  it('rejects a missing nested dynamic selection snapshot before a resumed fix agent starts', () => {
    const reviewers = makeStep('reviewers', {
      parallel: {
        kind: 'dynamic',
        fixed: [],
        pool: [makeStep('frontend', {
          description: 'Review frontend changes',
          outputContracts: [{ name: 'frontend.md', format: '# Frontend' }],
          rules: [makeRule('approved', 'COMPLETE')],
        })],
        selection: { mode: 'replace' as const },
      },
      rules: [makeRule('approved', 'COMPLETE')],
    });
    const child: WorkflowConfig = {
      name: 'child-review',
      subworkflow: { callable: true },
      initialStep: 'reviewers',
      steps: [reviewers],
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
    const persisted = vi.fn();
    const delegateEntry = buildWorkflowResumePointEntry(
      workflow,
      'delegate',
      'workflow_call',
      undefined,
      2,
    );
    const stepParticipationIndex = new WorkflowStepParticipationIndex(new Map());
    stepParticipationIndex.record(child, 'reviewers', [delegateEntry], []);

    expect(() => new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          step: 'fix',
          kind: 'agent',
          step_iterations: { delegate: 2 },
        }],
        iteration: 2,
        elapsed_ms: 0,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: workflow.name,
          step: 'delegate',
          ownerPath: [],
          callInstance: 2,
          childWorkflowReference: child.name,
        }]),
        workflow_step_participations: Object.fromEntries(stepParticipationIndex.snapshot()),
      },
      workflowCallResolver: ({ step }) => step.call === 'child-review' ? child : null,
      onDynamicParallelSelectionPersisted: persisted,
    })).toThrow(
      'Invalid review report discovery state: dynamic_parallel_report_identity_unresolved:'
      + 'Dynamic parallel report selection snapshot is missing',
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
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
      provider: 'mock',
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
      resumePoint: {
        version: 2,
        stack: [{
          workflow: workflow.name,
          step: 'fix',
          kind: 'agent',
          step_iterations: {
            'available-review': 1,
            'missing-review': 1,
            'cyclic-review': 1,
          },
        }],
        iteration: 3,
        elapsed_ms: 0,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([
          {
            workflowReference: workflow.name,
            step: 'missing-review',
            ownerPath: [],
            callInstance: 1,
            childWorkflowReference: 'missing-review-workflow',
          },
          {
            workflowReference: workflow.name,
            step: 'cyclic-review',
            ownerPath: [],
            callInstance: 1,
            childWorkflowReference: workflow.name,
          },
        ]),
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
          step: 'fix',
          kind: 'agent',
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
          step: 'fix',
          kind: 'agent',
          step_iterations: { review: 1 },
        }],
        iteration: 1,
        elapsed_ms: 0,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: workflow.name,
          step: 'review',
          ownerPath: [],
          callInstance: 1,
          childWorkflowReference: 'child-review',
        }]),
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
          step: 'review',
          kind: 'agent',
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
          step: 'fix',
          kind: 'agent',
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
