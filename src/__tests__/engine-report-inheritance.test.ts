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
import type { WorkflowConfig } from '../core/models/index.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../core/workflow/workflow-call-depth.js';
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
      `iteration-*--step-delegate-${index + 1}--workflow-workflow-${index + 2}`,
    ],
  ).flat();
  const reportName = [...namespace, 'review.md'].join('/');
  const workflow = workflows[0]!;
  const fix = workflow.steps.find((step) => step.name === 'fix')!;
  fix.instruction = `Inherited report: {report:${reportName}}`;

  return {
    workflow,
    workflowsByName: new Map(workflows.map((entry) => [entry.name, entry])),
    reportName,
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

  async function expectMissingReportBeforeAgent(reportName: string): Promise<void> {
    await expect(engine!.run()).rejects.toThrow(
      `Report reference "${reportName}" is unavailable for step "fix"`,
    );
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  }

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

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'retry' },
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

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { sourceRunSlug, resumeMode: 'requeue' },
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
        version: 1,
        stack: [{
          workflow: workflow.name,
          step: 'review',
          kind: 'agent',
        }],
        iteration: 1,
        elapsed_ms: 0,
      },
    });

    await expectMissingReportBeforeAgent('review.md');
    expect(existsSync(join(reportDir, 'review.md'))).toBe(false);
    expect(existsSync(join(reportDir, diagnosticName))).toBe(false);
  });

  it('writes unavailable diagnostics when resume source lacks sourceRunSlug', async () => {
    const workflow = makeReviewFixWorkflow();

    engine = new WorkflowEngine(workflow, cwd, 'test task', {
      projectCwd,
      startStep: 'fix',
      resumeSource: { resumeMode: 'retry' },
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
