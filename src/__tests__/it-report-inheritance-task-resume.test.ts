import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const injectedRuntimeEnvironmentFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/config/runtime-provider/provider-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/runtime-provider/provider-environment.js')>();
  return {
    ...actual,
    resolveRuntimeEnvironment: (...args: Parameters<typeof actual.resolveRuntimeEnvironment>) => {
      if (injectedRuntimeEnvironmentFailure.enabled) {
        throw new Error('injected zero-iteration bootstrap failure');
      }
      return actual.resolveRuntimeEnvironment(...args);
    },
  };
});

import { runAgent } from '../agents/runner.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import {
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../infra/config/index.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';
import {
  buildWorkflowResumePointEntry,
  getWorkflowReference,
} from '../core/workflow/workflow-reference.js';
import { buildWorkflowCallSiteIdentity } from '../core/workflow/workflow-call-site-identity.js';
import { WorkflowCallInvocationIndex } from '../core/workflow/workflow-call-invocation-index.js';
import { WorkflowStepParticipationIndex } from '../core/workflow/workflow-step-participation-index.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';
import { buildResumeReportConsumerKeyFromStack } from '../core/workflow/run/resume-report-consumer.js';

const sourceRunSlug = '20260717-source-run';
const resumeModes = ['requeue', 'retry', 'instruct'] as const;

type ResumeMode = typeof resumeModes[number];

interface TestEnvironment {
  root: string;
  projectDir: string;
  globalDir: string;
}

