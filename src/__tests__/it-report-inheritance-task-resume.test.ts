import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
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

function buildResumePoint(projectDir: string, previousChildRef?: string, previousParentRef?: string) {
  const { parent, child } = loadResumeWorkflows(projectDir);
  const savedParent = previousParentRef === undefined ? parent : attachWorkflowOpaqueRef({ ...parent }, previousParentRef);
  const savedChild = previousChildRef === undefined ? child : attachWorkflowOpaqueRef({ ...child }, previousChildRef);
  const delegateEntry = buildWorkflowResumePointEntry(
    savedParent,
    'delegate',
    'workflow_call',
    1,
    undefined,
    1,
  );
  const invocationIndex = new WorkflowCallInvocationIndex(new Map());
  invocationIndex.record(savedParent, 'delegate', [], {
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
  previousParentRef?: string,
): TaskInfo {
  runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
  const sourceTask = runner.claimNextTasks(1)[0];
  if (!sourceTask) {
    throw new Error('Source task was not claimed');
  }
  const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, {
    runSlug: sourceRunSlug,
  });
  const resumePoint = buildResumePoint(projectDir, previousChildRef, previousParentRef);

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
    it.each([[false, 'same'], [true, 'same'], [false, 'removed'], [false, 'kind changed']] as const)(
      'requeues a nested saved position after parent reference changes: %s, child step: %s', async (updated, change) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const workflowDir = join(environment.projectDir, '.takt', 'workflows');
      const builtinRoot = join(environment.root, 'builtins');
      const builtinWorkflows = join(builtinRoot, 'en', 'workflows');
      mkdirSync(builtinWorkflows, { recursive: true });
      const parentPath = join(workflowDir, 'parent-fix.yaml');
      const builtinParent = join(builtinWorkflows, 'parent-fix.yaml');
      const parentDefinition = readFileSync(parentPath, 'utf8');
      writeFileSync(builtinParent, parentDefinition);
      rmSync(parentPath);
      vi.spyOn(resources, 'getResourcesDir').mockReturnValue(builtinRoot);
      vi.spyOn(resources, 'getLanguageResourcesDir').mockImplementation((lang) => join(builtinRoot, lang));
      writeFileSync(join(workflowDir, 'child-fix.yaml'), [
        'name: child-fix', 'subworkflow:', '  callable: true', 'initial_step: nested', 'max_steps: 4', 'steps:',
        '  - name: nested', '    kind: workflow_call', '    call: nested-fix',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n'));
      const nestedPath = join(workflowDir, 'nested-fix.yaml');
      const nestedDefinition = [
        'name: nested-fix', 'subworkflow:', '  callable: true', 'initial_step: fix', 'max_steps: 4', 'steps:',
        '  - name: fix', '    persona: ./personas/fixer.md', '    instruction: "Read {report:plan.md}"',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n');
      writeFileSync(nestedPath, nestedDefinition);
      invalidateAllResolvedConfigCache();
      const oldParent = loadWorkflowByIdentifier('parent-fix', environment.projectDir)!;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        return { persona: 'fixer', status: 'blocked', content: 'blocked', timestamp: new Date(), sessionId: 'session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('nested requeue', { workflow: 'parent-fix' });
      const source = runner.claimNextTasks(1)[0]!;
      expect(await executeAndCompleteTask(source, runner, environment.projectDir)).toBe(false);
      let failed = runner.listAllTaskItems().find((item) => item.name === source.name)!;
      const sourceSlug = failed.runSlug!;
      let point = readRunMetaBySlug(environment.projectDir, sourceSlug)?.resumePoint;
      if (point === undefined) throw new Error('Expected nested source checkpoint');
      expect(point.stack.map((entry) => entry.step)).toEqual(['delegate', 'nested', 'fix']);
      const calls = Object.entries(point.workflow_call_invocations).map(([identity, record]) => ({ step: (JSON.parse(identity) as { step: string }).step, record }));
      const outer = calls.find((call) => call.step === 'delegate')!.record;
      const inner = calls.find((call) => call.step === 'nested')!.record;
      const reportDir = join(environment.projectDir, '.takt', 'runs', sourceSlug, 'reports', 'subworkflows', outer.report_namespace_segment, 'subworkflows', inner.report_namespace_segment);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'plan.md'), 'saved nested report');
      if (updated) writeFileSync(builtinParent, parentDefinition.replace('max_steps: 4', 'max_steps: 5'));
      if (change === 'removed') {
        writeFileSync(nestedPath, nestedDefinition.replace('initial_step: fix', 'initial_step: replacement').replace('name: fix\n', 'name: replacement\n'));
      } else if (change === 'kind changed') {
        writeFileSync(nestedPath, nestedDefinition.replace('    persona: ./personas/fixer.md\n    instruction: "Read {report:plan.md}"', [
          '    parallel:', '      - name: worker', '        persona: ./personas/fixer.md',
          '        instruction: worker', '        rules:', '          - condition: when(true)', '            next: COMPLETE',
        ].join('\n')));
      }
      invalidateAllResolvedConfigCache();
      expect(getWorkflowReference(loadWorkflowByIdentifier('parent-fix', environment.projectDir)!) !== getWorkflowReference(oldParent)).toBe(updated);
      const warnings = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: instructions.length === 1 ? 'blocked' : 'done', content: 'done', timestamp: new Date(), sessionId: 'session' };
      });
      if (change !== 'same') {
        runner.requeueTask(failed.name, ['failed'], { resumePoint: point, sourceRunSlug: failed.runSlug });
        const task = runner.claimNextTasks(1)[0]!;
        expect(await executeAndCompleteTask(task, runner, environment.projectDir)).toBe(false);
        expect(runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toContain('fix');
        expect(instructions).toEqual([]);
        return;
      }
      for (const attempt of [0, 1]) {
        runner.requeueTask(failed.name, ['failed'], { resumePoint: point, sourceRunSlug: failed.runSlug });
        const task = runner.claimNextTasks(1)[0]!;
        const success = await executeAndCompleteTask(task, runner, environment.projectDir);
        failed = runner.listAllTaskItems().find((item) => item.name === task.name)!;
        expect(success, failed.failure?.error).toBe(attempt === 1);
        expect(instructions[attempt]).toContain('saved nested report');
        if (attempt === 0) {
          point = readRunMetaBySlug(environment.projectDir, failed.runSlug!)?.resumePoint;
          expect(point?.stack.map((entry) => entry.step)).toEqual(['delegate', 'nested', 'fix']);
        }
      }
      expect(warnings.mock.calls.some(([level, , message]) => level === 'WARN' && /digest|hash|ref/i.test(message))).toBe(updated);
    });

    it.each([false, true])('resumes the saved child when the parent reference changes: %s', async (updated) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const previousParentRef = updated ? `builtin:sha256:${'a'.repeat(64)}` : undefined;
      const point = buildResumePoint(environment.projectDir, undefined, previousParentRef);
      const savedRecord = Object.values(point.workflow_call_invocations)[0]!;
      writeSourceRunMeta(environment.projectDir, point);
      const reportDir = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows', savedRecord.report_namespace_segment);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, '05-arch-review.md'), 'saved parent report');
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      const task = prepareResumedTask(runner, 'requeue', environment.projectDir, undefined, previousParentRef);
      const warnings = vi.spyOn(DebugLogger.getInstance(), 'writeLog');

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toHaveLength(1);
      expect(instructions[0]).toContain('saved parent report');
      expect(warnings.mock.calls.some(([level, , message]) => level === 'WARN' && /digest|hash|ref/i.test(message))).toBe(updated);
    });

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
    it.each([[1, 'delegate', true], [2, 'delegate', true], [2, 'COMPLETE', true], [2, 'COMPLETE', false]] as const)('retries the saved invocation %s with next %s and source run slug %s', async (stopAt, next, useSourceRunSlug) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const workflowDir = join(environment.projectDir, '.takt', 'workflows');
      writeFileSync(join(workflowDir, 'parent-fix.yaml'), [
        'name: parent-fix', 'initial_step: delegate', 'max_steps: 10', 'steps:',
        '  - name: delegate', '    kind: workflow_call', '    call: child-fix',
        '    rules:', '      - condition: COMPLETE', '        next: delegate',
      ].join('\n'));
      invalidateAllResolvedConfigCache();
      let calls = 0;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        calls += 1;
        return { persona: 'fixer', status: calls === stopAt ? 'blocked' : 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('repeated call retry', { workflow: 'parent-fix' });
      const source = runner.claimNextTasks(1)[0]!;
      expect(await executeAndCompleteTask(source, runner, environment.projectDir)).toBe(false);
      const failed = runner.listAllTaskItems().find((item) => item.name === source.name)!;
      const slug = failed.runSlug!;
      const point = readRunMetaBySlug(environment.projectDir, slug)?.resumePoint;
      if (point === undefined) throw new Error('Expected source checkpoint');
      expect(point.stack.map((entry) => entry.step)).toEqual(['delegate', 'fix']);
      expect(point.stack[0]?.call_instance).toBe(stopAt);
      const record = Object.values(point.workflow_call_invocations)[0]!;
      expect(record.call_instance).toBe(stopAt);
      const reports = join(environment.projectDir, '.takt', 'runs', slug, 'reports', 'subworkflows');
      for (const occurrence of [1, 2]) {
        const namespace = occurrence === stopAt ? record.report_namespace_segment : buildWorkflowCallNamespace(environment.projectDir, occurrence);
        mkdirSync(join(reports, namespace), { recursive: true });
        writeFileSync(join(reports, namespace, '05-arch-review.md'), occurrence === 1 ? 'first report' : 'second report');
      }
      const parentPath = join(workflowDir, 'parent-fix.yaml');
      writeFileSync(parentPath, readFileSync(parentPath, 'utf-8').replace('next: delegate', `next: ${next}`));
      invalidateAllResolvedConfigCache();
      const { parent } = loadResumeWorkflows(environment.projectDir);
      const selected = await selectTaskRetryStart(parent, { projectCwd: environment.projectDir, lookupCwd: environment.projectDir, resumePoint: point }, async (_message, options) => {
        const target = options.find((option) => option.selectable !== false && option.label.trim() === '"fix"');
        if (target === undefined) throw new Error('Expected retry step');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected restart');
      if (!useSourceRunSlug) {
        const tasksPath = join(environment.projectDir, '.takt', 'tasks.yaml');
        const storedTasks = parseYaml(readFileSync(tasksPath, 'utf-8')) as { tasks: Array<Record<string, unknown>> };
        const storedTask = storedTasks.tasks.find((task) => task.name === failed.name);
        if (storedTask === undefined) throw new Error('Expected failed task record');
        delete storedTask.run_slug;
        delete storedTask.source_run_slug;
        writeFileSync(tasksPath, stringifyYaml(storedTasks));
      }
      const retry = runner.startReExecution(failed.name, ['failed'], 'retry', {
        restartPoint: selected.selection.restartPoint,
        ...(useSourceRunSlug ? { sourceRunSlug: slug } : { sourceResumePoint: point }),
      });
      expect(retry.sourceRunSlug).toBe(useSourceRunSlug ? slug : undefined);
      if (!useSourceRunSlug) expect(retry.data?.source_resume_point).toEqual(point);
      const instructions: string[] = [];
      const lifecycle: Array<{ event: string; instance: number; savedInstance: number | undefined }> = [];
      const originalEmit = WorkflowEngine.prototype.emit;
      vi.spyOn(WorkflowEngine.prototype, 'emit').mockImplementation(function (event, ...args) {
        if (event === 'workflow_call:start' || event === 'workflow_call:complete') {
          const payload = args[0] as { step: string; callInstance: number };
          if (payload.step === 'delegate') {
            lifecycle.push({ event, instance: payload.callInstance, savedInstance: this.getResumePoint()?.stack[0]?.call_instance });
          }
        }
        return originalEmit.call(this, event, ...args);
      });
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: stopAt === 2 && instructions.length === 1 ? 'done' : 'blocked', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'session' };
      });
      await executeAndCompleteTask(retry, runner, environment.projectDir);
      expect(instructions).toHaveLength(stopAt === 2 && next === 'delegate' ? 2 : 1);
      if (useSourceRunSlug) {
        expect(instructions[0]).toContain(stopAt === 1 ? 'first report' : 'second report');
        expect(instructions[0]).not.toContain(stopAt === 1 ? 'second report' : 'first report');
      }
      const starts = lifecycle.filter((event) => event.event === 'workflow_call:start');
      const completions = lifecycle.filter((event) => event.event === 'workflow_call:complete');
      expect(starts).toHaveLength(instructions.length);
      expect(starts[0]?.instance).toBe(stopAt);
      expect(completions.map((event) => event.instance)).toEqual(starts.map((event) => event.instance));
      expect(starts.map((event) => event.savedInstance)).toEqual(starts.map((event) => event.instance));
      if (starts.length === 2) expect(starts[1]!.instance).not.toBe(starts[0]!.instance);
      const retrySlug = findRunSlugExcluding(environment.projectDir, new Set([slug]));
      const saved = readRunMetaBySlug(environment.projectDir, retrySlug)?.resumePoint;
      if (next === 'COMPLETE') {
        const completed = Object.values(saved!.workflow_call_invocations)[0]!;
        expect(completed.report_namespace_segment).toBe(record.report_namespace_segment);
        expect(completed.completed).toBe(true);
        return;
      }
      expect(saved?.stack.map((entry) => entry.step)).toEqual(['delegate', 'fix']);
      const savedCall = Object.values(saved!.workflow_call_invocations)[0]!;
      expect(savedCall.call_instance).toBe(saved!.stack[0]!.call_instance);
      if (stopAt === 2) {
        expect(savedCall.report_namespace_segment).not.toBe(record.report_namespace_segment);
      }
    });

    it.each([[false, 'nested', false], [true, 'nested', false], [true, 'other', false], [false, 'nested', true], [false, 'other', true]] as const)('retries a completed nested call after parent ref update: %s %s repeated: %s', async (updated, selectedCall, repeated) => {
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
        '    rules:', '      - condition: when(true)', `        next: ${repeated ? 'delegate' : 'COMPLETE'}`,
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
      let stoppedCalls = 0;
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        if (instruction.includes('stop-here')) stoppedCalls += 1;
        return { persona: 'fixer', status: instruction.includes('stop-here') && (!repeated || stoppedCalls === 2) ? 'blocked' : 'done', content: 'done', timestamp: new Date(), sessionId: 'session' };
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
      const entries = Object.entries(point.workflow_call_invocations).map(([key, record]) => ({ key: JSON.parse(key) as { step: string; calls: Array<{ instance: number }> }, record }));
      const outer = entries.find((entry) => entry.key.step === 'delegate')!.record;
      for (const call of ['nested', 'other']) {
        for (const entry of entries.filter((item) => item.key.step === call)) {
          const instance = entry.key.calls[0]!.instance;
          const outerNamespace = instance === outer.call_instance ? outer.report_namespace_segment : buildWorkflowCallNamespace(environment.projectDir, instance);
          const reportDir = join(environment.projectDir, '.takt', 'runs', slug, 'reports', 'subworkflows', outerNamespace, 'subworkflows', entry.record.report_namespace_segment);
          mkdirSync(reportDir, { recursive: true });
          writeFileSync(join(reportDir, 'plan.md'), repeated ? `${call} invocation ${instance} saved report` : `${call} saved report`);
        }
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
        return { persona: 'fixer', status: repeated ? 'blocked' : 'done', content: 'done', timestamp: new Date(), sessionId: 'session' };
      });
      expect(await executeAndCompleteTask(retry, runner, environment.projectDir)).toBe(!repeated);
      expect(instructions[0]).toContain(repeated ? `${selectedCall} invocation 2 saved report` : `${selectedCall} saved report`);
      expect(instructions[0]).not.toContain(repeated ? `${selectedCall} invocation 1 saved report` : `${selectedCall === 'nested' ? 'other' : 'nested'} saved report`);
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

    it('restores selected retry evidence from task data when source run metadata has no resume point', async () => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const point = buildResumePoint(environment.projectDir);
      const savedRecord = Object.values(point.workflow_call_invocations)[0]!;
      writeSourceRunMeta(environment.projectDir);
      const reportDir = join(
        environment.projectDir,
        '.takt',
        'runs',
        sourceRunSlug,
        'reports',
        'subworkflows',
        savedRecord.report_namespace_segment,
      );
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, '05-arch-review.md'), 'saved task-data report');
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('selected retry without run checkpoint', { workflow: 'parent-fix' });
      const sourceTask = runner.claimNextTasks(1)[0]!;
      const source = runner.updateRunningTaskExecution(sourceTask.name, { runSlug: sourceRunSlug });
      runner.failTask({
        task: source,
        success: false,
        response: 'source task stopped',
        executionLog: ['source task stopped'],
        startedAt: '2026-07-17T00:00:00.000Z',
        completedAt: '2026-07-17T00:01:00.000Z',
      });
      runner.requeueTask(source.name, ['failed'], { resumePoint: point, sourceRunSlug });
      const checkpointTask = runner.claimNextTasks(1)[0]!;
      runner.forceFailRunningTask(checkpointTask.name, { step: 'fix', error: 'stop with task checkpoint' });
      const existing = runner.listAllTaskItems().find((item) => item.name === source.name)!;
      const taskResumePoint = existing.data?.resume_point;
      expect(taskResumePoint).toEqual(point);
      expect(readRunMetaBySlug(environment.projectDir, sourceRunSlug)?.resumePoint).toBeUndefined();
      const { parent } = loadResumeWorkflows(environment.projectDir);
      const selected = await selectTaskRetryStart(parent, {
        projectCwd: environment.projectDir,
        lookupCwd: environment.projectDir,
        resumePoint: taskResumePoint,
      }, async (_message, options) => {
        const target = options.find((option) => option.selectable !== false && option.label.trim() === '"fix"');
        if (target === undefined) throw new Error('Expected selected child restart');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected selected child restart');
      const task = runner.startReExecution(existing.name, ['failed'], 'retry', {
        restartPoint: selected.selection.restartPoint,
        sourceResumePoint: taskResumePoint,
        sourceRunSlug,
      });
      expect(task.data?.resume_point).toBeUndefined();
      expect(task.data?.source_resume_point).toEqual(point);
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

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toEqual([expect.stringContaining('saved task-data report')]);
    });

    it.each([false, true])('restores root-agent report evidence and warns for a changed source ref: %s', async (updated) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const workflowDir = join(environment.projectDir, '.takt', 'workflows');
      const parentPath = join(workflowDir, 'parent-fix.yaml');
      const parentDefinition = [
        'name: parent-fix', 'initial_step: delegate', 'max_steps: 4', 'steps:',
        '  - name: delegate', '    kind: workflow_call', '    call: child-fix',
        '    rules:', '      - condition: COMPLETE', '        next: fix',
        '  - name: fix', '    persona: ./personas/fixer.md',
        '    input_reports:', '      from_step: delegate', '      reports: all',
        '    instruction: "Root inherited report: {report:05-arch-review.md}"',
        '    rules:', '      - condition: fix complete', '        next: COMPLETE',
      ].join('\n');
      writeFileSync(parentPath, parentDefinition);
      invalidateAllResolvedConfigCache();
      const { parent: oldParent } = loadResumeWorkflows(environment.projectDir);
      const childPoint = buildResumePoint(environment.projectDir);
      const [savedIdentity, savedInvocation] = Object.entries(childPoint.workflow_call_invocations)[0]!;
      const resumePoint = {
        ...childPoint,
        workflow_call_invocations: {
          [savedIdentity]: { ...savedInvocation, completed: true },
        },
        stack: [buildWorkflowResumePointEntry(oldParent, 'fix', 'agent', 1, new Map([['delegate', 1]]))],
      };
      writeSourceRunMeta(environment.projectDir, resumePoint);
      const savedRecord = resumePoint.workflow_call_invocations[savedIdentity]!;
      const reportDir = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows', savedRecord.report_namespace_segment);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, '05-arch-review.md'), 'saved selected root report');
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('restart root agent report', { workflow: 'parent-fix' });
      const sourceTask = runner.claimNextTasks(1)[0]!;
      const source = runner.updateRunningTaskExecution(sourceTask.name, { runSlug: sourceRunSlug });
      runner.failTask({
        task: source, success: false, response: 'source task stopped', executionLog: ['source task stopped'],
        startedAt: '2026-07-17T00:00:00.000Z', completedAt: '2026-07-17T00:01:00.000Z',
      });
      if (updated) {
        const builtinRoot = join(environment.root, 'builtins');
        const builtinWorkflows = join(builtinRoot, 'en', 'workflows');
        mkdirSync(builtinWorkflows, { recursive: true });
        writeFileSync(join(builtinWorkflows, 'parent-fix.yaml'), parentDefinition);
        rmSync(parentPath);
        vi.spyOn(resources, 'getResourcesDir').mockReturnValue(builtinRoot);
        vi.spyOn(resources, 'getLanguageResourcesDir').mockImplementation((lang) => join(builtinRoot, lang));
      }
      invalidateAllResolvedConfigCache();
      const { parent, child } = loadResumeWorkflows(environment.projectDir);
      expect(getWorkflowReference(parent) !== getWorkflowReference(oldParent)).toBe(updated);
      const selected = await selectTaskRetryStart(parent, {
        projectCwd: environment.projectDir, lookupCwd: environment.projectDir, resumePoint,
      }, async (_message, options) => {
        const target = options.filter((option) => option.selectable !== false && option.label.trim() === '"fix"').at(-1);
        if (target === undefined) throw new Error('Expected selected root restart');
        return target.value;
      });
      if (selected?.selection.kind !== 'restart') throw new Error('Expected root restart selection');
      expect(selected.selection.restartPoint.stack.map((entry) => entry.step)).toEqual(['fix']);
      const task = runner.startReExecution(source.name, ['failed'], 'retry', {
        restartPoint: selected.selection.restartPoint, sourceRunSlug,
      });
      const writeLog = vi.spyOn(DebugLogger.getInstance(), 'writeLog');
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      expect(instructions).toEqual([expect.stringContaining('saved selected root report')]);
      const warnings = writeLog.mock.calls.filter(([level, , message]) => level === 'WARN' && message.includes('Saved workflow reference'));
      expect(warnings.length > 0).toBe(updated);
      const retrySlug = findRunSlugExcluding(environment.projectDir, new Set([sourceRunSlug]));
      const saved = readRunMetaBySlug(environment.projectDir, retrySlug)?.resumePoint;
      const currentDelegate = buildWorkflowResumePointEntry(parent, 'delegate', 'workflow_call', 1, undefined, 1);
      const expectedParticipation = new WorkflowStepParticipationIndex(new Map());
      expectedParticipation.record(child, 'reviewers', [currentDelegate], []);
      expectedParticipation.record(child, 'arch-review', [currentDelegate], ['05-arch-review.md']);
      expect(saved?.workflow_step_participations).toEqual(expect.objectContaining(expectedParticipation.serialized()));
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

  describe.each(['requeue', 'retry'] as const)('root agent report inheritance through %s', (mode) => {
    it.each(['fix', 'implement'] as const)('resumes a root agent (%s) with a completed workflow call report after the parent reference changes', async (stepName) => {
      environment = createEnvironment();
      process.env.TAKT_CONFIG_DIR = environment.globalDir;
      invalidateGlobalConfigCache();
      const workflowDir = join(environment.projectDir, '.takt', 'workflows');
      writeFileSync(join(workflowDir, 'parent-fix.yaml'), [
        'name: parent-fix', 'initial_step: delegate', 'max_steps: 4', 'steps:',
        '  - name: delegate', '    kind: workflow_call', '    call: child-fix',
        '    rules:', '      - condition: COMPLETE', `        next: ${stepName}`,
        `  - name: ${stepName}`, '    persona: ./personas/fixer.md',
        '    input_reports:', '      from_step: delegate', '      reports: all',
        '    instruction: "Root inherited report: {report:05-arch-review.md}"',
        '    rules:', '      - condition: fix complete', '        next: COMPLETE',
      ].join('\n'));
      invalidateAllResolvedConfigCache();
      const previousParentRef = `project:sha256:${'a'.repeat(64)}`;
      const childPoint = buildResumePoint(environment.projectDir, undefined, previousParentRef);
      const { parent } = loadResumeWorkflows(environment.projectDir);
      const savedParent = attachWorkflowOpaqueRef({ ...parent }, previousParentRef);
      const [savedIdentity, savedInvocation] = Object.entries(childPoint.workflow_call_invocations)[0]!;
      const resumePoint = {
        ...childPoint,
        workflow_call_invocations: {
          [savedIdentity]: { ...savedInvocation, completed: true },
        },
        stack: [
          buildWorkflowResumePointEntry(savedParent, stepName, 'agent', 1, new Map([['delegate', 1]])),
        ],
      };
      const savedRecord = Object.values(resumePoint.workflow_call_invocations)[0]!;
      writeSourceRunMeta(environment.projectDir, resumePoint);
      const reportDir = join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports', 'subworkflows', savedRecord.report_namespace_segment);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, '05-arch-review.md'), 'saved root report');
      const instructions: string[] = [];
      vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
        options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction });
        instructions.push(instruction);
        return { persona: 'fixer', status: 'done', content: '[FIX:1]\nfix complete', timestamp: new Date(), sessionId: 'fix-session' };
      });
      const runner = new TaskRunner(environment.projectDir);
      runner.addTask('resume root agent report', { workflow: 'parent-fix' });
      const sourceTask = runner.claimNextTasks(1)[0]!;
      const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, { runSlug: sourceRunSlug });
      let task: TaskInfo;
      if (mode === 'requeue') {
        runner.exceedTask(taskWithSourceRun.name, {
          currentStep: stepName, newMaxSteps: 4, currentIteration: 1, resumePoint,
        });
        runner.requeueExceededTask(taskWithSourceRun.name);
        task = runner.claimNextTasks(1)[0]!;
      } else {
        completeSourceTask(runner, taskWithSourceRun);
        task = runner.startReExecution(taskWithSourceRun.name, ['completed'], mode, {
          startStep: undefined, retryNote: undefined, resumePoint,
        });
      }

      const success = await executeAndCompleteTask(task, runner, environment.projectDir);

      expect(success, runner.listAllTaskItems().find((item) => item.name === task.name)?.failure?.error).toBe(true);
      const resumedRunSlug = findResumedRunSlug(environment.projectDir);
      expect(readFileSync(join(
        environment.projectDir, '.takt', 'runs', resumedRunSlug, 'reports', 'subworkflows',
        savedRecord.report_namespace_segment, '05-arch-review.md',
      ), 'utf-8')).toBe('saved root report');
      expect(instructions).toEqual([expect.stringContaining('saved root report')]);
    });
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
