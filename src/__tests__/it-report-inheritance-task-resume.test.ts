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
import {
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
} from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { createTestFindingLedgerStore } from './helpers/finding-storage.js';
import type { FindingLedgerStore } from '../core/workflow/findings/store.js';

const sourceRunSlug = '20260717-source-run';
const resumeModes = ['requeue', 'retry', 'instruct'] as const;

type ResumeMode = typeof resumeModes[number];

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
      '  manager:',
      '    persona: findings-manager',
      '    instruction: findings-manager',
      '    output_contract: findings-manager',
    ] : []),
    'initial_step: fix',
    'max_steps: 4',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      - name: arch-review',
    '        persona: ./personas/fixer.md',
    '        instruction: arch review',
      '        output_contracts:',
      '          report:',
      '            - name: 05-arch-review.md',
      ...(withFindingContract
        ? ['              format: architecture-review-finding-contract']
        : ['              format: "# Architecture Review"']),
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

function loadResumeWorkflows(projectDir: string) {
  const parent = loadWorkflowByIdentifier('parent-fix', projectDir);
  if (!parent) {
    throw new Error('Resume workflow fixtures could not be loaded');
  }
  const parentStep = parent.steps.find((step) => step.name === 'delegate');
  if (!parentStep || parentStep.kind !== 'workflow_call') {
    throw new Error('Resume parent workflow_call fixture could not be loaded');
  }
  const child = resolveWorkflowCallTarget(
    parent,
    parentStep,
    projectDir,
    projectDir,
  );
  if (!child) {
    throw new Error('Resume child workflow fixture could not be loaded');
  }
  return { parent, child };
}

function buildWorkflowCallSite(projectDir: string, occurrence: number) {
  const { parent, child } = loadResumeWorkflows(projectDir);
  return buildWorkflowCallSiteIdentity({
    stack: [{
      workflow: parent.name,
      workflow_ref: getWorkflowReference(parent),
      step: 'delegate',
      kind: 'workflow_call',
      occurrence,
    }],
    childWorkflow: child,
  });
}

function buildWorkflowCallNamespace(projectDir: string, occurrence: number): string {
  return buildWorkflowCallSite(projectDir, occurrence).runPathSegment;
}

function buildWorkflowCallAuthorityKey(projectDir: string, occurrence: number): string {
  return buildWorkflowCallSite(projectDir, occurrence).key;
}

function buildResumePoint(projectDir: string) {
  const { parent, child } = loadResumeWorkflows(projectDir);
  const delegateEntry = buildWorkflowResumePointEntry(
    parent,
    'delegate',
    'workflow_call',
    1,
    undefined,
    1,
  );
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  invocationIndex.record(parent, 'delegate', [], {
    call_instance: 1,
    report_namespace_segment: buildWorkflowCallNamespace(projectDir, 1),
  });
  const participationIndex = new WorkflowStepParticipationIndex(new Map());
  participationIndex.record(child, 'reviewers', [delegateEntry], []);
  participationIndex.record(child, 'arch-review', [delegateEntry], ['05-arch-review.md']);
  return {
    version: 2 as const,
    stack: [
      delegateEntry,
      buildWorkflowResumePointEntry(child, 'fix', 'agent', 1, new Map([['reviewers', 1]])),
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

function prepareResumedTask(
  runner: TaskRunner,
  mode: ResumeMode,
  projectDir: string,
): TaskInfo {
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
    undefined,
    undefined,
    resumePoint,
  );
}

function writeSourceRunMeta(projectDir: string): void {
  const runRoot = `.takt/runs/${sourceRunSlug}`;
  const runDir = join(projectDir, runRoot);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: 'resume inherited review reports',
    workflow: 'parent-fix',
    runSlug: sourceRunSlug,
    runRoot,
    reportDirectory: `${runRoot}/reports`,
    contextDirectory: `${runRoot}/context`,
    logsDirectory: `${runRoot}/logs`,
    status: 'failed',
    startTime: '2026-07-17T00:00:00.000Z',
    endTime: '2026-07-17T00:01:00.000Z',
    reason: 'source run stopped before the resumed fix',
  }), 'utf-8');
}

async function writeSourceReports(projectDir: string, withFindingContract: boolean): Promise<{
  sourceReportDir: string;
  sourceLedger?: ReturnType<typeof parseFindingLedger>;
  sourceStore?: FindingLedgerStore;
}> {
  writeSourceRunMeta(projectDir);
  const sourceReportDir = join(
    projectDir,
    '.takt',
    'runs',
    sourceRunSlug,
    'reports',
    'subworkflows',
    buildWorkflowCallNamespace(projectDir, 1),
  );
  mkdirSync(sourceReportDir, { recursive: true });
  writeFileSync(join(sourceReportDir, '05-arch-review.md'), 'previous architecture review', 'utf-8');

  if (!withFindingContract) {
    return { sourceReportDir };
  }

  const sourceStore = createTestFindingLedgerStore({
    projectCwd: projectDir,
    runId: sourceRunSlug,
    reportDir: sourceReportDir,
    workflowName: 'child-fix',
    authorityKey: buildWorkflowCallAuthorityKey(projectDir, 1),
  });
  const sourceLedger = sourceStore.loadLedger();
  return { sourceReportDir, sourceLedger, sourceStore };
}