function createEnvironment(): TestEnvironment {
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
  writeFileSync(join(workflowsDir, 'experimental.yaml'), [
    'name: experimental',
    'initial_step: review',
    'max_steps: 4',
    'steps:',
    '  - name: review',
    '    kind: workflow_call',
    '    call: review-gate',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'), 'utf-8');
  writeFileSync(join(workflowsDir, 'review-gate.yaml'), [
    'name: review-gate',
    'subworkflow:',
    '  callable: true',
    'initial_step: final-gate',
    'max_steps: 4',
    'steps:',
    '  - name: final-gate',
    '    persona: ./personas/fixer.md',
    '    instruction: "Resolve final gate with {report:review-resolution.md}"',
    '    rules:',
    '      - condition: approved',
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

function loadFinalGateWorkflows(projectDir: string) {
  const parent = loadWorkflowByIdentifier('experimental', projectDir);
  if (!parent) {
    throw new Error('Final-gate parent workflow fixture could not be loaded');
  }
  const parentStep = parent.steps.find((step) => step.name === 'review');
  if (!parentStep || parentStep.kind !== 'workflow_call') {
    throw new Error('Final-gate workflow_call fixture could not be loaded');
  }
  const child = resolveWorkflowCallTarget(parent, parentStep, projectDir, projectDir);
  if (!child) {
    throw new Error('Final-gate child workflow fixture could not be loaded');
  }
  return { parent, child };
}

function buildFinalGateResumePoint(projectDir: string) {
  const { parent, child } = loadFinalGateWorkflows(projectDir);
  const reviewEntry = buildWorkflowResumePointEntry(
    parent,
    'review',
    'workflow_call',
    1,
    undefined,
    1,
  );
  const namespace = buildWorkflowCallSiteIdentity({
    stack: [reviewEntry],
    childWorkflow: child,
  }).runPathSegment;
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  invocationIndex.record(parent, 'review', [], {
    call_instance: 1,
    report_namespace_segment: namespace,
  });
  return {
    namespace,
    resumePoint: {
      version: 2 as const,
      stack: [
        reviewEntry,
        buildWorkflowResumePointEntry(child, 'final-gate', 'agent', 1),
      ],
      iteration: 1,
      elapsed_ms: 0,
      workflow_call_invocations: invocationIndex.serialized(),
      workflow_step_participations: {},
    },
  };
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
    {
      startStep: undefined,
      retryNote: undefined,
      resumePoint: resumePoint,
    },
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

function seedFinalGateResumeSource(projectDir: string): ReturnType<typeof buildFinalGateResumePoint> {
  const originRunSlug = '20260717-final-gate-origin';
  const oldNamespace = 'iteration-1--step-review--workflow-review-gate--site-' + 'a'.repeat(64);
  const oldReportPath = `subworkflows/${oldNamespace}/review-resolution.md`;
  const resume = buildFinalGateResumePoint(projectDir);
  const consumerKey = buildResumeReportConsumerKeyFromStack(resume.resumePoint.stack);
  if (consumerKey === undefined) {
    throw new Error('Final-gate consumer key could not be built');
  }
  const originReports = join(projectDir, '.takt', 'runs', originRunSlug, 'reports');
  mkdirSync(join(originReports, 'subworkflows', oldNamespace), { recursive: true });
  writeFileSync(
    join(originReports, ...oldReportPath.split('/')),
    'CHAINED REVIEW RESOLUTION',
    'utf-8',
  );
  inheritResumeReportSnapshot({
    cwd: projectDir,
    sourceRunSlug: originRunSlug,
    targetRunSlug: sourceRunSlug,
    resumeReportConsumers: [{
      consumerKey,
      reportDirectories: [`subworkflows/${resume.namespace}`, `subworkflows/${oldNamespace}`],
      references: [{ reference: 'review-resolution.md', path: oldReportPath }],
    }],
  });
  const runRoot = `.takt/runs/${sourceRunSlug}`;
  writeFileSync(join(projectDir, runRoot, 'meta.json'), JSON.stringify({
    task: 'resume nested final gate',
    workflow: 'experimental',
    runSlug: sourceRunSlug,
    runRoot,
    reportDirectory: `${runRoot}/reports`,
    contextDirectory: `${runRoot}/context`,
    logsDirectory: `${runRoot}/logs`,
    status: 'failed',
    startTime: '2026-07-17T00:00:00.000Z',
    endTime: '2026-07-17T00:01:00.000Z',
    iterations: 0,
    reason: 'intermediate run stopped before final-gate',
    resume_point: resume.resumePoint,
  }), 'utf-8');
  return resume;
}

function prepareFinalGateRequeue(
  runner: TaskRunner,
  resumePoint: ReturnType<typeof buildFinalGateResumePoint>['resumePoint'],
): TaskInfo {
  runner.addTask('resume nested final gate', { workflow: 'experimental' });
  const sourceTask = runner.claimNextTasks(1)[0];
  if (!sourceTask) {
    throw new Error('Final-gate source task was not claimed');
  }
  const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, {
    runSlug: sourceRunSlug,
  });
  runner.exceedTask(taskWithSourceRun.name, {
    currentStep: 'review',
    newMaxSteps: 4,
    currentIteration: 1,
    resumePoint,
  });
  runner.requeueExceededTask(taskWithSourceRun.name);
  const requeuedTask = runner.claimNextTasks(1)[0];
  if (!requeuedTask) {
    throw new Error('Final-gate requeued task was not claimed');
  }
  return requeuedTask;
}

async function writeSourceReports(projectDir: string): Promise<{
  sourceReportDir: string;
  sourceReportContent: string;
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
  const sourceReportContent = 'previous architecture review';
  writeFileSync(join(sourceReportDir, '05-arch-review.md'), sourceReportContent, 'utf-8');

  return { sourceReportDir, sourceReportContent };
}

function findResumedRunSlug(projectDir: string): string {
  const runNames = readdirSync(join(projectDir, '.takt', 'runs'));
  const resumedRunSlug = runNames.find((name) => name !== sourceRunSlug);
  if (!resumedRunSlug) {
    throw new Error('Resumed run directory was not created');
  }
  return resumedRunSlug;
}

function findRunSlugExcluding(projectDir: string, excluded: ReadonlySet<string>): string {
  const runSlug = readdirSync(join(projectDir, '.takt', 'runs'))
    .find((name) => !excluded.has(name) && existsSync(join(projectDir, '.takt', 'runs', name, 'meta.json')));
  if (!runSlug) {
    throw new Error('Expected run directory was not created');
  }
  return runSlug;
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
    resumeReportConsumers?: Array<{
      references: Array<{ reference: string; path: string }>;
    }>;
  };
}

describe.each(resumeModes)('IT: report inheritance through %s task resume', (mode) => {
  let environment: TestEnvironment;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    injectedRuntimeEnvironmentFailure.enabled = false;
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

  it('honors report inheritance across task resume', async () => {
    environment = createEnvironment();
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

    const source = await writeSourceReports(environment.projectDir);
    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(
      runner,
      mode,
      environment.projectDir,
    );

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
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
    expect(instructions[0]).toContain(source.sourceReportContent);
    expect(instructions[0]).not.toContain('{report:05-arch-review.md}');
    expect(instructions[0]).not.toContain(inheritedReportPath);
    expect(instructions[0]).not.toContain(source.sourceReportDir);
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe(source.sourceReportContent);
    expect(readFileSync(join(source.sourceReportDir, '05-arch-review.md'), 'utf-8')).toBe(source.sourceReportContent);
    expect(readResumeArtifacts(environment.projectDir, resumedRunSlug)).toEqual(expect.objectContaining({
      version: 2,
      sourceRunSlug,
      targetRunSlug: resumedRunSlug,
      files: [
        expect.objectContaining({
          path: inheritedReportRelativePath,
          size: Buffer.byteLength(source.sourceReportContent),
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
  });
});

describe('IT: nested final-gate report resolution through TaskRunner requeue', () => {
  let environment: TestEnvironment;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    injectedRuntimeEnvironmentFailure.enabled = false;
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

  function captureFinalGateInstructions(): string[] {
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
        content: '[FINAL-GATE:1]\napproved',
        timestamp: new Date(),
        sessionId: 'final-gate-session',
      };
    });
    return instructions;
  }

  it('resolves final-gate report through the snapshot mapping on the production requeue path', async () => {
    environment = createEnvironment();
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    invalidateGlobalConfigCache();
    const instructions = captureFinalGateInstructions();
    const { resumePoint } = seedFinalGateResumeSource(environment.projectDir);
    const runner = new TaskRunner(environment.projectDir);
    const requeuedTask = prepareFinalGateRequeue(runner, resumePoint);

    const success = await executeAndCompleteTask(requeuedTask, runner, environment.projectDir);

    const targetRunSlug = findRunSlugExcluding(
      environment.projectDir,
      new Set([sourceRunSlug, '20260717-final-gate-origin']),
    );
    const manifest = readResumeArtifacts(environment.projectDir, targetRunSlug);
    expect(success).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(manifest.resumeReportConsumers?.[0]?.references).toEqual([
      expect.objectContaining({ reference: 'review-resolution.md' }),
    ]);
  });

  it('propagates final-gate snapshot mapping through a zero-iteration failed requeue', async () => {
    environment = createEnvironment();
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    const { resumePoint } = seedFinalGateResumeSource(environment.projectDir);
    const runner = new TaskRunner(environment.projectDir);
    const firstRequeue = prepareFinalGateRequeue(runner, resumePoint);
    injectedRuntimeEnvironmentFailure.enabled = true;

    const firstSuccess = await executeAndCompleteTask(firstRequeue, runner, environment.projectDir);
    injectedRuntimeEnvironmentFailure.enabled = false;
    const failedTask = runner.listFailedTasks()[0];
    if (!failedTask?.runSlug) {
      throw new Error('Zero-iteration requeue did not persist its run slug');
    }
    const intermediateRunSlug = failedTask.runSlug;
    const intermediateMeta = JSON.parse(readFileSync(join(
      environment.projectDir,
      '.takt',
      'runs',
      intermediateRunSlug,
      'meta.json',
    ), 'utf-8')) as { status?: string; iterations?: number };
    const intermediateManifest = readResumeArtifacts(environment.projectDir, intermediateRunSlug);

    expect(firstSuccess).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(intermediateMeta).toEqual(expect.objectContaining({ status: 'failed', iterations: 0 }));
    expect(intermediateManifest.resumeReportConsumers?.[0]?.references).toEqual([
      expect.objectContaining({ reference: 'review-resolution.md' }),
    ]);

    runner.requeueTask(failedTask.name, ['failed'], {
      workflow: 'experimental',
      resumePoint,
      sourceRunSlug: intermediateRunSlug,
    });
    const secondRequeue = runner.claimNextTasks(1)[0];
    if (!secondRequeue) {
      throw new Error('Second final-gate requeue was not claimed');
    }
    const instructions = captureFinalGateInstructions();

    const secondSuccess = await executeAndCompleteTask(
      secondRequeue,
      runner,
      environment.projectDir,
    );

    expect(secondSuccess).toBe(true);
    expect(instructions).toHaveLength(1);
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

  it('should continue the resumed fix with a missing-report sentence when source reports are missing', async () => {
    environment = createEnvironment();
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

    expect(success).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain(
      '（参照先の報告 05-arch-review.md はこの run に存在しない）',
    );
    expect(readResumeArtifacts(environment.projectDir, resumedRunSlug)).toEqual(expect.objectContaining({
      version: 2,
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
    expect(resumedMeta.reason).toBeUndefined();
  });
});
