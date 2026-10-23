import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import { instructBranch } from '../features/tasks/list/taskInstructionActions.js';
import { createMockProvider, restoreStdin, setupRawStdin, toRawInputs } from './helpers/stdinSimulator.js';
import { confirmWithCancel, selectOption } from '../shared/prompt/index.js';
import {
  invalidateGlobalConfigCache,
  invalidateAllResolvedConfigCache,
  loadWorkflowByIdentifier,
} from '../infra/config/index.js';
import { TaskRunner } from '../infra/task/index.js';
import {
  buildFailedTaskRetryStartContext,
  prepareFailedTaskRetry,
  resolveFailedTaskRetryStart,
} from '../features/tasks/taskRetryPreparation.js';
import { runAssistantRetryCommand } from '../features/interactive/assistantRetryCommand.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';
import type { InstructModeOptions } from '../features/tasks/list/instructMode.js';
import { buildTaskRetryStartOptions } from '../features/tasks/list/taskRetryStartSelection.js';
import { buildWorkflowResumePointEntry } from '../core/workflow/workflow-reference.js';
import type { WorkflowResumePoint } from '../core/models/index.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';

const { mockHasInteractiveTerminal, mockUseTty, mockRunInstructMode } = vi.hoisted(() => ({
  mockHasInteractiveTerminal: vi.fn(() => false),
  mockUseTty: vi.fn(() => false),
  mockRunInstructMode: vi.fn(async (_options: InstructModeOptions) => ({
    action: 'save_task', task: 'Apply the proposed repair.', source: 'go',
  })),
}));

vi.mock('../features/tasks/list/instructMode.js', () => ({ runInstructMode: mockRunInstructMode }));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: vi.fn(async () => false),
  confirmWithCancel: vi.fn(async () => ({ kind: 'value', value: true })),
  selectOption: vi.fn(async (_message: string, options: Array<{ value: string }>) => options[0]?.value ?? null),
  selectOptionWithDefault: vi.fn(async (
    _message: string,
    options: Array<{ value: string }>,
    defaultValue: string,
  ) => options.some((option) => option.value === defaultValue)
    ? defaultValue
    : options[0]?.value ?? null),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  hasInteractiveTerminal: () => mockHasInteractiveTerminal(),
}));

vi.mock('../shared/prompt/tty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/tty.js')>()),
  resolveTtyPolicy: () => ({ useTty: mockUseTty(), forceTouchTty: false }),
}));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function configureGit(cwd: string): void {
  git(cwd, ['config', 'user.name', 'TAKT test']);
  git(cwd, ['config', 'user.email', 'takt-test@example.test']);
}

function createProject(): {
  root: string;
  projectDir: string;
  worktreePath: string;
} {
  const root = join(tmpdir(), `takt-failed-retry-${randomUUID()}`);
  const projectDir = join(root, 'project');
  const worktreePath = join(projectDir, '.takt', 'worktrees', 'failed-task');
  const configDir = process.env.TAKT_CONFIG_DIR;
  if (configDir === undefined) {
    throw new Error('TAKT_CONFIG_DIR must be provided by the shared test setup');
  }
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  mkdirSync(join(projectDir, '.takt', 'worktrees'), { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), 'language: en\nprovider: mock\n', 'utf-8');
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\n', 'utf-8');
  mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), [
    '.takt/*',
    '!.takt/config.yaml',
    '!.takt/workflows/',
    '!.takt/workflows/**',
  ].join('\n') + '\n', 'utf-8');
  writeFileSync(join(projectDir, '.takt', 'workflows', 'failed-retry-it.yaml'), [
    'name: failed-retry-it',
    'initial_step: fix',
    'max_steps: 2',
    'steps:',
    '  - name: fix',
    '    persona: ./personas/fixer.md',
    '    instruction: "{task}"',
    '    output_contracts:',
    '      report:',
    '        - name: final.md',
    '          format: "# Final report"',
    '    rules:',
    '      - condition: when(true)',
    '        next: COMPLETE',
  ].join('\n'), 'utf-8');
  writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'fixer.md'), 'You are a fixer.', 'utf-8');

  git(projectDir, ['init']);
  configureGit(projectDir);
  git(projectDir, ['checkout', '-b', 'main']);
  git(projectDir, ['add', '.gitignore', '.takt']);
  git(projectDir, ['commit', '-m', 'workflow fixture']);
  git(projectDir, ['clone', projectDir, worktreePath]);
  configureGit(worktreePath);
  git(worktreePath, ['checkout', '-b', 'takt/failed-task', 'main']);

  return { root, projectDir, worktreePath };
}

function writeSourceRun(
  worktreePath: string,
  taskName: string,
  workflow: string,
  runSlug: string,
  resumePoint?: WorkflowResumePoint,
): void {
  const sourceRunDir = join(worktreePath, '.takt', 'runs', runSlug);
  mkdirSync(join(sourceRunDir, 'logs'), { recursive: true });
  mkdirSync(join(sourceRunDir, 'reports'), { recursive: true });
  mkdirSync(join(sourceRunDir, 'context'), { recursive: true });
  writeFileSync(join(sourceRunDir, 'meta.json'), JSON.stringify({
    task: taskName,
    workflow,
    status: 'failed',
    runSlug,
    runRoot: `.takt/runs/${runSlug}`,
    reportDirectory: `.takt/runs/${runSlug}/reports`,
    contextDirectory: `.takt/runs/${runSlug}/context`,
    logsDirectory: `.takt/runs/${runSlug}/logs`,
    startTime: '2026-08-15T00:00:00.000Z',
    endTime: '2026-08-15T00:01:00.000Z',
    ...(resumePoint === undefined ? {} : { resume_point: resumePoint }),
  }), 'utf-8');
}

