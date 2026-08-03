import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { invalidateGlobalConfigCache, loadWorkflowByIdentifier } from '../infra/config/index.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';
import { parseFindingLedger } from '../core/models/finding-schemas.js';
import { buildWorkflowResumePointEntry, getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { buildWorkflowCallNamespaceFixture } from './helpers/workflow-resume-fixture.js';

const sourceRunSlug = '20260717-source-run';
const resumeModes = ['requeue', 'retry', 'instruct'] as const;

type ResumeMode = typeof resumeModes[number];

function callNamespace(parentWorkflow: string, childWorkflow: string): string {
  return buildWorkflowCallNamespaceFixture(parentWorkflow, 'delegate', [], childWorkflow, 1);
}

function loadCallNamespace(projectDir: string): string {
  const parent = loadWorkflowByIdentifier('parent-fix', projectDir);
  const child = loadWorkflowByIdentifier('child-fix', projectDir);
  if (parent === null || child === null) {
    throw new Error('Expected report inheritance workflows');
  }
  return callNamespace(getWorkflowReference(parent), getWorkflowReference(child));
}

interface TestEnvironment {
  root: string;
  projectDir: string;
  globalDir: string;
}

function createEnvironment(withFindingContract: boolean): TestEnvironment {
  const root = join(tmpdir(), `takt-report-inheritance-resume-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');
  const workflowsDir = join(projectDir, '.takt', 'workflows');

  mkdirSync(join(workflowsDir, 'personas'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\n', 'utf-8');
  writeFileSync(join(workflowsDir, 'personas', 'fixer.md'), 'You are a fixer.\n', 'utf-8');
  writeFileSync(join(workflowsDir, 'parent-fix.yaml'), [
    'name: parent-fix',
    'initial_step: delegate',
    'max_steps: 4',
    'steps:',
    '  - name: delegate',
    '    kind: workflow_call',
    '    call: child-fix',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'), 'utf-8');
  writeFileSync(join(workflowsDir, 'child-fix.yaml'), [
    'name: child-fix',
    'subworkflow:',
    '  callable: true',
    ...(withFindingContract ? [
      'finding_contract:',
      '  ledger_path: .takt/findings/review-ledger.json',
      '  raw_findings_path: .takt/findings/raw',
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
    ] : []),
    'initial_step: fix',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      - name: arch-review',
    '        persona: ./personas/fixer.md',
    '        instruction: arch review',
    '        output_contracts:',
    '          report:',
    '            - name: 05-arch-review.md',
    '              format: "# Architecture Review"',
    '        rules:',
    '          - condition: approved',
    '            next: COMPLETE',
    '    rules:',
    '      - condition: all("approved")',
    '        next: fix',
    '  - name: fix',
    '    persona: ./personas/fixer.md',
    '    instruction: "Inherited report: {report:05-arch-review.md}"',
    '    rules:',
    '      - condition: fix complete',
    '        next: COMPLETE',
  ].join('\n'), 'utf-8');

  return { root, projectDir, globalDir };
}

function buildResumePoint(projectDir: string) {
  const parent = loadWorkflowByIdentifier('parent-fix', projectDir);
  const child = loadWorkflowByIdentifier('child-fix', projectDir);
  if (parent === null || child === null) {
    throw new Error('Expected report inheritance workflows');
  }
  const delegateEntry = buildWorkflowResumePointEntry(
    parent,
    'delegate',
    'workflow_call',
    undefined,
    1,
  );
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  invocationIndex.record(parent, 'delegate', [], {
    call_instance: 1,
    child_workflow_ref: getWorkflowReference(child),
  });
  const participationIndex = new WorkflowStepParticipationIndex(new Map());
  participationIndex.record(child, 'reviewers', [delegateEntry], []);
  participationIndex.record(child, 'arch-review', [
    delegateEntry,
    buildWorkflowResumePointEntry(child, 'reviewers', 'agent'),
  ], ['05-arch-review.md']);

  return {
    version: 2 as const,
    stack: [
      delegateEntry,
      buildWorkflowResumePointEntry(child, 'fix', 'agent', new Map([['reviewers', 1]])),
    ],
    iteration: 1,
    elapsed_ms: 0,
    workflow_call_invocations: invocationIndex.serialized(),
    workflow_step_participations: participationIndex.serialized(),
  };
}

function completeSourceTask(runner: TaskRunner, task: TaskInfo): void {
  runner.completeTask({
    task,
    success: true,
    response: 'source task complete',
    executionLog: ['source task complete'],
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:01:00.000Z',
  });
}

function prepareResumedTask(runner: TaskRunner, projectDir: string, mode: ResumeMode): TaskInfo {
  runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
  const sourceTask = runner.claimNextTasks(1)[0];
  if (!sourceTask) {
    throw new Error('Source task was not claimed');
  }
  const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, {
    runSlug: sourceRunSlug,
  });
  const resumePoint = buildResumePoint(projectDir);

  if (mode === 'requeue') {
    runner.exceedTask(taskWithSourceRun.name, {
      currentStep: 'delegate',
      newMaxSteps: 4,
      currentIteration: 1,
      resumePoint,
    });
    runner.requeueExceededTask(taskWithSourceRun.name);
    const requeuedTask = runner.claimNextTasks(1)[0];
    if (!requeuedTask) {
      throw new Error('Requeued task was not claimed');
    }
    return requeuedTask;
  }

  completeSourceTask(runner, taskWithSourceRun);
  return runner.startReExecution(
    taskWithSourceRun.name,
    ['completed'],
    mode,
    {
      startStep: undefined,
      retryNote: undefined,
      resumePoint: resumePoint,
    },
  );
}

function writeSourceReports(projectDir: string, withFindingContract: boolean): {
  sourceReportDir: string;
  sourceLedger?: string;
} {
  const sourceReportDir = join(
    projectDir,
    '.takt',
    'runs',
    sourceRunSlug,
    'reports',
    'subworkflows',
    loadCallNamespace(projectDir),
  );
  mkdirSync(sourceReportDir, { recursive: true });
  writeFileSync(join(sourceReportDir, '05-arch-review.md'), 'previous architecture review', 'utf-8');

  if (!withFindingContract) {
    return { sourceReportDir };
  }

  const sourceLedger = JSON.stringify(parseFindingLedger({
    workflowName: 'child-fix',
    nextId: 1,
    updatedAt: '2026-07-17T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
  }));
  const ledgerPath = join(projectDir, '.takt', 'findings', 'review-ledger.json');
  mkdirSync(join(projectDir, '.takt', 'findings'), { recursive: true });
  writeFileSync(ledgerPath, sourceLedger, 'utf-8');
  return { sourceReportDir, sourceLedger };
}

function findResumedRunSlug(projectDir: string): string {
  const runNames = readdirSync(join(projectDir, '.takt', 'runs'));
  const resumedRunSlug = runNames.find((name) => name !== sourceRunSlug);
  if (!resumedRunSlug) {
    throw new Error('Resumed run directory was not created');
  }
  return resumedRunSlug;
}

describe.each(resumeModes)('IT: report inheritance through %s task resume', (mode) => {
  let environment: TestEnvironment;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    if (environment && existsSync(environment.root)) {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('runs the nested fix with inherited reports (finding contract: %s)', async (withFindingContract) => {
    environment = createEnvironment(withFindingContract);
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    invalidateGlobalConfigCache();

    const instructions: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      instructions.push(instruction);
      return {
        persona: 'fixer',
        status: 'done',
        content: '[FIX:1]\nfix complete',
        timestamp: new Date(),
        sessionId: 'fix-session',
      };
    });

    const source = writeSourceReports(environment.projectDir, withFindingContract);
    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(runner, environment.projectDir, mode);

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    const inheritedReportPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      loadCallNamespace(environment.projectDir),
      '05-arch-review.md',
    );
    const diagnosticPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      loadCallNamespace(environment.projectDir),
      'review-report-inheritance.json',
    );

    expect(success).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain('Inherited report: previous architecture review');
    expect(instructions[0]).not.toContain('{report:05-arch-review.md}');
    expect(instructions[0]).not.toContain(inheritedReportPath);
    expect(instructions[0]).not.toContain(source.sourceReportDir);
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe('previous architecture review');
    expect(readFileSync(join(source.sourceReportDir, '05-arch-review.md'), 'utf-8')).toBe('previous architecture review');
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf-8'))).toEqual(expect.objectContaining({
      sourceRunSlug,
      sourceReportDirectory: join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports'),
      status: 'partial',
      fallbackUsed: true,
      skipped: [expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: 'target_exists',
      })],
    }));
    if (source.sourceLedger !== undefined) {
      expect(readFileSync(join(environment.projectDir, '.takt', 'findings', 'review-ledger.json'), 'utf-8'))
        .toBe(source.sourceLedger);
    }
  });
});

describe('IT: missing report source fallback through task resume', () => {
  let environment: TestEnvironment;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    if (environment && existsSync(environment.root)) {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  it('should fail before the resumed fix agent runs and record unavailable diagnostics when the source run was deleted', async () => {
    environment = createEnvironment(false);
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    invalidateGlobalConfigCache();

    const instructions: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      instructions.push(instruction);
      return {
        persona: 'fixer',
        status: 'done',
        content: '[FIX:1]\nfix complete',
        timestamp: new Date(),
        sessionId: 'fix-session',
      };
    });

    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(runner, environment.projectDir, 'requeue');

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    const reportRoot = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
    );
    const diagnosticRelativePaths = (readdirSync(reportRoot, { recursive: true }) as string[])
      .filter((entry) => entry.endsWith('review-report-inheritance.json'));
    expect(diagnosticRelativePaths).toHaveLength(1);
    const diagnosticPath = join(reportRoot, diagnosticRelativePaths[0]!);
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf-8')) as {
      sourceRunSlug?: string;
      status?: string;
      fallbackUsed?: boolean;
      skipped?: Array<{ reason?: string }>;
    };

    expect(success).toBe(false);
    expect(instructions).toHaveLength(0);
    expect(diagnostic).toEqual(expect.objectContaining({
      sourceRunSlug,
      status: 'unavailable',
      fallbackUsed: true,
    }));
    expect(diagnostic.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining('source_resolution_failed') }),
    ]));
  });
});
