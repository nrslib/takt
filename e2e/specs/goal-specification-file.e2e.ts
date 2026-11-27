import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_EVENTS_LOG_FILE_SUFFIX } from '../../src/core/logging/contracts.js';
import type { ProviderEventLogRecord } from '../../src/core/logging/providerEvent.js';
import { GoalStore } from '../../src/infra/goals/store.js';
import { prepareTaskSpecDirectory } from '../../src/infra/task/enqueueService.js';
import { TaskRunner } from '../../src/infra/task/runner.js';
import { buildRunPaths } from '../../src/core/workflow/run/run-paths.js';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo.js';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readProviderEvents(logsDir: string): ProviderEventLogRecord[] {
  const files = readdirSync(logsDir).filter((file) => file.endsWith(PROVIDER_EVENTS_LOG_FILE_SUFFIX));
  expect(files, `Provider event log missing in ${logsDir}`).not.toHaveLength(0);
  return files.flatMap((file) => readFileSync(join(logsDir, file), 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProviderEventLogRecord));
}

function toolInputPaths(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.replaceAll('\\', '/').split(/[\s"'`;<>()|&=]+/).map((part) => posix.normalize(part));
  }
  if (Array.isArray(value)) return value.flatMap(toolInputPaths);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(toolInputPaths);
  return [];
}

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Goal specification file', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
  });

  afterEach(() => {
    try {
      repo.cleanup();
    } finally {
      isolatedEnv.cleanup();
    }
  });

  it('should use AC-2 from the saved goal specification to write answer.txt', async () => {
    const answer = randomUUID();
    const startBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repo.path, encoding: 'utf-8',
    }).trim();
    const goalBranch = 'takt/e2e-goal';
    execFileSync('git', ['branch', goalBranch], { cwd: repo.path, stdio: 'pipe' });
    const goal = await new GoalStore(repo.path).create({
      id: randomUUID(),
      objective: 'Satisfy the saved acceptance criteria.',
      outOfScope: [],
      acceptanceCriteria: ['AC-2'],
      constraints: [],
      creationOrigin: 'manager',
      questionRoute: 'human',
      specifications: {
        gherkin: [
          'Feature: Answer file',
          '  Scenario: AC-2',
          '    When the task is completed',
          `    Then the first line of "answer.txt" is exactly "${answer}"`,
          '',
        ].join('\n'),
      },
      mode: 'local',
      status: 'created',
      executionStatus: 'active',
      acceptanceCriteriaVersion: 1,
      workLog: [],
      branch: goalBranch,
      startBranch,
      integrationBranch: startBranch,
    });
    const taskContent = 'Satisfy acceptance criterion AC-2.';
    const prepared = prepareTaskSpecDirectory(repo.path, taskContent);
    const runner = new TaskRunner(repo.path);
    const task = runner.addTask(taskContent, {
      task_dir: prepared.taskDirRelative,
      slug: 'goal-specification-file',
      workflow: resolve(__dirname, '../fixtures/workflows/simple.yaml'),
      goal_id: goal.id,
      goal_purpose: 'Implement AC-2',
      worktree: true,
      base_branch: goal.branch,
      auto_pr: false,
      should_publish_branch_to_origin: false,
    });
    const tasksFile = runner.getTasksFilePath();
    expect(taskContent).not.toContain(answer);
    expect(readFileSync(join(prepared.taskDir, 'order.md'), 'utf-8')).not.toContain(answer);
    expect(readFileSync(tasksFile, 'utf-8')).not.toContain(answer);

    const result = runTakt({
      args: ['run'],
      cwd: repo.path,
      env: { ...isolatedEnv.env, TAKT_LOGGING_PROVIDER_EVENTS: 'true' },
      timeout: 240_000,
    });

    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    const completed = runner.listAllTaskItems().find((item) => item.name === task.name);
    expect(completed, formatTaktRunResult(result)).toEqual(expect.objectContaining({
      kind: 'completed',
      worktreePath: expect.any(String),
      runSlug: expect.any(String),
    }));
    const worktreePath = completed!.worktreePath!;
    expect(worktreePath).not.toBe(repo.path);
    expect(existsSync(join(worktreePath, '.takt', 'goals'))).toBe(false);
    const runPaths = buildRunPaths(worktreePath, completed!.runSlug!);
    const events = readProviderEvents(runPaths.logsAbs);
    const toolCalls = events.filter((event) => event.event_type === 'tool_use');
    expect(toolCalls, `No tool calls recorded in ${runPaths.logsAbs}`).not.toHaveLength(0);
    for (const call of toolCalls) {
      expect(call.data.tool).toEqual(expect.any(String));
      expect(call.data.input).toEqual(expect.any(Object));
      // 明示されたゴール記録のパスも補助的に検査する。
      expect(toolInputPaths(call.data.input).some((path) => /(?:^|\/)\.takt\/goals(?:\/|$)/i.test(path)),
        JSON.stringify(call)).toBe(false);
    }
    // 後から仕様を読んでも、別経路で先に得た値の出所は証明できない。
    const firstValueEventIndex = events.findIndex((event) => JSON.stringify(event.data).includes(answer));
    expect(firstValueEventIndex,
      `No event contained the AC-2 value in ${runPaths.logsAbs}`).toBeGreaterThanOrEqual(0);
    const firstValueEvent = events[firstValueEventIndex]!;
    expect(['tool_output', 'tool_result'],
      `The AC-2 value first appeared outside a tool output or result: ${JSON.stringify(firstValueEvent)}`)
      .toContain(firstValueEvent.event_type);
    const specificationPath = join(runPaths.contextTaskAbs, 'specifications', 'gherkin.feature');
    const specificationCalls = events.slice(0, firstValueEventIndex)
      .filter((event) => event.event_type === 'tool_use'
        && toolInputPaths(event.data.input)
          .some((path) => matchesGlob(specificationPath, resolve(worktreePath, path))));
    expect(specificationCalls.some((call) => typeof call.data.id === 'string'
      && call.data.id === firstValueEvent.data.id),
    `The first tool output or result containing the AC-2 value was not from the specification: ${JSON.stringify(firstValueEvent)}`).toBe(true);
    expect(readFileSync(specificationPath, 'utf-8')).toBe(goal.specifications!.gherkin);
    expect(readFileSync(runPaths.contextTaskOrderAbs, 'utf-8')).not.toContain(answer);
    expect(readFileSync(tasksFile, 'utf-8')).not.toContain(answer);
    expect(readFileSync(join(worktreePath, 'answer.txt'), 'utf-8').split(/\r?\n/)[0]).toBe(answer);
  }, 240_000);
});