function addFailedTask(
  projectDir: string,
  worktreePath: string,
  taskName: string,
  taskDirRelative: string,
  runSlug: string,
  orderContent: string,
  resumePoint?: WorkflowResumePoint,
): { runner: TaskRunner; task: ReturnType<TaskRunner['listAllTaskItems']>[number] } {
  const runner = new TaskRunner(projectDir);
  mkdirSync(join(projectDir, taskDirRelative), { recursive: true });
  writeFileSync(join(projectDir, taskDirRelative, 'order.md'), orderContent, 'utf-8');
  runner.addTask(taskName, {
    task_dir: taskDirRelative,
    workflow: 'failed-retry-it',
    worktree: true,
    branch: 'takt/failed-task',
    worktree_path: worktreePath,
  });
  const claimed = runner.claimNextTasks(1)[0]!;
  const running = runner.updateRunningTaskExecution(claimed.name, {
    runSlug,
    worktreePath,
    branch: 'takt/failed-task',
  });
  runner.failTask({
    task: running,
    success: false,
    response: 'initial provider failure',
    executionLog: ['initial provider failure'],
    failureStep: resumePoint === undefined ? 'fix' : resumePoint.stack[0]!.step,
    startedAt: '2026-08-15T00:00:00.000Z',
    completedAt: '2026-08-15T00:01:00.000Z',
  });

  writeSourceRun(worktreePath, taskName, 'failed-retry-it', runSlug, resumePoint);

  return { runner, task: runner.listAllTaskItems()[0]! };
}

