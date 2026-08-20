import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import { restoreStdin, setupRawStdin, toRawInputs } from './helpers/stdinSimulator.js';
import {
  invalidateGlobalConfigCache,
  loadWorkflowByIdentifier,
} from '../infra/config/index.js';
import { TaskRunner } from '../infra/task/index.js';

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: vi.fn(async () => true),
  selectOption: vi.fn(async (_message: string, options: Array<{ value: string }>) => options[0]?.value ?? null),
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

describe('IT: failed retry order revision re-execution terminal worktree', () => {
  let environment: ReturnType<typeof createProject>;

  beforeEach(() => {
    environment = createProject();
    invalidateGlobalConfigCache();
    resetScenario();
  });

  afterEach(() => {
    restoreStdin();
    resetScenario();
    invalidateGlobalConfigCache();
    if (environment && existsSync(environment.root)) {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  it('failed Retryの/go→Yes後に新run reportを同じworktreeへ保存する', async () => {
    expect(loadWorkflowByIdentifier('failed-retry-it', environment.projectDir)).not.toBeNull();
    const runner = new TaskRunner(environment.projectDir);
    runner.addTask('failed retry terminal task', {
      workflow: 'failed-retry-it',
      worktree: true,
      branch: 'takt/failed-task',
      worktree_path: environment.worktreePath,
    });
    const claimed = runner.claimNextTasks(1)[0]!;
    const failedRunSlug = 'failed-run';
    const running = runner.updateRunningTaskExecution(claimed.name, {
      runSlug: failedRunSlug,
      worktreePath: environment.worktreePath,
      branch: 'takt/failed-task',
    });
    runner.failTask({
      task: running,
      success: false,
      response: 'initial provider failure',
      executionLog: ['initial provider failure'],
      failureStep: 'fix',
      startedAt: '2026-08-15T00:00:00.000Z',
      completedAt: '2026-08-15T00:01:00.000Z',
    });

    const sourceRunDir = join(environment.worktreePath, '.takt', 'runs', failedRunSlug);
    mkdirSync(join(sourceRunDir, 'logs'), { recursive: true });
    mkdirSync(join(sourceRunDir, 'reports'), { recursive: true });
    mkdirSync(join(sourceRunDir, 'context'), { recursive: true });
    writeFileSync(join(sourceRunDir, 'meta.json'), JSON.stringify({
      task: 'failed retry terminal task',
      workflow: 'failed-retry-it',
      status: 'failed',
      runSlug: failedRunSlug,
      runRoot: `.takt/runs/${failedRunSlug}`,
      reportDirectory: `.takt/runs/${failedRunSlug}/reports`,
      contextDirectory: `.takt/runs/${failedRunSlug}/context`,
      logsDirectory: `.takt/runs/${failedRunSlug}/logs`,
      startTime: '2026-08-15T00:00:00.000Z',
      endTime: '2026-08-15T00:01:00.000Z',
    }), 'utf-8');

    setupRawStdin(toRawInputs(['apply the repair', '/go']));
    setMockScenario([
      { persona: 'retry', content: 'I will apply the repair.' },
      { persona: 'retry', content: 'Apply the proposed repair.' },
      { persona: 'fixer', status: 'done', content: '[FIX:1]\nre-execution complete' },
    ]);
    const failedTask = runner.listAllTaskItems()[0]!;
    const success = await retryFailedTask(failedTask, environment.projectDir);

    const finalTask = runner.listAllTaskItems()[0]!;
    expect(success).toBe(true);
    expect(finalTask.kind).toBe('completed');
    expect(finalTask.worktreePath).toBe(environment.worktreePath);
    expect(finalTask.runSlug).toBeDefined();
    expect(finalTask.runSlug).not.toBe(failedRunSlug);

    const reportDir = join(environment.worktreePath, '.takt', 'runs', finalTask.runSlug!, 'reports');
    expect(existsSync(reportDir)).toBe(true);
    expect(readdirSync(reportDir, { recursive: true }).length).toBeGreaterThan(0);
  });
});
