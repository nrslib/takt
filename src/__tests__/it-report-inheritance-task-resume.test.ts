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
import { invalidateGlobalConfigCache } from '../infra/config/index.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';

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
      '  ledger_path: .takt/findings/review-ledger.json',
      '  raw_findings_path: .takt/findings/raw',
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
    '              format: "# Architecture Review"',
    '        rules:',
    '          - condition: approved',
    '            next: COMPLETE',
    '    rules:',
    '      - condition: all("approved")',
    '        next: fix',
    '  - name: fix',
    '    persona: ./personas/fixer.md',
    '    instruction: "Inherited reports: {peer_reports}"',
    '    rules:',
    '      - condition: fix complete',
    '        next: COMPLETE',
  ].join('\n'), 'utf-8');

  return { root, projectDir, globalDir };
}

function buildResumePoint() {
  return {
    version: 1 as const,
    stack: [
      { workflow: 'parent-fix', step: 'delegate', kind: 'workflow_call' as const },
      { workflow: 'child-fix', step: 'fix', kind: 'agent' as const },
    ],
    iteration: 1,
    elapsed_ms: 0,
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

function prepareResumedTask(runner: TaskRunner, mode: ResumeMode): TaskInfo {
  runner.addTask('resume inherited review reports', { workflow: 'parent-fix' });
  const sourceTask = runner.claimNextTasks(1)[0];
  if (!sourceTask) {
    throw new Error('Source task was not claimed');
  }
  const taskWithSourceRun = runner.updateRunningTaskExecution(sourceTask.name, {
    runSlug: sourceRunSlug,
  });
  const resumePoint = buildResumePoint();

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
    'iteration-1--step-delegate--workflow-child-fix',
  );
  mkdirSync(sourceReportDir, { recursive: true });
  writeFileSync(join(sourceReportDir, '05-arch-review.md'), 'previous architecture review', 'utf-8');

  if (!withFindingContract) {
    return { sourceReportDir };
  }

  const sourceLedger = JSON.stringify({
    version: 1,
    workflowName: 'child-fix',
    nextId: 1,
    updatedAt: '2026-07-17T00:00:00.000Z',
    findings: [],
    rawFindings: [],
    conflicts: [],
  });
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
    const resumedTask = prepareResumedTask(runner, mode);

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    const inheritedReportPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      'iteration-2--step-delegate--workflow-child-fix',
      '05-arch-review.md',
    );
    const diagnosticPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      'iteration-2--step-delegate--workflow-child-fix',
      'review-report-inheritance.json',
    );

    expect(success).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain(inheritedReportPath);
    expect(instructions[0]).not.toContain(source.sourceReportDir);
    expect(readFileSync(inheritedReportPath, 'utf-8')).toBe('previous architecture review');
    expect(readFileSync(join(source.sourceReportDir, '05-arch-review.md'), 'utf-8')).toBe('previous architecture review');
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf-8'))).toEqual(expect.objectContaining({
      sourceRunSlug,
      sourceReportDirectory: join(environment.projectDir, '.takt', 'runs', sourceRunSlug, 'reports'),
      status: 'copied',
      fallbackUsed: false,
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

  it('should continue the requeued fix and record unavailable diagnostics when the source run was deleted', async () => {
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
    const resumedTask = prepareResumedTask(runner, 'requeue');

    const success = await executeAndCompleteTask(resumedTask, runner, environment.projectDir);

    const resumedRunSlug = findResumedRunSlug(environment.projectDir);
    const diagnosticPath = join(
      environment.projectDir,
      '.takt',
      'runs',
      resumedRunSlug,
      'reports',
      'subworkflows',
      'iteration-2--step-delegate--workflow-child-fix',
      'review-report-inheritance.json',
    );
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf-8')) as {
      sourceRunSlug?: string;
      status?: string;
      fallbackUsed?: boolean;
      skipped?: Array<{ reason?: string }>;
    };

    expect(success).toBe(true);
    expect(instructions).toHaveLength(1);
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