describe('IT: failed retry order revision queueing in terminal worktree', () => {
  let environment: ReturnType<typeof createProject>;

  beforeEach(() => {
    environment = createProject();
    invalidateGlobalConfigCache();
    resetScenario();
    vi.mocked(confirmWithCancel).mockClear();
    vi.mocked(selectOption).mockReset().mockImplementation(async (_message, choices) => choices[0]?.value ?? null);
    mockHasInteractiveTerminal.mockReturnValue(false);
    mockUseTty.mockImplementation(() => process.stdin.isTTY === true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreStdin();
    resetScenario();
    invalidateGlobalConfigCache();
    if (environment && existsSync(environment.root)) {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  describe.each(['retry', 'requeue'] as const)('assistant /%s nested selection recovery', (command) => {
    it.each([
      { mode: 'correction', onHeading: true, position: 'leaf' },
      { mode: 'correction', onHeading: false, position: 'leaf' },
      { mode: 'manual', onHeading: true, position: 'leaf' },
      { mode: 'correction', onHeading: true, position: 'call' },
      { mode: 'correction', onHeading: false, position: 'call' },
      { mode: 'correction', onHeading: true, position: 'renamed leaf' },
      { mode: 'correction', onHeading: false, position: 'renamed leaf' },
    ])('persists and executes the agreed nested final-gate after $mode with $position and heading description=$onHeading', async ({ mode, onHeading, position }) => {
      const rootYaml = [
        'name: failed-retry-it', 'initial_step: fix', 'max_steps: 10', 'steps:',
        '  - name: fix', '    persona: ./personas/fixer.md', '    instruction: Fix',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: final-gate', '    persona: ./personas/root-gate.md', '    instruction: Root gate',
        ...(!onHeading ? ['    description: 最終確認'] : []),
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: develop', '    kind: workflow_call', '    call: development-core',
        '    description: 再レビュー',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n');
      const coreYaml = [
        'name: development-core', 'subworkflow:', '  callable: true', 'initial_step: review', 'steps:',
        '  - name: review', '    persona: ./personas/fixer.md', '    instruction: Review',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: peer-review', '    kind: workflow_call', '    call: review-suite',
        ...(onHeading ? ['    description: 最終確認'] : []),
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
        '  - name: unavailable', '    kind: workflow_call', '    call: missing-workflow',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n');
      const suiteYaml = [
        'name: review-suite', 'subworkflow:', '  callable: true', 'initial_step: review', 'steps:',
        '  - name: review', '    persona: ./personas/fixer.md', '    instruction: Review',
        '    rules:', '      - condition: when(true)', '        next: final-gate',
        '  - name: final-gate', '    persona: ./personas/nested-gate.md', '    instruction: Final gate',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n');
      for (const cwd of [environment.projectDir, environment.worktreePath]) {
        for (const [name, yaml] of [['failed-retry-it', rootYaml], ['development-core', coreYaml], ['review-suite', suiteYaml]]) {
          writeFileSync(join(cwd, `.takt/workflows/${name}.yaml`), yaml!);
        }
        for (const persona of ['root-gate', 'nested-gate']) {
          writeFileSync(join(cwd, `.takt/workflows/personas/${persona}.md`), `You are ${persona}.`);
        }
      }
      invalidateAllResolvedConfigCache();
      const original = '# Canonical repair order';
      const revised = '# Revised repair order';
      const taskDir = '.takt/tasks/nested-recovery';
      const workflows = ['failed-retry-it', 'development-core', 'review-suite'].map((name) => {
        const workflow = loadWorkflowByIdentifier(name, environment.projectDir, { lookupCwd: environment.worktreePath });
        if (workflow === null) throw new Error(`Expected nested workflow: ${name}`);
        return workflow;
      });
      const failedPosition: WorkflowResumePoint = {
        version: 2,
        stack: [
          buildWorkflowResumePointEntry(workflows[0]!, 'develop', 'workflow_call', 1, undefined, 1),
          buildWorkflowResumePointEntry(workflows[1]!, 'peer-review', 'workflow_call', 1, undefined, 1),
          buildWorkflowResumePointEntry(workflows[2]!, 'final-gate', 'agent', 1),
        ],
        iteration: 3, elapsed_ms: 1000, workflow_call_invocations: {}, workflow_step_participations: {},
      };
      if (position === 'call') failedPosition.stack = failedPosition.stack.slice(0, 2);
      const { runner, task } = addFailedTask(environment.projectDir, environment.worktreePath,
        'nested-recovery', taskDir, 'nested-source', original, failedPosition);
      const gateName = position === 'renamed leaf' ? 'final-gate-new' : 'final-gate';
      if (position === 'renamed leaf') {
        for (const cwd of [environment.projectDir, environment.worktreePath]) {
          writeFileSync(join(cwd, '.takt/workflows/review-suite.yaml'), suiteYaml.replaceAll('final-gate', gateName));
        }
        invalidateAllResolvedConfigCache();
      }
      const preparation = prepareFailedTaskRetry(task, environment.projectDir);
      expect(preparation.resumePoint).toEqual(failedPosition);
      const context = buildFailedTaskRetryStartContext(preparation, environment.projectDir, preparation.previousWorkflow!);
      const chosenId = 'restart:2.1.1';
      const expected = resolveFailedTaskRetryStart(context, chosenId);
      const digest = 'Restart nested-recovery at failed-retry-it > develop → development-core > peer-review → review-suite > final-gate.';
      const { provider, capture } = createMockProvider([
        digest,
        '{"startOptionId":"restart:2.1.1","reason":"agreed"}',
        JSON.stringify({ startOptionId: mode === 'correction' ? chosenId : 'restart:999' }),
        ...(command === 'retry' ? [revised] : []),
      ]);
      vi.mocked(selectOption).mockImplementation(async (_message, choices) => {
        expect(runner.listAllTaskItems()[0]?.kind).toBe('failed');
        return choices.find((choice) => choice.value === chosenId)?.value
          ?? choices.find((choice) => choice.value === 'save_task')?.value ?? null;
      });
      mockHasInteractiveTerminal.mockReturnValue(true);
      mockUseTty.mockReturnValue(true);

      const notice = await runAssistantRetryCommand({
        cwd: environment.projectDir, lang: 'en', command, formalSpec: false,
        history: [{ role: 'user', content: 'OLD_UNRELATED_DETAIL' }, { role: 'assistant', content: digest }, { role: 'user', content: 'Yes, that final-gate.' }],
        inlineText: 'Keep the agreed path.',
        sessionContext: { provider: provider as SessionContext['provider'], providerType: 'mock',
          model: undefined, lang: 'en', personaName: 'assistant', sessionId: 'conversation-session' },
      });

      expect(notice).toContain('pending');
      for (const prompt of capture.prompts.slice(1, 3)) {
        const payload = JSON.parse(prompt) as { startOptions: Array<{ id: string; path?: string; headings?: unknown[] }> };
        expect(payload.startOptions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'restart:0', path: '"failed-retry-it" > "fix"' }),
          expect.objectContaining({ id: 'restart:1', path: '"failed-retry-it" > "final-gate"' }),
          expect.objectContaining({ id: 'restart:2.0', path: '"failed-retry-it" > "develop" → "development-core" > "review"' }),
          expect.objectContaining({ id: 'restart:2.1.0', path: '"failed-retry-it" > "develop" → "development-core" > "peer-review" → "review-suite" > "review"' }),
          expect.objectContaining({ id: chosenId, path: `"failed-retry-it" > "develop" → "development-core" > "peer-review" → "review-suite" > "${gateName}"` }),
        ]));
        const expectedHeadings = [
          { path: '"failed-retry-it" > "develop"', description: '再レビュー' },
          { path: '"failed-retry-it" > "develop" → "development-core" > "peer-review"', ...(onHeading ? { description: '最終確認' } : {}) },
        ];
        for (const id of [chosenId, 'resume-checkpoint']) {
          expect(payload.startOptions.find((option) => option.id === id)).toMatchObject({
            path: id === 'resume-checkpoint' && position !== 'leaf'
              ? '"failed-retry-it" > "develop" → "development-core" > "peer-review"'
              : `"failed-retry-it" > "develop" → "development-core" > "peer-review" → "review-suite" > "${gateName}"`,
          });
          expect(payload.startOptions.find((option) => option.id === id)?.headings).toEqual(expectedHeadings);
        }
        expect(payload.startOptions.every((option) => !option.id.startsWith('heading:'))).toBe(true);
        const heading = context.startOptions.options.find((option) => option.id === 'heading:2.2')!;
        expect(heading.description).toBeTruthy();
        expect(prompt).toContain(JSON.stringify(heading.description));
        expect(prompt).toContain(digest);
        expect(prompt).not.toContain('OLD_UNRELATED_DETAIL');
      }
      expect(capture.sessionIds.slice(1, 3)).toEqual([undefined, undefined]);
      expect(capture.callCount).toBe(command === 'retry' ? 4 : 3);
      expect(vi.mocked(selectOption)).toHaveBeenCalledTimes((mode === 'manual' ? 1 : 0) + (command === 'retry' ? 1 : 0));
      const pending = runner.listTasks()[0]!;
      expect(pending.data?.restart_point).toEqual(expected.restartPoint);
      expect(pending.data?.resume_point).toBeUndefined();
      expect(pending.sourceRunSlug).toBe('nested-source');
      expect(readFileSync(join(environment.projectDir, taskDir, 'order.md'), 'utf-8')).toBe(command === 'retry' ? revised : original);
      const saved = parse(readFileSync(join(environment.projectDir, '.takt/tasks.yaml'), 'utf-8')) as { tasks: Array<Record<string, unknown>> };
      expect(saved.tasks[0]).toMatchObject({ status: 'pending', restart_point: expected.restartPoint });
      // Candidate selection retains unresolved-branch diagnostics, while execution
      // requires every workflow call in the bundle to resolve.
      for (const cwd of [environment.projectDir, environment.worktreePath]) {
        writeFileSync(join(cwd, '.takt/workflows/missing-workflow.yaml'), [
          'name: missing-workflow', 'subworkflow:', '  callable: true', 'initial_step: unused', 'steps:',
          '  - name: unused', '    persona: ./personas/fixer.md', '    instruction: Unused branch',
          '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        ].join('\n'));
      }
      invalidateAllResolvedConfigCache();
      const logPath = join(environment.root, 'nested-calls.ndjson');
      vi.stubEnv('TAKT_MOCK_CALL_LOG', logPath);
      setMockScenario([{ persona: 'nested-gate', status: 'done', content: 'Complete.' }]);

      const succeeded = await executeAndCompleteTask(runner.claimNextTasks(1)[0]!, runner, environment.projectDir,
        { provider: 'mock' }, { outputMode: 'silent' });
      expect(succeeded, JSON.stringify(runner.listAllTaskItems().map((item) => item.failure))).toBe(true);

      const starts = readFileSync(logPath, 'utf-8').trim().split('\n')
        .map((line) => JSON.parse(line) as { event: string; personaName: string }).filter((entry) => entry.event === 'start');
      expect(starts.map((entry) => entry.personaName)).toEqual(['nested-gate']);
    });
  });

  it.each(['restart implement', 'continue checkpoint', 'restart review', 'continue saved', 'restart child'] as const)(
    'exceeded inline /requeue persists and executes %s without revising the order', async (mode) => {
      const rootYaml = [
        'name: exceeded-it', 'initial_step: implement', 'max_steps: 10', 'steps:',
        '  - name: implement', '    persona: ./personas/implement.md', '    instruction: Implement',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: review', '    persona: ./personas/review.md', '    instruction: Review',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
        '  - name: delegate', '    kind: workflow_call', '    call: exceeded-child',
        '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      ].join('\n');
      const childYaml = [
        'name: exceeded-child', 'subworkflow:', '  callable: true', 'initial_step: before', 'steps:',
        '  - name: before', '    persona: ./personas/before.md', '    instruction: Before',
        '    rules:', '      - condition: when(true)', '        next: review',
        '  - name: review', '    persona: ./personas/child-review.md', '    instruction: Child review',
        '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n');
      for (const cwd of [environment.projectDir, environment.worktreePath]) {
        writeFileSync(join(cwd, '.takt/workflows/exceeded-it.yaml'), rootYaml);
        writeFileSync(join(cwd, '.takt/workflows/exceeded-child.yaml'), childYaml);
        for (const persona of ['implement', 'review', 'before', 'child-review']) {
          writeFileSync(join(cwd, `.takt/workflows/personas/${persona}.md`), `You are ${persona}.`);
        }
      }
      invalidateAllResolvedConfigCache();
      const workflow = loadWorkflowByIdentifier('exceeded-it', environment.projectDir, { lookupCwd: environment.worktreePath });
      if (!workflow) throw new Error('Expected exceeded workflow');
      const resumePoint: WorkflowResumePoint = {
        version: 2, stack: [buildWorkflowResumePointEntry(workflow, 'review', 'agent', 1)],
        iteration: 3, elapsed_ms: 1000, workflow_call_invocations: {}, workflow_step_participations: {},
      };
      const runner = new TaskRunner(environment.projectDir);
      const taskDir = '.takt/tasks/exceeded-inline';
      const order = '# Canonical order\n\nImplement audit logs.';
      mkdirSync(join(environment.projectDir, taskDir), { recursive: true });
      writeFileSync(join(environment.projectDir, taskDir, 'order.md'), order);
      runner.addTask('exceeded-inline', { task_dir: taskDir, workflow: 'exceeded-it', worktree: true,
        worktree_path: environment.worktreePath, branch: 'takt/failed-task', retry_note: 'Keep this note' });
      const running = runner.claimNextTasks(1)[0]!;
      runner.updateRunningTaskExecution(running.name, { runSlug: 'source-exceeded', worktreePath: environment.worktreePath, branch: 'takt/failed-task' });
      const checkpoint = mode !== 'continue saved';
      writeSourceRun(environment.worktreePath, running.name, 'exceeded-it', 'source-exceeded',
        checkpoint ? resumePoint : undefined);
      runner.exceedTask(running.name, { currentStep: 'review', currentIteration: 3, newMaxSteps: 5,
        ...(checkpoint ? { resumePoint } : {}) });
      const catalog = buildTaskRetryStartOptions(workflow, {
        projectCwd: environment.projectDir, lookupCwd: environment.worktreePath,
        ...(checkpoint ? { resumePoint } : {}),
      });
      const restarting = mode.startsWith('restart');
      const expectedStep = mode === 'restart implement' ? 'implement' : 'review';
      const restartChoices = catalog.options.filter((option) => option.selectable && option.id.startsWith('restart:') && option.label.trim() === JSON.stringify(expectedStep));
      const chosenId = mode === 'continue checkpoint' ? 'resume-checkpoint'
        : mode === 'continue saved' ? 'continue-saved-position'
        : restartChoices[mode === 'restart child' ? 1 : 0]!.id;
      const { provider, capture } = createMockProvider([JSON.stringify({ startOptionId: chosenId })]);
      mockHasInteractiveTerminal.mockReturnValue(true);
      mockUseTty.mockReturnValue(true);
      const notice = await runAssistantRetryCommand({
        cwd: environment.projectDir, lang: 'en', command: 'requeue',
        inlineText: restarting ? `Restart ${mode === 'restart child' ? 'child ' : ''}${expectedStep}.` : 'Continue from saved review.',
        history: [], formalSpec: false,
        sessionContext: { provider: provider as SessionContext['provider'], providerType: 'mock', model: undefined, lang: 'en', personaName: 'assistant', sessionId: undefined },
      });
      expect(notice).toContain('pending');
      expect(vi.mocked(confirmWithCancel)).toHaveBeenCalledWith(expect.stringContaining(expectedStep), false);
      expect(vi.mocked(confirmWithCancel).mock.calls[0]?.[0]).toContain(restarting ? 'Restart:' : mode === 'continue checkpoint' ? 'Continue:' : 'Saved stopping position:');
      if (mode === 'restart child') {
        expect(vi.mocked(confirmWithCancel).mock.calls[0]?.[0]).toContain('exceeded-child');
      }
      const pending = runner.listTasks()[0]!;
      expect(pending.data?.retry_note).toBe('Keep this note');
      expect(pending.worktreePath).toBe(environment.worktreePath);
      expect(pending.data?.branch).toBe('takt/failed-task');
      expect(pending.sourceRunSlug).toBe('source-exceeded');
      expect(pending.data?.workflow).toBe('exceeded-it');
      expect(pending.taskDir).toBe(taskDir);
      expect(pending.data?.resume_point).toEqual(restarting ? undefined : checkpoint ? resumePoint : undefined);
      expect(pending.data?.exceeded_current_iteration).toBe(restarting ? undefined : 3);
      expect(pending.data?.exceeded_max_steps).toBe(restarting ? undefined : 5);
      expect(pending.data?.start_step).toBe(restarting ? undefined : 'review');
      expect(pending.data?.restart_point?.stack.at(-1)?.step).toBe(restarting ? expectedStep : undefined);
      expect(pending.data?.restart_point?.stack.length).toBe(restarting ? mode === 'restart child' ? 2 : 1 : undefined);
      expect(capture.callCount).toBe(1);
      const resolved = await resolveTaskExecution(pending, environment.projectDir, undefined, { outputMode: 'silent' });
      expect(resolved.startStep).toBe(mode === 'restart child' ? 'delegate' : expectedStep);
      expect(resolved.initialIterationOverride).toBe(restarting ? undefined : 3);
      expect(resolved.maxStepsOverride).toBe(restarting ? undefined : 5);
      const logPath = join(environment.root, 'calls.ndjson');
      vi.stubEnv('TAKT_MOCK_CALL_LOG', logPath);
      const expectedPersona = mode === 'restart child' ? 'child-review' : expectedStep;
      setMockScenario([{ persona: expectedPersona, status: 'done', content: 'Complete.' }]);
      expect(await executeAndCompleteTask(runner.claimNextTasks(1)[0]!, runner, environment.projectDir,
        { provider: 'mock' }, { outputMode: 'silent' })).toBe(true);
      const starts = readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; personaName: string }).filter((entry) => entry.event === 'start');
      expect(starts.map((entry) => entry.personaName)).toEqual([expectedPersona]);
      expect(readFileSync(join(environment.projectDir, taskDir, 'order.md'), 'utf-8')).toBe(order);
      expect(readdirSync(join(environment.projectDir, taskDir)).filter((name) => name.startsWith('order.md.'))).toEqual([]);
    },
  );

  it.each([
    ['failed', 'alpha', 'alpha'],
    ['completed', 'alpha', 'alpha'],
    ['pr_failed', 'alpha', 'alpha'],
    ['failed', '\u001b[2Jalpha\r\nforged\u0007\u009b0m', 'alpha\\r\\nforged\\x07\\x9b0m'],
    ['completed', '\u001b[2Jalpha\r\nforged\u0007\u009b0m', 'alpha\\r\\nforged\\x07\\x9b0m'],
    ['pr_failed', '\u001b[2Jalpha\r\nforged\u0007\u009b0m', 'alpha\\r\\nforged\\x07\\x9b0m'],
  ] as const)('queues the saved %s name %j unchanged and prints it safely', async (kind, name, displayName) => {
    const { runner } = addFailedTask(environment.projectDir, environment.worktreePath,
      'stored task', '.takt/tasks/stored-task', 'source-run', '# Original order');
    const tasksPath = join(environment.projectDir, '.takt', 'tasks.yaml');
    const saved = parse(readFileSync(tasksPath, 'utf-8')) as { tasks: Array<Record<string, unknown>> };
    saved.tasks[0]!.name = name;
    saved.tasks[0]!.status = kind;
    if (kind === 'completed') delete saved.tasks[0]!.failure;
    writeFileSync(tasksPath, stringify(saved));
    const task = runner.listAllTaskItems()[0]!;
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(selectOption).mockImplementation(async (_message, options) =>
      options.find((option) => option.value === 'save_task')?.value ?? options[0]?.value ?? null);
    setupRawStdin(toRawInputs(['revise the order', '/go']));
    setMockScenario([
      { persona: kind === 'failed' ? 'retry' : 'instruct', status: 'done', content: 'I will revise the order.' },
      { persona: kind === 'failed' ? 'retry' : 'instruct', status: 'done', content: 'Apply the proposed repair.' },
    ]);
    try {
      expect(await (kind === 'failed' ? retryFailedTask(task, environment.projectDir)
        : instructBranch(environment.projectDir, task))).toBe(true);
      const finalTask = runner.listAllTaskItems()[0]!;
      expect(finalTask).toMatchObject({ kind: 'pending', name });
      if (kind !== 'failed') expect(mockRunInstructMode).toHaveBeenLastCalledWith(expect.objectContaining({ taskName: name }));
      expect(readFileSync(join(environment.projectDir, finalTask.taskDir!, 'order.md'), 'utf-8')).toBe('Apply the proposed repair.');
      const lines = consoleLog.mock.calls.flat().map(String);
      expect(lines.find((line) => line.includes('has been requeued'))).toContain(displayName);
      const output = lines.join('\n');
      expect(output).not.toContain('\u001b[2J');
      expect(output).not.toContain('\r\nforged');
      expect(output).not.toContain('\u0007');
      expect(output).not.toContain('\u009b');
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('failed Retryの/go→タスクにつむ後に更新orderを保存してpendingにする', async () => {
    expect(loadWorkflowByIdentifier('failed-retry-it', environment.projectDir)).not.toBeNull();
    const taskDirRelative = '.takt/tasks/failed-retry-terminal-task';
    const originalOrder = '# Original task order';
    const failedRunSlug = 'failed-run';
    const { runner } = addFailedTask(
      environment.projectDir,
      environment.worktreePath,
      'failed retry terminal task',
      taskDirRelative,
      failedRunSlug,
      originalOrder,
    );

    setupRawStdin(toRawInputs(['apply the repair', '/go']));
    setMockScenario([
      { persona: 'retry', status: 'done', content: 'I will apply the repair.' },
      { persona: 'retry', status: 'done', content: 'Apply the proposed repair.' },
    ]);
    const failedTask = runner.listAllTaskItems()[0]!;
    const success = await retryFailedTask(failedTask, environment.projectDir);

    const finalTask = runner.listAllTaskItems()[0]!;
    expect(success).toBe(true);
    expect(finalTask.kind).toBe('pending');
    expect(finalTask.taskDir).toBeDefined();
    const taskDirectory = join(environment.projectDir, finalTask.taskDir!);
    expect(readFileSync(join(taskDirectory, 'order.md'), 'utf-8')).toBe('Apply the proposed repair.');
    const archivedOrders = readdirSync(taskDirectory).filter((entry) => entry.startsWith('order.md.'));
    expect(archivedOrders).toHaveLength(1);
    expect(readFileSync(join(taskDirectory, archivedOrders[0]!), 'utf-8')).toBe(originalOrder);
    expect(finalTask.worktreePath).toBe(environment.worktreePath);
    expect(finalTask.runSlug).toBeUndefined();
    expect(finalTask.sourceRunSlug).toBe(failedRunSlug);

    const runDirectory = join(environment.worktreePath, '.takt', 'runs');
    expect(readdirSync(runDirectory)).toEqual([failedRunSlug]);
  });

  it('assistant /retry saves the displayed order, archives the canonical order, and queues the chosen start', async () => {
    const taskDirRelative = '.takt/tasks/assistant-retry-terminal-task';
    const originalOrder = '# Assistant original order';
    const revisedOrder = '# Assistant revised order\n\nApply the parser repair.';
    const runSlug = 'assistant-failed-run';
    const { runner, task } = addFailedTask(
      environment.projectDir,
      environment.worktreePath,
      'assistant retry terminal task',
      taskDirRelative,
      runSlug,
      originalOrder,
    );
    const preparation = prepareFailedTaskRetry(task, environment.projectDir);
    const startContext = buildFailedTaskRetryStartContext(
      preparation,
      environment.projectDir,
      preparation.previousWorkflow!,
    );
    const startOption = startContext.startOptions.options.find((option) => option.selectable);
    expect(startOption).toBeDefined();
    const expectedStart = resolveFailedTaskRetryStart(startContext, startOption!.id);
    const { provider, capture } = createMockProvider([
      'Apply the parser repair from the selected failed position.',
      JSON.stringify({ startOptionId: startOption!.id }),
      revisedOrder,
    ]);
    setupRawStdin(toRawInputs([]));
    mockHasInteractiveTerminal.mockReturnValue(true);
    mockUseTty.mockReturnValue(true);

    const notice = await runAssistantRetryCommand({
      cwd: environment.projectDir,
      lang: 'en',
      command: 'retry',
      inlineText: 'Apply the repair described in this conversation.',
      history: [{ role: 'user', content: 'The parser repair is ready.' }],
      sessionContext: {
        provider: provider as SessionContext['provider'],
        providerType: 'mock',
        model: undefined,
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
      formalSpec: false,
    });

    const finalTask = runner.listAllTaskItems()[0]!;
    const taskDirectory = join(environment.projectDir, finalTask.taskDir!);
    const archivedOrders = readdirSync(taskDirectory).filter((entry) => entry.startsWith('order.md.'));
    expect(notice).toContain('pending');
    expect(finalTask.kind).toBe('pending');
    expect(readFileSync(join(taskDirectory, 'order.md'), 'utf-8')).toBe(revisedOrder);
    expect(archivedOrders).toHaveLength(1);
    expect(readFileSync(join(taskDirectory, archivedOrders[0]!), 'utf-8')).toBe(originalOrder);
    expect(finalTask.data?.start_step).toBe(expectedStart.startStep);
    expect(finalTask.data?.resume_point).toEqual(expectedStart.resumePoint);
    expect(finalTask.data?.restart_point).toEqual(expectedStart.restartPoint);
    expect(finalTask.sourceRunSlug).toBe(runSlug);
    expect(capture.callCount).toBe(3);
    expect(capture.prompts[2]).toContain(originalOrder);
    expect(capture.prompts[2]).toContain('Apply the repair described in this conversation.');
    expect(capture.allowedTools).toEqual([[], [], []]);
    expect(capture.sessionIds).toEqual([undefined, undefined, undefined]);
    expect(readdirSync(join(environment.worktreePath, '.takt', 'runs'))).toEqual([runSlug]);
  });

  it('assistant /requeue returns a failed task to pending without changing its order', async () => {
    const taskDirRelative = '.takt/tasks/assistant-requeue-terminal-task';
    const originalOrder = '# Assistant requeue order';
    const runSlug = 'assistant-requeue-failed-run';
    const { runner, task } = addFailedTask(
      environment.projectDir,
      environment.worktreePath,
      'assistant requeue terminal task',
      taskDirRelative,
      runSlug,
      originalOrder,
    );
    const preparation = prepareFailedTaskRetry(task, environment.projectDir);
    const startContext = buildFailedTaskRetryStartContext(
      preparation,
      environment.projectDir,
      preparation.previousWorkflow!,
    );
    const startOption = startContext.startOptions.options.find((option) => option.selectable);
    expect(startOption).toBeDefined();
    const expectedStart = resolveFailedTaskRetryStart(startContext, startOption!.id);
    const { provider, capture } = createMockProvider([
      'Resume the failed task from the agreed position.',
      JSON.stringify({ startOptionId: startOption!.id }),
    ]);
    setupRawStdin(toRawInputs([]));
    mockHasInteractiveTerminal.mockReturnValue(true);
    mockUseTty.mockReturnValue(true);

    const notice = await runAssistantRetryCommand({
      cwd: environment.projectDir,
      lang: 'en',
      command: 'requeue',
      inlineText: 'Resume from the failed position.',
      history: [{ role: 'user', content: 'The repair is ready to retry.' }],
      sessionContext: {
        provider: provider as SessionContext['provider'],
        providerType: 'mock',
        model: undefined,
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
      formalSpec: false,
    });

    const finalTask = runner.listAllTaskItems()[0]!;
    const taskDirectory = join(environment.projectDir, taskDirRelative);
    expect(notice).toContain('pending');
    expect(finalTask.kind).toBe('pending');
    expect(readFileSync(join(taskDirectory, 'order.md'), 'utf-8')).toBe(originalOrder);
    expect(readdirSync(taskDirectory).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(finalTask.data?.start_step).toBe(expectedStart.startStep);
    expect(finalTask.data?.resume_point).toEqual(expectedStart.resumePoint);
    expect(finalTask.data?.restart_point).toEqual(expectedStart.restartPoint);
    expect(finalTask.data?.retry_note).toContain('[Auto-requeue]');
    expect(finalTask.sourceRunSlug).toBe(runSlug);
    expect(capture.callCount).toBe(2);
    expect(vi.mocked(confirmWithCancel)).toHaveBeenCalledWith(expect.stringContaining(expectedStart.label), false);
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
    expect(existsSync(join(environment.worktreePath, '.takt', 'runs', 'new-run'))).toBe(false);
  });

  it('assistant /requeue preserves an exceeded task stopping position without generating a start option', async () => {
    const runner = new TaskRunner(environment.projectDir);
    const taskName = 'assistant requeue exceeded task';
    const taskDirRelative = '.takt/tasks/assistant-requeue-exceeded-task';
    const originalOrder = '# Exceeded task order';
    mkdirSync(join(environment.projectDir, taskDirRelative), { recursive: true });
    writeFileSync(join(environment.projectDir, taskDirRelative, 'order.md'), originalOrder, 'utf-8');
    runner.addTask(taskName, {
      task_dir: taskDirRelative,
      workflow: 'failed-retry-it',
      worktree: true,
      branch: 'takt/failed-task',
      worktree_path: environment.worktreePath,
    });
    const claimed = runner.claimNextTasks(1)[0]!;
    runner.updateRunningTaskExecution(claimed.name, {
      runSlug: 'assistant-exceeded-run',
      worktreePath: environment.worktreePath,
      branch: 'takt/failed-task',
    });
    runner.exceedTask(claimed.name, {
      currentStep: 'review',
      newMaxSteps: 5,
      currentIteration: 3,
      worktreePath: environment.worktreePath,
      branch: 'takt/failed-task',
    });
    setupRawStdin(toRawInputs([]));
    mockHasInteractiveTerminal.mockReturnValue(true);
    mockUseTty.mockReturnValue(true);

    const notice = await runAssistantRetryCommand({
      cwd: environment.projectDir,
      lang: 'en',
      command: 'requeue',
      inlineText: '',
      history: [{ role: 'user', content: 'Resume the stopped task.' }],
      sessionContext: {
        provider: {} as SessionContext['provider'],
        providerType: 'mock',
        model: undefined,
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
      formalSpec: false,
    });

    const finalTask = runner.listAllTaskItems()[0]!;
    expect(notice).toContain('pending');
    expect(finalTask.kind).toBe('pending');
    expect(finalTask.data?.start_step).toBe('review');
    expect(finalTask.data?.exceeded_current_iteration).toBe(3);
    expect(finalTask.data?.exceeded_max_steps).toBe(5);
    expect(finalTask.sourceRunSlug).toBe('assistant-exceeded-run');
    expect(readFileSync(join(environment.projectDir, taskDirRelative, 'order.md'), 'utf-8')).toBe(originalOrder);
    expect(vi.mocked(confirmWithCancel)).toHaveBeenCalledWith(expect.stringContaining('review'), false);
    expect(vi.mocked(selectOption)).not.toHaveBeenCalled();
    expect(existsSync(join(environment.worktreePath, '.takt', 'runs', 'assistant-exceeded-run'))).toBe(false);
  });

  it('assistant /retry rolls back the canonical order and archive when task state rejects the requeue', async () => {
    const taskDirRelative = '.takt/tasks/assistant-retry-rollback-task';
    const originalOrder = '# Canonical order before retry';
    const revisedOrder = '# Rejected revised order';
    const runSlug = 'assistant-rollback-run';
    const { runner, task } = addFailedTask(
      environment.projectDir,
      environment.worktreePath,
      'assistant retry rollback task',
      taskDirRelative,
      runSlug,
      originalOrder,
    );
    const preparation = prepareFailedTaskRetry(task, environment.projectDir);
    const startContext = buildFailedTaskRetryStartContext(
      preparation,
      environment.projectDir,
      preparation.previousWorkflow!,
    );
    const startOption = startContext.startOptions.options.find((option) => option.selectable);
    expect(startOption).toBeDefined();
    const { provider } = createMockProvider([
      'Revise the task from the agreed position.',
      JSON.stringify({ startOptionId: startOption!.id }),
      revisedOrder,
    ]);
    const tasksPath = join(environment.projectDir, '.takt', 'tasks.yaml');
    const failedTaskState = readFileSync(tasksPath, 'utf-8');
    vi.mocked(selectOption).mockImplementationOnce(async <T extends string>(
      _message: string,
      choices: Array<{ value: T }>,
    ) => {
      runner.requeueTask(task.name, ['failed'], {});
      return choices[0]?.value ?? null;
    });
    setupRawStdin(toRawInputs([]));
    mockHasInteractiveTerminal.mockReturnValue(true);
    mockUseTty.mockReturnValue(true);

    const notice = await runAssistantRetryCommand({
      cwd: environment.projectDir,
      lang: 'en',
      command: 'retry',
      inlineText: 'Revise the task.',
      history: [{ role: 'user', content: 'The revised task is ready.' }],
      sessionContext: {
        provider: provider as SessionContext['provider'],
        providerType: 'mock',
        model: undefined,
        lang: 'en',
        personaName: 'assistant',
        sessionId: undefined,
      },
      formalSpec: false,
    });

    writeFileSync(tasksPath, failedTaskState, 'utf-8');
    const taskDirectory = join(environment.projectDir, taskDirRelative);
    expect(notice).toContain('could not be prepared');
    expect(readFileSync(join(taskDirectory, 'order.md'), 'utf-8')).toBe(originalOrder);
    expect(readdirSync(taskDirectory).filter((entry) => entry.startsWith('order.md.'))).toHaveLength(0);
    expect(runner.listAllTaskItems()[0]?.kind).toBe('failed');
  });
});