function findResumedRunSlug(projectDir: string): string {
  const runNames = readdirSync(join(projectDir, '.takt', 'runs'));
  const resumedRunSlug = runNames.find((name) => name !== sourceRunSlug);
  if (!resumedRunSlug) {
    throw new Error('Resumed run directory was not created');
  }
  return resumedRunSlug;
}

function readResumeArtifacts(projectDir: string, runSlug: string) {
  return JSON.parse(readFileSync(join(
    projectDir,
    '.takt',
    'runs',
    runSlug,
    'reports',
    'resume-artifacts.json',
  ), 'utf-8')) as {
    version: number;
    sourceRunSlug: string;
    targetRunSlug: string;
    files: Array<{ path: string; size: number; sha256: string }>;
  };
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

  it.each([false, true])('honors report inheritance and finding storage contracts (finding contract: %s)', async (withFindingContract) => {
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

    const source = await writeSourceReports(environment.projectDir, withFindingContract);
    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(
      runner,
      mode,
      environment.projectDir,
    );

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    if (mode === 'requeue' && !withFindingContract) {
      const sourceDatabasePath = buildRunPaths(
        environment.projectDir,
        sourceRunSlug,
      ).findingContractDatabaseAbs;
      const targetDatabasePath = buildRunPaths(
        environment.projectDir,
        resumedRunSlug,
      ).findingContractDatabaseAbs;
      const resumedMeta = JSON.parse(readFileSync(join(
        environment.projectDir,
        '.takt',
        'runs',
        resumedRunSlug,
        'meta.json',
      ), 'utf-8')) as { reason?: string };

      expect(success).toBe(false);
      expect(instructions).toHaveLength(0);
      expect(resumedMeta.reason).toBe(
        `Requeue source run "${sourceRunSlug}" has no finding contract database: ${sourceDatabasePath}`,
      );
      expect(existsSync(targetDatabasePath)).toBe(false);
      return;
    }

    const inheritedReportPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      buildWorkflowCallNamespace(environment.projectDir, 1),
      '05-arch-review.md',
    );
    const inheritedReportRelativePath = [
      'subworkflows',
      buildWorkflowCallNamespace(environment.projectDir, 1),
      '05-arch-review.md',
    ].join('/');
    const inheritanceDiagnosticPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      buildWorkflowCallNamespace(environment.projectDir, 1),
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
    expect(readResumeArtifacts(environment.projectDir, resumedRunSlug)).toEqual(expect.objectContaining({
      version: 1,
      sourceRunSlug,
      targetRunSlug: resumedRunSlug,
      files: [
        expect.objectContaining({
          path: inheritedReportRelativePath,
          size: Buffer.byteLength('previous architecture review'),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
    }));
    expect(JSON.parse(readFileSync(inheritanceDiagnosticPath, 'utf-8'))).toEqual(expect.objectContaining({
      sourceReportDirectory: join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports'),
      status: 'partial',
      fallbackUsed: true,
      skipped: [expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: 'target_exists',
      })],
    }));
    if (source.sourceLedger !== undefined && source.sourceStore !== undefined) {
      expect(source.sourceStore.loadLedger()).toEqual(source.sourceLedger);
    }
  });
});

describe('IT: missing report source through task resume', () => {
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

  it('should fail before the resumed fix agent runs and publish an empty source snapshot when source reports are missing', async () => {
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

    writeSourceRunMeta(environment.projectDir);
    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(
      runner,
      'retry',
      environment.projectDir,
    );

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    const resumedMeta = JSON.parse(readFileSync(join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'meta.json',
    ), 'utf-8')) as { reason?: string };
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
    expect(readResumeArtifacts(environment.projectDir, resumedRunSlug)).toEqual(expect.objectContaining({
      version: 1,
      sourceRunSlug,
      targetRunSlug: resumedRunSlug,
      files: [],
    }));
    expect(diagnostic).toEqual(expect.objectContaining({
      sourceRunSlug,
      status: 'unavailable',
      fallbackUsed: true,
      skipped: [expect.objectContaining({
        reportName: '05-arch-review.md',
        reason: 'not_found',
      })],
    }));
    expect(resumedMeta.reason).toBe('rule_no_match');
  });
});
