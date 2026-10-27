import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import * as resources from '../infra/resources/index.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { selectTaskRetryStart } from '../features/tasks/list/taskRetryStartSelection.js';
import {
  invalidateAllResolvedConfigCache,
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
import { readRunMetaBySlug } from '../core/workflow/run/run-meta.js';
import { DebugLogger } from '../shared/utils/debug.js';
import { buildResumeReportConsumerKeyFromStack } from '../core/workflow/run/resume-report-consumer.js';
import { attachWorkflowOpaqueRef } from '../shared/workflowConfigMetadata.js';

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

function buildResumePoint(projectDir: string, previousChildRef?: string) {
  const { parent, child } = loadResumeWorkflows(projectDir);
  const savedChild = previousChildRef === undefined ? child : attachWorkflowOpaqueRef({ ...child }, previousChildRef);
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
    report_namespace_segment: buildWorkflowCallSiteIdentity({ stack: [delegateEntry], childWorkflow: savedChild }).runPathSegment,
  });
  const participationIndex = new WorkflowStepParticipationIndex(new Map());
  participationIndex.record(savedChild, 'reviewers', [delegateEntry], []);
  participationIndex.record(savedChild, 'arch-review', [delegateEntry], ['05-arch-review.md']);
  return {
    version: 2 as const,
    stack: [
      delegateEntry,
      buildWorkflowResumePointEntry(savedChild, 'fix', 'agent', 1, new Map([['reviewers', 1]])),
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
  previousChildRef?: string,
): TaskInfo {
  runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
  const sourceTask = runner.claimNextTasks(1)[0];
  if (!sourceTask) {
    throw new Error('Source task was not claimed');
  }
  const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, {
    runSlug: sourceRunSlug,
  });
  const resumePoint = buildResumePoint(projectDir, previousChildRef);

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

function writeSourceRunMeta(projectDir: string, resumePoint?: ReturnType<typeof buildResumePoint>): void {
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
    ...(resumePoint === undefined ? {} : { resumePoint }),
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
    skippedEntries: Array<{ path: string; reason: string }>;
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = originalConfigDir;
    }
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    if (environment && existsSync(environment.root)) {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  if (mode === 'requeue') {
    it('uses the saved child report after its workflow reference changes', async () => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const previousChildRef = `builtin:sha256:${'a'.repeat(64)}`;
      const point = buildResumePoint(environment.projectDir, previousChildRef);
      const savedRecord = Object.values(point.workflow_call_invocations)[0]!;
      const otherNamespace = buildWorkflowCallNamespace(environment.projectDir, 2);
      writeSourceRunMeta(environment.projectDir);
      const reports = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows');
      for (const [namespace, content] of [
        [savedRecord.report_namespace_segment, 'saved first invocation report'],
        [otherNamespace, 'other invocation report'],
      ]) {
        mkdirSync(join(reports, namespace!), { recursive: true });
        writeFileSync(join(reports, namespace!, '05-arch-review.md'), content!, 'utf-8');
      }
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      const task = prepareResumedTask(runner, 'requeue', environment.projectDir, previousChildRef);

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toHaveLength(1);
      expect(instructions[0]).toContain('saved first invocation report');
      expect(instructions[0]).not.toContain('other invocation report');
      const resumed = findResumedRunSlug(environment.projectDir);
      expect(readFileSync(join(environment.projectDir, '.takt', 'runs', resumed, 'reports', 'subworkflows', savedRecord.report_namespace_segment, '05-arch-review.md'), 'utf-8'))
        .toBe('saved first invocation report');
    });
  }

  if (mode === 'retry') {
    it.each([[false, 'nested'], [true, 'nested'], [true, 'other']] as const)('retries a completed nested call after parent ref update: %s %s', async (updated, selectedCall) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const workflowDir = join(environment.projectDir, '.takt', 'workflows');
      const parentPath = join(workflowDir, 'parent-fix.yaml');
      const builtinRoot = join(environment.root, 'builtins');
      const childPath = join(builtinRoot, 'en', 'workflows', 'child-fix.yaml');
      mkdirSync(join(builtinRoot, 'en', 'workflows'), { recursive: true });
      rmSync(join(workflowDir, 'child-fix.yaml'));
      vi.spyOn(resources, 'getResourcesDir').mockReturnValue(builtinRoot);
      vi.spyOn(resources, 'getLanguageResourcesDir').mockImplementation((lang) => join(builtinRoot, lang));
      writeFileSync(parentPath, [
        'name: parent-fix', 'initial_step: delegate', 'max_steps: 10', 'steps:',
        '  - name: delegate', '    kind: workflow_call', '    call: child-fix',
        '    rules:', '      - condition: COMPLETE', '        next: stopped',
        '  - name: stopped', '    persona: ./personas/fixer.md', '    instruction: stop-here',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n'));
      const childDefinition = [
        'name: child-fix', 'subworkflow:', '  callable: true', 'initial_step: nested', 'max_steps: 10', 'steps:',
        '  - name: nested', '    kind: workflow_call', '    call: nested-fix',
        '    rules:', '      - condition: COMPLETE', '        next: other',
        '  - name: other', '    kind: workflow_call', '    call: nested-fix',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n');
      writeFileSync(childPath, childDefinition);
      writeFileSync(join(workflowDir, 'nested-fix.yaml'), [
        'name: nested-fix', 'subworkflow:', '  callable: true', 'initial_step: fix', 'max_steps: 4', 'steps:',
        '  - name: fix', '    persona: ./personas/fixer.md', '    instruction: "Read {report:plan.md}"',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n'));
      invalidateAllResolvedConfigCache();
      const oldChild = loadWorkflowByIdentifier('child-fix', environment.projectDir)!;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        return { persona: 'fixer', status: instruction.includes('stop-here') ? 'blocked' : 'done', content: 'done', timestamp: new Date(), sessionId: 'session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('nested retry', { workflow: 'parent-fix' });
      const running = runner.claimNextTasks(1)[0]!;
      expect(await executeAndCompleteTask(running, runner, environment.projectDir)).toBe(false);
      const failed = runner.listAllTaskItems().find((item) => item.name === running.name)!;
      const slug = failed.runSlug!;
      const point = readRunMetaBySlug(environment.projectDir, slug)?.resumePoint;
      if (point === undefined) throw new Error('Expected source checkpoint');
      expect(point.stack.map((entry) => entry.step)).toEqual(['stopped']);
      const entries = Object.entries(point.workflow_call_invocations).map(([key, record]) => ({ key: JSON.parse(key) as { step: string }, record }));
      const outer = entries.find((entry) => entry.key.step === 'delegate')!.record;
      for (const call of ['nested', 'other']) {
        const record = entries.find((entry) => entry.key.step === call)!.record;
        const reportDir = join(environment.projectDir, '.takt', 'runs', slug, 'reports', 'subworkflows', outer.report_namespace_segment, 'subworkflows', record.report_namespace_segment);
        mkdirSync(reportDir, { recursive: true });
        writeFileSync(join(reportDir, 'plan.md'), `${call} saved report`);
      }
      if (updated) writeFileSync(childPath, childDefinition.replace('max_steps: 10', 'max_steps: 11'));
      invalidateAllResolvedConfigCache();
      expect(getWorkflowReference(loadWorkflowByIdentifier('child-fix', environment.projectDir)!) !== getWorkflowReference(oldChild)).toBe(updated);
      const parent = loadWorkflowByIdentifier('parent-fix', environment.projectDir)!;
      const selected = await selectTaskRetryStart(parent, { projectCwd: environment.projectDir, lookupCwd: environment.projectDir, resumePoint: point }, async (_message, options) => {
        const targets = options.filter((option) => option.selectable !== false && option.label.trim() === '"fix"');
        const target = targets[selectedCall === 'nested' ? 0 : 1];
        if (target === undefined) throw new Error('Expected nested fix');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected restart');
      expect(selected.selection.restartPoint.stack.map((entry) => entry.step)).toEqual(['delegate', selectedCall, 'fix']);
      const retry = runner.startReExecution(failed.name, ['failed'], 'retry', { restartPoint: selected.selection.restartPoint, sourceRunSlug: slug });
      const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: 'done', timestamp: new Date(), sessionId: 'session' };
      });
      expect(await executeAndCompleteTask(retry, runner, environment.projectDir)).toBe(true);
      expect(instructions[0]).toContain(`${selectedCall} saved report`);
      expect(instructions[0]).not.toContain(`${selectedCall === 'nested' ? 'other' : 'nested'} saved report`);
      const warnings = writeLog.mock.calls.filter(([level, , message]) => level === 'WARN' && /digest|hash|ref/i.test(message));
      expect(warnings.length > 0).toBe(updated);
      writeLog.mockRestore();
    });
    it.each([[false, 'delegate'], [true, 'delegate'], [true, 'other']] as const)(
      'inherits the completed %s sibling call after parent definition change: %s', async (updated, selectedCall) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const builtinRoot = join(environment.root, 'builtins');
      const builtinWorkflows = join(builtinRoot, 'en', 'workflows');
      mkdirSync(builtinWorkflows, { recursive: true });
      const parentPath = join(environment.projectDir, '.takt', 'workflows', 'parent-fix.yaml');
      const builtinParent = join(builtinWorkflows, 'parent-fix.yaml');
      const parentDefinition = readFileSync(parentPath, 'utf8') + [
        '', '  - name: other', '    kind: workflow_call', '    call: child-fix',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
        '  - name: stopped', '    persona: ./personas/fixer.md',
        '    instruction: stopped', '    rules:', '      - condition: done', '        next: COMPLETE',
      ].join('\n');
      writeFileSync(builtinParent, parentDefinition);
      rmSync(parentPath);
      vi.spyOn(resources, 'getResourcesDir').mockReturnValue(builtinRoot);
      vi.spyOn(resources, 'getLanguageResourcesDir').mockImplementation((lang) => join(builtinRoot, lang));
      invalidateAllResolvedConfigCache();
      const { parent: oldParent, child } = loadResumeWorkflows(environment.projectDir);
      const previous = buildResumePoint(environment.projectDir);
      const savedRecord = Object.values(previous.workflow_call_invocations)[0]!;
      const otherEntry = buildWorkflowResumePointEntry(oldParent, 'other', 'workflow_call', 1, undefined, 1);
      const otherNamespace = buildWorkflowCallSiteIdentity({ stack: [otherEntry], childWorkflow: child }).runPathSegment;
      const index = new WorkflowCallInvocationIndex(new Map(Object.entries(previous.workflow_call_invocations)));
      index.record(oldParent, 'other', [], { call_instance: 1, report_namespace_segment: otherNamespace, completed: true });
      const point = {
        ...previous,
        stack: [buildWorkflowResumePointEntry(oldParent, 'stopped', 'agent', 1)],
        workflow_call_invocations: Object.fromEntries(Object.entries(index.serialized())
          .map(([key, record]) => [key, { ...record, completed: true }])),
      };
      writeSourceRunMeta(environment.projectDir, point);
      const reports = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows');
      mkdirSync(join(reports, savedRecord.report_namespace_segment), { recursive: true });
      writeFileSync(join(reports, savedRecord.report_namespace_segment, '05-arch-review.md'), 'saved completed call report');
      mkdirSync(join(reports, otherNamespace), { recursive: true });
      writeFileSync(join(reports, otherNamespace, '05-arch-review.md'), 'other completed call report');
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
      const sourceTask = runner.claimNextTasks(1)[0]!;
      const source = runner.updateRunningTaskExecution(sourceTask.name, { runSlug: sourceRunSlug });
      runner.failTask({ task: source, success: false, response: 'stopped', executionLog: [],
        startedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T00:01:00.000Z' });
      if (updated) writeFileSync(builtinParent, parentDefinition.replace('max_steps: 4', 'max_steps: 5'));
      invalidateAllResolvedConfigCache();
      const { parent } = loadResumeWorkflows(environment.projectDir);
      expect(getWorkflowReference(parent) !== getWorkflowReference(oldParent)).toBe(updated);
      const selected = await selectTaskRetryStart(parent, {
        projectCwd: environment.projectDir, lookupCwd: environment.projectDir, resumePoint: point,
      }, async (_message, options) => {
        const targets = options.filter((option) => option.selectable !== false && option.label.trim() === '"fix"');
        const target = targets[selectedCall === 'delegate' ? 0 : 1];
        if (target === undefined) throw new Error('Expected retry step "fix"');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected selected child restart');
      expect(selected.selection.restartPoint.stack.map((entry) => entry.step)).toEqual([selectedCall, 'fix']);
      const task = runner.startReExecution(source.name, ['failed'], 'retry', {
        restartPoint: selected.selection.restartPoint, sourceRunSlug,
      });
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });
      const success = await executeAndCompleteTask(task, runner, environment.projectDir);
      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toHaveLength(1);
      expect(instructions[0]).toContain(selectedCall === 'delegate' ? 'saved completed call report' : 'other completed call report');
      expect(instructions[0]).not.toContain(selectedCall === 'delegate' ? 'other completed call report' : 'saved completed call report');
    });

    it('reads the saved child report from the selected retry step after a builtin update', async () => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      writeFileSync(join(environment.projectDir, '.takt', 'config.yaml'), 'language: en\nprovider: mock\n');
      const builtinRoot = join(environment.root, 'builtins');
      const builtinWorkflows = join(builtinRoot, 'en', 'workflows');
      mkdirSync(join(builtinWorkflows, 'personas'), { recursive: true });
      const projectChild = join(environment.projectDir, '.takt', 'workflows', 'child-fix.yaml');
      const builtinChild = join(builtinWorkflows, 'child-fix.yaml');
      const childDefinition = readFileSync(projectChild, 'utf-8').replace('initial_step: fix', 'initial_step: reviewers');
      writeFileSync(builtinChild, childDefinition);
      writeFileSync(join(builtinWorkflows, 'personas', 'fixer.md'), 'You are a fixer.\n');
      rmSync(projectChild);
      vi.spyOn(resources, 'getResourcesDir').mockReturnValue(builtinRoot);
      vi.spyOn(resources, 'getLanguageResourcesDir').mockImplementation((lang) => join(builtinRoot, lang));
      invalidateAllResolvedConfigCache();

      const point = buildResumePoint(environment.projectDir);
      const oldChildRef = point.stack[1]!.workflow_ref;
      const savedRecord = Object.values(point.workflow_call_invocations)[0]!;
      const otherNamespace = buildWorkflowCallNamespace(environment.projectDir, 2);
      writeSourceRunMeta(environment.projectDir, point);
      const reports = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows');
      for (const [namespace, content] of [
        [savedRecord.report_namespace_segment, 'saved first invocation report'],
        [otherNamespace, 'other invocation report'],
      ]) {
        mkdirSync(join(reports, namespace!), { recursive: true });
        writeFileSync(join(reports, namespace!, '05-arch-review.md'), content!, 'utf-8');
      }
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
      const sourceTask = runner.claimNextTasks(1)[0]!;
      const source = runner.updateRunningTaskExecution(sourceTask.name, { runSlug: sourceRunSlug });
      runner.failTask({
        task: source, success: false, response: 'source task stopped', executionLog: ['source task stopped'],
        startedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T00:01:00.000Z',
      });

      writeFileSync(builtinChild, childDefinition.replace('Inherited report:', 'Updated inherited report:'));
      invalidateAllResolvedConfigCache();
      const { parent, child } = loadResumeWorkflows(environment.projectDir);
      expect(getWorkflowReference(child)).not.toBe(oldChildRef);
      const selected = await selectTaskRetryStart(parent, {
        projectCwd: environment.projectDir, lookupCwd: environment.projectDir, resumePoint: point,
      }, async (_message, options) => {
        const target = options.find((option) => option.selectable !== false && option.label.trim() === '"fix"');
        if (target === undefined) throw new Error('Expected retry step "fix"');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected selected child restart');
      expect(selected.selection.restartPoint.stack.map((entry) => entry.step)).toEqual(['delegate', 'fix']);
      const task = runner.startReExecution(source.name, ['failed'], 'retry', {
        restartPoint: selected.selection.restartPoint, sourceRunSlug,
      });
      expect(task.data?.resume_point).toBeUndefined();
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({
          systemPrompt: typeof persona === 'string' ? persona : '',
          userInstruction: instruction,
        });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toHaveLength(1);
      expect(instructions[0]).toContain('saved first invocation report');
      expect(instructions[0]).not.toContain('other invocation report');
    });
  }

  it('starts the first agent with all regular reports inherited and the skipped-link notice displayed', async () => {
    environment = createEnvironment();
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    invalidateGlobalConfigCache();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const instructions: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      const reports = join(environment.projectDir, '.takt', 'runs', findResumedRunSlug(environment.projectDir), 'reports');
      expect(readFileSync(join(reports, 'plan.md'), 'utf-8')).toBe('full plan');
      expect(readFileSync(join(reports, 'evidence', 'proof.txt'), 'utf-8')).toBe('proof');
      expect(instruction).toContain('previous architecture review');
      const notices = output.mock.calls.map((args) => args.map(String).join(' '))
        .filter((line) => line.includes('[WARN]') && /skip|飛ば|除外/i.test(line));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/\b2\b/);
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
    const sourceReports = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports');
    writeFileSync(join(sourceReports, 'plan.md'), 'full plan');
    mkdirSync(join(sourceReports, 'evidence'));
    writeFileSync(join(sourceReports, 'evidence', 'proof.txt'), 'proof');
    const outside = join(environment.root, 'outside.md');
    writeFileSync(outside, 'outside secret');
    symlinkSync(outside, join(sourceReports, 'file-link'));
    symlinkSync(environment.globalDir, join(sourceReports, 'evidence', 'directory-link'), 'dir');
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

    expect(success, runner.listAllTaskItems().find((item) => item.name === resumedTask.name)?.failure?.error).toBe(true);
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
        expect.objectContaining({ path: 'evidence/proof.txt' }),
        expect.objectContaining({ path: 'plan.md' }),
        expect.objectContaining({
          path: inheritedReportRelativePath,
          size: Buffer.byteLength(source.sourceReportContent),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      skippedEntries: expect.arrayContaining([
        expect.objectContaining({ path: 'file-link', reason: expect.any(String) }),
        expect.objectContaining({ path: 'evidence/directory-link', reason: expect.any(String) }),
      ]),
    }));
    expect(readResumeArtifacts(environment.projectDir, resumedRunSlug).skippedEntries).toHaveLength(2);
    expect(existsSync(join(environment.projectDir, '.takt', 'runs', resumedRunSlug, 'reports', 'file-link'))).toBe(false);
    expect(existsSync(join(environment.projectDir, '.takt', 'runs', resumedRunSlug, 'reports', 'evidence', 'directory-link'))).toBe(false);
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

describe.each(['retry', 'requeue'] as const)('IT: unavailable report source through %s task resume', (mode) => {
  let environment: TestEnvironment;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each(['source run', 'source reports'])('stops before the first agent and records the task and run failure for missing %s', async (missing) => {
    environment = createEnvironment();
    process.env.TAKT_CONFIG_DIR = environment.globalDir;
    invalidateGlobalConfigCache();

    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(),
    });

    if (missing === 'source reports') writeSourceRunMeta(environment.projectDir);
    const runner = new TaskRunner(environment.projectDir);
    const resumedTask = prepareResumedTask(
      runner,
      mode,
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
    ), 'utf-8')) as { reason?: string; status?: string; iterations?: number };
    const reportRoot = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
    );
    expect(success).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    expect(resumedMeta).toMatchObject({ status: 'failed', iterations: 0 });
    expect(resumedMeta.reason).toContain(sourceRunSlug);
    expect(resumedMeta.reason).toMatch(/does not exist|missing|not found/i);
    const failedTask = runner.listAllTaskItems().find((item) => item.name === resumedTask.name);
    expect(failedTask?.kind).toBe('failed');
    expect(failedTask?.failure?.error).toBe(resumedMeta.reason);
    expect(existsSync(join(reportRoot, 'resume-artifacts.json'))).toBe(false);
    const errors = output.mock.calls.map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('[ERROR]'));
    expect(errors.some((line) => line.includes(sourceRunSlug) && /does not exist|missing|not found/i.test(line))).toBe(true);
  });
});
