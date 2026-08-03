import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { selectTaskRetryStart } from '../features/tasks/list/taskRetryStartSelection.js';
import { validateTaskRetryRestartPoint } from '../features/tasks/taskRetryStartPath.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
} from '../infra/config/index.js';
import { getScenarioQueue, resetScenario, setMockScenario } from '../infra/mock/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import {
  TaskExecutionConfigSchema,
  TaskRecordSchema,
} from '../infra/task/schema.js';
import { buildWorkflowCallInvocationFixture } from './helpers/workflow-resume-fixture.js';
import type { WorkflowRestartPoint } from '../core/models/index.js';
import {
  buildWorkflowRestartPointEntry,
  buildWorkflowResumePointEntry,
} from '../core/workflow/workflow-reference.js';
import { readRunMetaBySlug } from '../core/workflow/run/run-meta.js';

const tempDirs = new Set<string>();
let originalTaktConfigDir: string | undefined;
let originalMockCallLog: string | undefined;

function createProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-task-restart-'));
  tempDirs.add(projectDir);
  fs.mkdirSync(path.join(projectDir, '.takt', 'workflows'), { recursive: true });
  const globalConfigDir = path.join(projectDir, '.global-takt');
  fs.mkdirSync(globalConfigDir, { recursive: true });
  fs.writeFileSync(path.join(globalConfigDir, 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  process.env.TAKT_CONFIG_DIR = globalConfigDir;
  return projectDir;
}

function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = path.join(projectDir, '.takt', 'workflows', relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeNestedWorkflows(projectDir: string, childStep: string): void {
  writeWorkflow(projectDir, 'default.yaml', [
    'name: default',
    'initial_step: delegate',
    'max_steps: 5',
    'steps:',
    '  - name: delegate',
    '    kind: workflow_call',
    '    call: coding',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'));
  writeWorkflow(projectDir, 'coding.yaml', [
    'name: coding',
    'subworkflow:',
    '  callable: true',
    `initial_step: ${childStep}`,
    'steps:',
    `  - name: ${childStep}`,
    '    persona: reviewer',
    '    instruction: Review',
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
  ].join('\n'));
}

function writeNestedSystemWorkflow(
  projectDir: string,
  stepName: string,
  withEffect: boolean,
): void {
  writeNestedWorkflows(projectDir, stepName);
  writeWorkflow(projectDir, 'coding.yaml', [
    'name: coding',
    'subworkflow:',
    '  callable: true',
    `initial_step: ${stepName}`,
    'steps:',
    `  - name: ${stepName}`,
    '    kind: system',
    ...(withEffect
      ? [
          '    effects:',
          '      - type: merge_pr',
          '        pr: 42',
        ]
      : []),
    '    rules:',
    '      - condition: when(true)',
    '        next: COMPLETE',
  ].join('\n'));
}

function writeRootRestartLifecycleWorkflows(projectDir: string): void {
  const personaDir = path.join(projectDir, '.takt', 'facets', 'personas');
  fs.mkdirSync(personaDir, { recursive: true });
  for (const persona of ['before-persona', 'selected-persona', 'child-first-persona']) {
    fs.writeFileSync(path.join(personaDir, `${persona}.md`), `You are ${persona}.\n`, 'utf-8');
  }
  writeWorkflow(projectDir, 'default.yaml', [
    'name: default',
    'initial_step: before',
    'max_steps: 10',
    'steps:',
    '  - name: before',
    '    persona: before-persona',
    '    instruction: Before selected restart target',
    '    rules:',
    '      - condition: when(true)',
    '        next: selected',
    '  - name: selected',
    '    persona: selected-persona',
    '    instruction: Selected root restart target',
    '    rules:',
    '      - condition: when(true)',
    '        next: delegate',
    '  - name: delegate',
    '    kind: workflow_call',
    '    call: child',
    '    rules:',
    '      - condition: ok',
    '        next: COMPLETE',
    '      - condition: ABORT',
    '        next: ABORT',
  ].join('\n'));
  writeWorkflow(projectDir, 'child.yaml', [
    'name: child',
    'subworkflow:',
    '  callable: true',
    '  returns: [ok]',
    'initial_step: child-first',
    'steps:',
    '  - name: child-first',
    '    persona: child-first-persona',
    '    instruction: Child initial step',
    '    rules:',
    '      - condition: when(true)',
    '        return: ok',
  ].join('\n'));
}

function writeRestartExecutionWorkflows(projectDir: string): void {
  const personaDir = path.join(projectDir, '.takt', 'facets', 'personas');
  fs.mkdirSync(personaDir, { recursive: true });
  for (const persona of [
    'root-before-persona',
    'child-before-persona',
    'grand-before-persona',
    'target-persona',
    'grand-normal-persona',
    'child-normal-persona',
    'root-normal-persona',
  ]) {
    fs.writeFileSync(path.join(personaDir, `${persona}.md`), `You are ${persona}.\n`, 'utf-8');
  }

  writeWorkflow(projectDir, 'default.yaml', [
    'name: default',
    'initial_step: root-before',
    'max_steps: 20',
    'steps:',
    '  - name: root-before',
    '    persona: root-before-persona',
    '    instruction: Root before',
    '    rules:',
    '      - condition: when(true)',
    '        next: delegate',
    '  - name: delegate',
    '    kind: workflow_call',
    '    call: coding',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: root-tail',
    '  - name: root-tail',
    '    kind: workflow_call',
    '    call: root-tail',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'));
  writeWorkflow(projectDir, 'coding.yaml', [
    'name: coding',
    'subworkflow:',
    '  callable: true',
    'initial_step: child-before',
    'steps:',
    '  - name: child-before',
    '    persona: child-before-persona',
    '    instruction: Child before',
    '    rules:',
    '      - condition: when(true)',
    '        next: delegate-review',
    '  - name: delegate-review',
    '    kind: workflow_call',
    '    call: review-loop',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: child-tail',
    '  - name: child-tail',
    '    kind: workflow_call',
    '    call: child-tail',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'));
  writeWorkflow(projectDir, 'review-loop.yaml', [
    'name: review-loop',
    'subworkflow:',
    '  callable: true',
    'initial_step: grand-before',
    'steps:',
    '  - name: grand-before',
    '    persona: grand-before-persona',
    '    instruction: Grandchild before',
    '    rules:',
    '      - condition: when(true)',
    '        next: target',
    '  - name: target',
    '    persona: target-persona',
    '    instruction: Selected target',
    '    rules:',
    '      - condition: when(true)',
    '        next: grand-tail',
    '  - name: grand-tail',
    '    kind: workflow_call',
    '    call: grand-tail',
    '    rules:',
    '      - condition: COMPLETE',
    '        next: COMPLETE',
  ].join('\n'));
  for (const [workflow, persona] of [
    ['grand-tail', 'grand-normal-persona'],
    ['child-tail', 'child-normal-persona'],
    ['root-tail', 'root-normal-persona'],
  ] as const) {
    writeWorkflow(projectDir, `${workflow}.yaml`, [
      `name: ${workflow}`,
      'subworkflow:',
      '  callable: true',
      'initial_step: run',
      'steps:',
      '  - name: run',
      `    persona: ${persona}`,
      '    instruction: Normal call after restart target',
      '    rules:',
      '      - condition: when(true)',
      '        next: COMPLETE',
    ].join('\n'));
  }
}

function buildExecutionRestartPoint(projectDir: string): WorkflowRestartPoint {
  const root = loadWorkflowByIdentifier('default', projectDir);
  const child = loadWorkflowByIdentifier('coding', projectDir);
  const grandchild = loadWorkflowByIdentifier('review-loop', projectDir);
  if (root === null || child === null || grandchild === null) {
    throw new Error('Expected restart execution workflows');
  }
  const rootEntry = buildWorkflowRestartPointEntry(root, 'delegate', 'workflow_call', 1);
  const childEntry = buildWorkflowRestartPointEntry(child, 'delegate-review', 'workflow_call', 1);
  const targetEntry = buildWorkflowRestartPointEntry(grandchild, 'target', 'agent');
  return {
    stack: [rootEntry, childEntry, targetEntry],
  };
}

function readStartedMockPersonas(logPath: string): string[] {
  return fs.readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; personaName: string })
    .filter((entry) => entry.event === 'start')
    .map((entry) => entry.personaName);
}

function makeRestartPoint(): WorkflowRestartPoint {
  return {
    stack: [
      {
        workflow: 'default',
        workflow_ref: 'default',
        step: 'delegate',
        kind: 'workflow_call' as const,
        call_instance: 1,
      },
      {
        workflow: 'coding',
        workflow_ref: 'coding',
        step: 'review',
        kind: 'agent' as const,
      },
      {
        workflow: 'review-loop',
        workflow_ref: 'review-loop',
        step: 'approve',
        kind: 'agent' as const,
      },
    ],
  };
}

function buildNestedRestartPoint(projectDir: string): WorkflowRestartPoint {
  const root = loadWorkflowByIdentifier('default', projectDir);
  const child = loadWorkflowByIdentifier('coding', projectDir);
  if (root === null || child === null) {
    throw new Error('Expected nested restart workflows');
  }
  return {
    stack: [
      buildWorkflowRestartPointEntry(root, 'delegate', 'workflow_call', 1),
      buildWorkflowRestartPointEntry(child, 'review', 'agent'),
    ],
  };
}

async function selectRestartPath(
  root: NonNullable<ReturnType<typeof loadWorkflowByIdentifier>>,
  projectDir: string,
  labels: string[],
): Promise<WorkflowRestartPoint> {
  let labelIndex = 0;
  const selected = await selectTaskRetryStart(root, {
    projectCwd: projectDir,
    lookupCwd: projectDir,
  }, async (_message, options) => {
    const label = labels[labelIndex]!;
    labelIndex += 1;
    const option = options.find((candidate) => candidate.label === label);
    if (option === undefined) {
      throw new Error(`Expected retry option: ${label}`);
    }
    return option.value;
  });
  if (selected?.selection.kind !== 'restart') {
    throw new Error('Expected restart selection');
  }
  return selected.selection.restartPoint;
}

function makeResumePoint() {
  const stack = [
    {
      workflow: 'default',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 8,
      step_iterations: { delegate: 8 },
    },
    {
      workflow: 'coding',
      step: 'old-review',
      kind: 'agent' as const,
      step_iterations: { 'old-review': 5 },
    },
  ];
  return {
    version: 2 as const,
    stack,
    iteration: 23,
    elapsed_ms: 987_654,
    workflow_call_invocations: buildWorkflowCallInvocationFixture(stack),
    workflow_step_participations: {},
  };
}

function writeFailedTask(projectDir: string): void {
  const record = TaskRecordSchema.parse({
    name: 'nested-retry',
    status: 'failed',
    content: 'Retry nested workflow',
    workflow: 'default',
    start_step: 'delegate',
    resume_point: makeResumePoint(),
    exceeded_current_iteration: 23,
    exceeded_max_steps: 30,
    created_at: '2026-08-02T00:00:00.000Z',
    started_at: '2026-08-02T00:01:00.000Z',
    completed_at: '2026-08-02T00:02:00.000Z',
    owner_pid: null,
    failure: { step: 'delegate', error: 'child failed' },
  });
  fs.mkdirSync(path.join(projectDir, '.takt'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

beforeEach(() => {
  originalTaktConfigDir = process.env.TAKT_CONFIG_DIR;
  originalMockCallLog = process.env.TAKT_MOCK_CALL_LOG;
  resetScenario();
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  if (originalTaktConfigDir === undefined) {
    delete process.env.TAKT_CONFIG_DIR;
  } else {
    process.env.TAKT_CONFIG_DIR = originalTaktConfigDir;
  }
  if (originalMockCallLog === undefined) {
    delete process.env.TAKT_MOCK_CALL_LOG;
  } else {
    process.env.TAKT_MOCK_CALL_LOG = originalMockCallLog;
  }
  resetScenario();
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
});

describe('WorkflowRestartPoint schema', () => {
  it('should accept a stateless restart path at the task input boundary', () => {
    const restartPoint = makeRestartPoint();

    const parsed = TaskExecutionConfigSchema.parse({
      workflow: 'default',
      restart_point: restartPoint,
    });

    expect(parsed.restart_point).toEqual(restartPoint);
    expect(parsed.restart_point).not.toHaveProperty('iteration');
    expect(parsed.restart_point).not.toHaveProperty('elapsed_ms');
  });

  it.each([0, 1, 2])('should reject a restart path without workflow_ref at stack index %s', (index) => {
    const restartPoint = makeRestartPoint();
    const stack = restartPoint.stack.map((entry, entryIndex) => {
      if (entryIndex !== index) {
        return entry;
      }
      const { workflow_ref: _workflowRef, ...entryWithoutRef } = entry;
      return entryWithoutRef;
    });

    const result = TaskExecutionConfigSchema.safeParse({
      workflow: 'default',
      restart_point: { ...restartPoint, stack },
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['iteration', 7],
    ['elapsed_ms', 10_000],
    ['step_iterations', { review: 3 }],
  ])('should reject checkpoint state field %s inside restart_point', (field, value) => {
    const restartPoint = makeRestartPoint() as Record<string, unknown>;
    const invalidRestartPoint = field === 'step_iterations'
      ? {
          ...restartPoint,
          stack: [
            restartPoint.stack instanceof Array ? restartPoint.stack[0] : undefined,
            {
              ...(restartPoint.stack instanceof Array ? restartPoint.stack[1] : {}),
              [field]: value,
            },
          ],
        }
      : { ...restartPoint, [field]: value };

    const result = TaskExecutionConfigSchema.safeParse({
      workflow: 'default',
      restart_point: invalidRestartPoint,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected invalid restart point to be rejected');
    }
    expect(result.error.issues.some((issue) => issue.path.includes(field))).toBe(true);
  });

  it('should reject simultaneous checkpoint resume and stateless restart ownership', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      workflow: 'default',
      resume_point: makeResumePoint(),
      restart_point: makeRestartPoint(),
    })).toThrow(/resume_point.*restart_point|restart_point.*resume_point/i);
  });

  it('should reject simultaneous root start and nested restart ownership', () => {
    const result = TaskExecutionConfigSchema.safeParse({
      workflow: 'default',
      start_step: 'finalize',
      restart_point: makeRestartPoint(),
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['object stack', { stack: {} }],
    ['null stack', { stack: null }],
    ['missing stack', {}],
    ['empty stack', { stack: [] }],
    ['empty workflow', { stack: [{ workflow: '', workflow_ref: 'coding', step: 'review', kind: 'agent' }] }],
    ['blank workflow', { stack: [{ workflow: '   ', workflow_ref: 'coding', step: 'review', kind: 'agent' }] }],
    ['empty workflow_ref', { stack: [{ workflow: 'coding', workflow_ref: '', step: 'review', kind: 'agent' }] }],
    ['blank workflow_ref', { stack: [{ workflow: 'coding', workflow_ref: '  ', step: 'review', kind: 'agent' }] }],
    ['empty step', { stack: [{ workflow: 'coding', workflow_ref: 'coding', step: '', kind: 'agent' }] }],
    ['blank step', { stack: [{ workflow: 'coding', workflow_ref: 'coding', step: '\t', kind: 'agent' }] }],
    ['missing call instance', { stack: [{ workflow: 'coding', workflow_ref: 'coding', step: 'delegate', kind: 'workflow_call' }] }],
    ['agent call instance', { stack: [{ workflow: 'coding', workflow_ref: 'coding', step: 'review', kind: 'agent', call_instance: 1 }] }],
    ['system call instance', { stack: [{ workflow: 'coding', workflow_ref: 'coding', step: 'sync', kind: 'system', call_instance: 1 }] }],
  ])('should reject restart point with %s', (_name, restartPoint) => {
    const result = TaskExecutionConfigSchema.safeParse({
      workflow: 'default',
      restart_point: restartPoint,
    });

    expect(result.success).toBe(false);
  });

  it.each([0, 2, -1])('should reject workflow_call instance %s from outside the new execution', (callInstance) => {
    const currentRestartPoint = makeRestartPoint();
    const restartPoint = {
      ...currentRestartPoint,
      stack: [
        { ...currentRestartPoint.stack[0]!, call_instance: callInstance },
        ...currentRestartPoint.stack.slice(1),
      ],
    };

    const result = TaskExecutionConfigSchema.safeParse({
      workflow: 'default',
      restart_point: restartPoint,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected stale workflow_call instance to be rejected');
    }
    expect(result.error.issues.some((issue) => issue.path.includes('call_instance'))).toBe(true);
  });
});

describe('task restart persistence and execution resolution', () => {
  it('should reject a raw pending restart record with exceeded execution state without changing tasks.yaml', () => {
    const projectDir = createProject();
    const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
    const rawTasksYaml = stringifyYaml({
      tasks: [{
        name: 'nested-retry',
        status: 'pending',
        content: 'Retry nested workflow',
        workflow: 'default',
        restart_point: makeRestartPoint(),
        exceeded_current_iteration: 37,
        exceeded_max_steps: 50,
        created_at: '2026-08-02T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      }],
    });
    fs.writeFileSync(tasksFile, rawTasksYaml, 'utf-8');
    const runner = new TaskRunner(projectDir);

    expect(() => runner.listPendingTaskItems()).toThrow();
    expect(fs.readFileSync(tasksFile, 'utf-8')).toBe(rawTasksYaml);
  });

  it('should reject simultaneous resume and restart ownership without changing tasks.yaml', () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
    const rawTasksYaml = fs.readFileSync(tasksFile, 'utf-8');
    const runner = new TaskRunner(projectDir);

    expect(() => runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      undefined,
      makeResumePoint(),
      undefined,
      undefined,
      undefined,
      makeRestartPoint(),
    )).toThrow('Retry task cannot own both resume_point and restart_point');
    expect(fs.readFileSync(tasksFile, 'utf-8')).toBe(rawTasksYaml);
  });

  it('should preserve checkpoint resume ownership when requeueing without a restart point', () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const resumePoint = makeResumePoint();

    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      undefined,
      resumePoint,
    );
    const pending = runner.listPendingTaskItems()[0];

    expect(pending?.data?.resume_point).toEqual(resumePoint);
    expect(pending?.data?.restart_point).toBeUndefined();
  });

  it('should not reuse a stale start step when a queued checkpoint becomes invalid', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'old-review');
    writeFailedTask(projectDir);
    const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
    const failedTasks = parseYaml(fs.readFileSync(tasksFile, 'utf-8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    failedTasks.tasks[0]!.start_step = 'stale-step';
    delete failedTasks.tasks[0]!.exceeded_current_iteration;
    delete failedTasks.tasks[0]!.exceeded_max_steps;
    fs.writeFileSync(tasksFile, stringifyYaml(failedTasks), 'utf-8');
    const runner = new TaskRunner(projectDir);
    const resumePoint = makeResumePoint();

    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      undefined,
      resumePoint,
    );

    const persisted = parseYaml(fs.readFileSync(tasksFile, 'utf-8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(persisted.tasks[0]?.resume_point).toEqual(resumePoint);
    expect(persisted.tasks[0]?.start_movement).toBeUndefined();
    expect(persisted.tasks[0]?.start_step).toBeUndefined();

    writeWorkflow(projectDir, 'default.yaml', [
      'name: default',
      'initial_step: finalize',
      'max_steps: 5',
      'steps:',
      '  - name: finalize',
      '    persona: reviewer',
      '    instruction: Finalize',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
    ].join('\n'));
    invalidateAllResolvedConfigCache();
    const freshRunner = new TaskRunner(projectDir);
    const pending = freshRunner.listPendingTaskItems()[0];
    if (pending === undefined) {
      throw new Error('Expected requeued task');
    }

    const resolved = await resolveTaskExecution(pending, projectDir);
    expect(resolved.startStep).toBeUndefined();
    expect(resolved.resumePoint).toBeUndefined();
    expect(resolved.initialIterationOverride).toBeUndefined();
  });

  it('should reject a retry record that supplies both start_step and restart_point', () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);

    expect(() => runner.requeueTask(
      'nested-retry',
      ['failed'],
      'finalize',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeRestartPoint(),
    )).toThrow(/start_step.*restart_point|restart_point.*start_step/i);
  });

  it('should persist a top-level restart with start_step only', () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);

    runner.requeueTask('nested-retry', ['failed'], 'finalize');
    const pending = runner.listPendingTaskItems()[0];
    const tasksYaml = parseYaml(
      fs.readFileSync(path.join(projectDir, '.takt', 'tasks.yaml'), 'utf-8'),
    ) as { tasks: Array<Record<string, unknown>> };

    expect(pending?.data?.start_step).toBe('finalize');
    expect(tasksYaml.tasks[0]?.start_movement).toBe('finalize');
    expect(tasksYaml.tasks[0]?.start_step).toBeUndefined();
    expect(tasksYaml.tasks[0]?.restart_point).toBeUndefined();
    expect(tasksYaml.tasks[0]?.resume_point).toBeUndefined();
  });

  it('should persist and resolve a UI-style root restart only through restart_point', async () => {
    const projectDir = createProject();
    writeRootRestartLifecycleWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected root restart workflow');
    }
    const restartPoint: WorkflowRestartPoint = {
      stack: [buildWorkflowRestartPointEntry(root, 'selected', 'agent')],
    };
    const runner = new TaskRunner(projectDir);

    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart selected root step',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    const resolved = await resolveTaskExecution(pending, projectDir);
    const tasksYaml = parseYaml(
      fs.readFileSync(path.join(projectDir, '.takt', 'tasks.yaml'), 'utf-8'),
    ) as { tasks: Array<Record<string, unknown>> };

    expect(tasksYaml.tasks[0]?.restart_point).toEqual(restartPoint);
    expect(tasksYaml.tasks[0]?.start_step).toBeUndefined();
    expect(tasksYaml.tasks[0]?.start_movement).toBeUndefined();
    expect(tasksYaml.tasks[0]?.resume_point).toBeUndefined();
    expect(resolved.startStep).toBe('selected');
    expect(resolved.restartPoint).toEqual(restartPoint);
  });

  it('should keep a queued authored restart after initial_step changes', async () => {
    const projectDir = createProject();
    writeRootRestartLifecycleWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected root restart workflow');
    }
    const restartPoint: WorkflowRestartPoint = {
      stack: [buildWorkflowRestartPointEntry(root, root.initialStep, 'agent')],
    };
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry', ['failed'], undefined, undefined, undefined,
      undefined, undefined, undefined, restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    const workflowPath = path.join(projectDir, '.takt', 'workflows', 'default.yaml');
    fs.writeFileSync(
      workflowPath,
      fs.readFileSync(workflowPath, 'utf-8').replace('initial_step: before', 'initial_step: selected'),
      'utf-8',
    );
    invalidateAllResolvedConfigCache();

    const resolved = await resolveTaskExecution(pending, projectDir);
    expect(resolved.startStep).toBe('before');
  });

  it('should keep a queued non-initial restart after an unrelated initial_step change', async () => {
    const projectDir = createProject();
    writeRootRestartLifecycleWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected root restart workflow');
    }
    const restartPoint: WorkflowRestartPoint = {
      stack: [buildWorkflowRestartPointEntry(root, 'selected', 'agent')],
    };
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry', ['failed'], undefined, undefined, undefined,
      undefined, undefined, undefined, restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    const workflowPath = path.join(projectDir, '.takt', 'workflows', 'default.yaml');
    fs.writeFileSync(
      workflowPath,
      fs.readFileSync(workflowPath, 'utf-8').replace('initial_step: before', 'initial_step: delegate'),
      'utf-8',
    );
    invalidateAllResolvedConfigCache();

    const resolved = await resolveTaskExecution(pending, projectDir);
    expect(resolved.startStep).toBe('selected');
  });

  it('should roundtrip a Requeue restart path while removing stale checkpoint state', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const restartPoint = buildNestedRestartPoint(projectDir);

    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart child review',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    const resolved = await resolveTaskExecution(pending, projectDir);
    const tasksYaml = parseYaml(
      fs.readFileSync(path.join(projectDir, '.takt', 'tasks.yaml'), 'utf-8'),
    ) as { tasks: Array<Record<string, unknown>> };

    expect(tasksYaml.tasks[0]?.restart_point).toEqual(restartPoint);
    expect(tasksYaml.tasks[0]?.resume_point).toBeUndefined();
    expect(tasksYaml.tasks[0]?.exceeded_current_iteration).toBeUndefined();
    expect(tasksYaml.tasks[0]?.exceeded_max_steps).toBeUndefined();
    expect(pending.data?.restart_point).toEqual(restartPoint);
    expect(resolved.restartPoint).toEqual(restartPoint);
    expect(resolved.startStep).toBe('delegate');
    expect(resolved.resumePoint).toBeUndefined();
    expect(resolved.initialIterationOverride).toBeUndefined();
  });

  it('should roundtrip the same restart path through immediate Retry execution', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const restartPoint = buildNestedRestartPoint(projectDir);

    const running = runner.startReExecution(
      'nested-retry',
      ['failed'],
      'retry',
      undefined,
      'restart child review',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const resolved = await resolveTaskExecution(running, projectDir);

    expect(running.data?.restart_point).toEqual(restartPoint);
    expect(running.data?.resume_point).toBeUndefined();
    expect(running.data?.exceeded_current_iteration).toBeUndefined();
    expect(running.data?.exceeded_max_steps).toBeUndefined();
    expect(resolved.restartPoint).toEqual(restartPoint);
    expect(resolved.startStep).toBe('delegate');
    expect(resolved.initialIterationOverride).toBeUndefined();
  });

  it('should preserve a nested restart path through failure and auto-requeue', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const restartPoint = buildNestedRestartPoint(projectDir);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry', ['failed'], undefined, undefined, undefined,
      undefined, undefined, undefined, restartPoint,
    );
    const running = runner.claimNextTasks(1)[0];
    if (running === undefined) {
      throw new Error('Expected restart task to be claimed');
    }
    runner.failTask({
      task: running,
      success: false,
      response: 'Failed before checkpoint',
      executionLog: [],
      failureStep: 'review',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const autoRequeue = runner.autoRequeueFailedTask('nested-retry', { maxAttempts: 1 });
    const freshRunner = new TaskRunner(projectDir);
    const pending = freshRunner.listPendingTaskItems()[0];
    if (pending === undefined) {
      throw new Error('Expected auto-requeued task');
    }
    const resolved = await resolveTaskExecution(pending, projectDir);

    expect(autoRequeue.requeued).toBe(true);
    expect(pending.data?.restart_point).toEqual(restartPoint);
    expect(pending.data?.start_step).toBeUndefined();
    expect(pending.data?.resume_point).toBeUndefined();
    expect(resolved.restartPoint).toEqual(restartPoint);
    expect(resolved.startStep).toBe('delegate');
  });

  it('should fail queued restart revalidation instead of trimming to the parent workflow_call', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const restartPoint = buildNestedRestartPoint(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart child review',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    writeNestedWorkflows(projectDir, 'fix');
    invalidateAllResolvedConfigCache();

    await expect(resolveTaskExecution(pending, projectDir)).rejects.toThrow(/restart.*review/i);
  });

  it('should fail queued restart revalidation when the selected step kind changes', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const restartPoint = buildNestedRestartPoint(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart child review',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    writeNestedSystemWorkflow(projectDir, 'review', false);
    invalidateAllResolvedConfigCache();

    await expect(resolveTaskExecution(pending, projectDir)).rejects.toThrow(/restart.*review/i);
  });

  it('should reject a queued restart point targeting an effect-backed system step', async () => {
    const projectDir = createProject();
    writeNestedSystemWorkflow(projectDir, 'publish', true);
    writeFailedTask(projectDir);
    const runner = new TaskRunner(projectDir);
    const root = loadWorkflowByIdentifier('default', projectDir);
    const child = loadWorkflowByIdentifier('coding', projectDir);
    if (root === null || child === null) {
      throw new Error('Expected nested system workflows');
    }
    const restartPoint: WorkflowRestartPoint = {
      stack: [
        buildWorkflowRestartPointEntry(root, 'delegate', 'workflow_call', 1),
        buildWorkflowRestartPointEntry(child, 'publish', 'system'),
      ],
    };
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'tampered system restart',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;

    await expect(resolveTaskExecution(pending, projectDir)).rejects.toThrow(/restart.*publish/i);
  });

  it('should fail queued revalidation when a selected terminal workflow_call target disappears', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected default workflow');
    }
    const restartPoint = await selectRestartPath(root, projectDir, [
      'Restart from: "default" > "delegate"',
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart terminal call',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    fs.rmSync(path.join(projectDir, '.takt', 'workflows', 'coding.yaml'));
    invalidateAllResolvedConfigCache();

    await expect(resolveTaskExecution(pending, projectDir)).rejects.toThrow(/unknown workflow.*coding/i);
  });

  it('should fail queued revalidation when a selected terminal workflow_call target becomes non-callable', async () => {
    const projectDir = createProject();
    writeNestedWorkflows(projectDir, 'review');
    writeFailedTask(projectDir);
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected default workflow');
    }
    const restartPoint = await selectRestartPath(root, projectDir, [
      'Restart from: "default" > "delegate"',
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart terminal call',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const pending = runner.listPendingTaskItems()[0]!;
    const childPath = path.join(projectDir, '.takt', 'workflows', 'coding.yaml');
    fs.writeFileSync(
      childPath,
      fs.readFileSync(childPath, 'utf-8').replace('subworkflow:\n  callable: true\n', ''),
      'utf-8',
    );
    invalidateAllResolvedConfigCache();

    await expect(resolveTaskExecution(pending, projectDir)).rejects.toThrow(/coding.*not callable/i);
  });

  it('should select and strictly validate callable instances expanded with different args', async () => {
    const projectDir = createProject();
    writeWorkflow(projectDir, 'args-root.yaml', [
      'name: args-root',
      'initial_step: left',
      'max_steps: 10',
      'steps:',
      '  - name: left',
      '    kind: workflow_call',
      '    call: router',
      '    args:',
      '      target: leaf-a',
      '  - name: right',
      '    kind: workflow_call',
      '    call: router',
      '    args:',
      '      target: leaf-b',
    ].join('\n'));
    writeWorkflow(projectDir, 'router.yaml', [
      'name: router',
      'subworkflow:',
      '  callable: true',
      '  params:',
      '    target:',
      '      type: workflow_ref',
      'initial_step: route',
      'steps:',
      '  - name: route',
      '    kind: workflow_call',
      '    call:',
      '      $param: target',
    ].join('\n'));
    for (const leafName of ['leaf-a', 'leaf-b']) {
      writeWorkflow(projectDir, `${leafName}.yaml`, [
        `name: ${leafName}`,
        'subworkflow:',
        '  callable: true',
        'initial_step: finish',
        'steps:',
        '  - name: finish',
        '    persona: reviewer',
        `    instruction: Finish ${leafName}`,
      ].join('\n'));
    }
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('args-root', projectDir);
    if (root === null) {
      throw new Error('Expected args-root workflow');
    }

    const restartPoints = [];
    for (const [rootStep, leaf] of [['left', 'leaf-a'], ['right', 'leaf-b']] as const) {
      restartPoints.push(await selectRestartPath(root, projectDir, [
        `Browse child workflow from: "args-root" > "${rootStep}"`,
        `Browse child workflow from: "args-root" > "${rootStep}" > "router" > "route"`,
        `Restart from: "args-root" > "${rootStep}" > "router" > "route" > "${leaf}" > "finish"`,
      ]));
    }
    expect(restartPoints.map((point) => point.stack[2]?.workflow)).toEqual(['leaf-a', 'leaf-b']);
    for (const restartPoint of restartPoints) {
      expect(() => validateTaskRetryRestartPoint(root, restartPoint, {
        projectCwd: projectDir,
        lookupCwd: projectDir,
      })).not.toThrow();
    }
  });

  it('should persist and strictly revalidate the selected opaque ref for same-named workflow files', async () => {
    const projectDir = createProject();
    writeWorkflow(projectDir, 'identity-root.yaml', [
      'name: identity-root',
      'initial_step: left',
      'max_steps: 5',
      'steps:',
      '  - name: left',
      '    kind: workflow_call',
      '    call: ./left.yaml',
      '  - name: right',
      '    kind: workflow_call',
      '    call: ./right.yaml',
    ].join('\n'));
    for (const fileName of ['left.yaml', 'right.yaml']) {
      writeWorkflow(projectDir, fileName, [
        'name: shared',
        'subworkflow:',
        '  callable: true',
        'initial_step: review',
        'steps:',
        '  - name: review',
        '    persona: reviewer',
        '    instruction: Review',
      ].join('\n'));
    }
    writeFailedTask(projectDir);
    const root = loadWorkflowByIdentifier('identity-root', projectDir);
    if (root === null) {
      throw new Error('Expected identity-root workflow');
    }
    const leftRestartPoint = await selectRestartPath(root, projectDir, [
      'Browse child workflow from: "identity-root" > "left"',
      'Restart from: "identity-root" > "left" > "shared" > "review"',
    ]);
    const rightRestartPoint = await selectRestartPath(root, projectDir, [
      'Browse child workflow from: "identity-root" > "right"',
      'Restart from: "identity-root" > "right" > "shared" > "review"',
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      undefined,
      undefined,
      'identity-root',
      undefined,
      undefined,
      rightRestartPoint,
    );
    const persisted = runner.listPendingTaskItems()[0]?.data?.restart_point;
    if (persisted === undefined) {
      throw new Error('Expected persisted restart point');
    }

    validateTaskRetryRestartPoint(root, persisted, { projectCwd: projectDir, lookupCwd: projectDir });
    const wrongRefPoint: WorkflowRestartPoint = {
      stack: [
        ...persisted.stack.slice(0, 1),
        {
          ...persisted.stack[1]!,
          workflow_ref: leftRestartPoint.stack[1]!.workflow_ref,
        },
      ],
    };
    expect(() => validateTaskRetryRestartPoint(root, wrongRefPoint, {
      projectCwd: projectDir,
      lookupCwd: projectDir,
    })).toThrow();
  });

  it('should reject a changed grandchild workflow_ref in the complete restart path', () => {
    const projectDir = createProject();
    writeRestartExecutionWorkflows(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected restart root workflow');
    }
    const restartPoint = buildExecutionRestartPoint(projectDir);
    const changedGrandchild: WorkflowRestartPoint = {
      stack: [
        ...restartPoint.stack.slice(0, -1),
        { ...restartPoint.stack.at(-1)!, workflow_ref: 'project:changed-grandchild' },
      ],
    };

    expect(() => validateTaskRetryRestartPoint(root, changedGrandchild, {
      projectCwd: projectDir,
      lookupCwd: projectDir,
    })).toThrow();
  });

  it('should consume a root agent restart before executing a later normal workflow_call', async () => {
    const projectDir = createProject();
    writeRootRestartLifecycleWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected root restart workflow');
    }
    const restartPoint: WorkflowRestartPoint = {
      stack: [buildWorkflowRestartPointEntry(root, 'selected', 'agent')],
    };
    const mockCallLog = path.join(projectDir, 'root-agent-mock-calls.ndjson');
    process.env.TAKT_MOCK_CALL_LOG = mockCallLog;
    setMockScenario([
      { persona: 'selected-persona', status: 'done', content: 'selected complete' },
      { persona: 'child-first-persona', status: 'done', content: 'child complete' },
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart root agent',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const running = runner.claimNextTasks(1)[0];
    if (running === undefined) {
      throw new Error('Expected root-agent restart task');
    }

    const success = await executeAndCompleteTask(
      running,
      runner,
      projectDir,
      { provider: 'mock' },
      { outputMode: 'silent' },
    );

    expect(success).toBe(true);
    expect(readStartedMockPersonas(mockCallLog)).toEqual([
      'selected-persona',
      'child-first-persona',
    ]);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  it('should enter the child initial step from a terminal root workflow_call restart', async () => {
    const projectDir = createProject();
    writeRootRestartLifecycleWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const root = loadWorkflowByIdentifier('default', projectDir);
    if (root === null) {
      throw new Error('Expected root restart workflow');
    }
    const rootEntry = buildWorkflowRestartPointEntry(root, 'delegate', 'workflow_call', 1);
    const restartPoint: WorkflowRestartPoint = {
      stack: [rootEntry],
    };
    const mockCallLog = path.join(projectDir, 'root-call-mock-calls.ndjson');
    process.env.TAKT_MOCK_CALL_LOG = mockCallLog;
    setMockScenario([
      { persona: 'child-first-persona', status: 'done', content: 'child complete' },
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart root call',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const running = runner.claimNextTasks(1)[0];
    if (running === undefined) {
      throw new Error('Expected root-call restart task');
    }

    const success = await executeAndCompleteTask(
      running,
      runner,
      projectDir,
      { provider: 'mock' },
      { outputMode: 'silent' },
    );

    expect(success).toBe(true);
    expect(readStartedMockPersonas(mockCallLog)).toEqual(['child-first-persona']);
    expect(getScenarioQueue()?.remaining).toBe(0);
  });

  it('should execute a persisted grandchild restart through real nested engines and continue normal calls', async () => {
    const projectDir = createProject();
    writeRestartExecutionWorkflows(projectDir);
    writeFailedTask(projectDir);
    invalidateAllResolvedConfigCache();
    const restartPoint = buildExecutionRestartPoint(projectDir);
    const mockCallLog = path.join(projectDir, 'mock-calls.ndjson');
    process.env.TAKT_MOCK_CALL_LOG = mockCallLog;
    setMockScenario([
      { persona: 'target-persona', status: 'done', content: 'target complete' },
      { persona: 'grand-normal-persona', status: 'done', content: 'grandchild normal call complete' },
      { persona: 'child-normal-persona', status: 'done', content: 'child normal call complete' },
      { persona: 'root-normal-persona', status: 'done', content: 'root normal call complete' },
    ]);
    const runner = new TaskRunner(projectDir);
    runner.requeueTask(
      'nested-retry',
      ['failed'],
      undefined,
      'restart selected grandchild target',
      undefined,
      undefined,
      undefined,
      undefined,
      restartPoint,
    );
    const persistedYaml = parseYaml(
      fs.readFileSync(path.join(projectDir, '.takt', 'tasks.yaml'), 'utf-8'),
    ) as { tasks: Array<Record<string, unknown>> };
    const running = runner.claimNextTasks(1)[0];
    if (running === undefined) {
      throw new Error('Expected requeued task to be claimable');
    }

    const success = await executeAndCompleteTask(
      running,
      runner,
      projectDir,
      { provider: 'mock' },
      { outputMode: 'silent' },
    );
    const completed = runner.listAllTaskItems().find((task) => task.name === 'nested-retry');
    const runMeta = completed?.runSlug === null || completed?.runSlug === undefined
      ? null
      : readRunMetaBySlug(projectDir, completed.runSlug);

    expect(success).toBe(true);
    expect(persistedYaml.tasks[0]?.restart_point).toEqual(restartPoint);
    expect(persistedYaml.tasks[0]?.start_step).toBeUndefined();
    expect(persistedYaml.tasks[0]?.resume_point).toBeUndefined();
    expect(persistedYaml.tasks[0]?.exceeded_current_iteration).toBeUndefined();
    expect(persistedYaml.tasks[0]?.exceeded_max_steps).toBeUndefined();
    expect(readStartedMockPersonas(mockCallLog)).toEqual([
      'target-persona',
      'grand-normal-persona',
      'child-normal-persona',
      'root-normal-persona',
    ]);
    expect(getScenarioQueue()?.remaining).toBe(0);
    expect(runMeta?.resumePoint?.iteration).toBe(4);
    expect(runMeta?.resumePoint?.iteration).not.toBe(23);
  });
});
