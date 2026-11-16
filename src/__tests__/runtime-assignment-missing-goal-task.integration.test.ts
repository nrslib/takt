import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { TaskRunner } from '../infra/task/index.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { GoalStore } from '../infra/goals/store.js';

const save = vi.hoisted(() => vi.fn());
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: save }));

import { claimTasksWithGoalCompletions } from '../features/tasks/execute/claimTasks.js';
import { checkPendingTaskProviders } from '../features/tasks/execute/providerPreflight.js';
import { runAllTasks } from '../features/tasks/index.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';

const VANISHED = 'vanished';
const EXPECTED = `Cannot select runtime assignment "${VANISHED}"`;

function writeRuntime(projectDir: string): void {
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'runtime.yaml'), stringifyYaml({
    version: 1,
    companion: { enabled: false },
    provider: {
      defaults: { profile: 'base' },
      profiles: { base: { provider: 'mock', model: 'base-model' } },
      targets: { internal_agents: { selector: { profile: 'base' } } },
      assignments: { keep: { defaults: { profile: 'base' } } },
    },
  }));
}

function writeWorkflow(projectDir: string): void {
  mkdirSync(join(projectDir, '.takt', 'workflows', 'personas'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'workflows', 'preflight-it.yaml'), [
    'name: preflight-it',
    'description: preflight integration fixture',
    'max_steps: 1',
    'initial_step: plan',
    'steps:',
    '  - name: plan',
    '    persona: ./personas/planner.md',
    '    instruction: "{task}"',
    '    rules:',
    '      - condition: when(true)',
    '        next: COMPLETE',
  ].join('\n'));
  writeFileSync(join(projectDir, '.takt', 'workflows', 'personas', 'planner.md'), 'You are planner.');
}

function writeConfig(projectDir: string, globalDir: string): void {
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: en\n');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, 'config.yaml'), 'language: en\n');
}

describe('IT: runtime assignment removed from runtime.yaml', () => {
  let root: string;
  let projectDir: string;
  let globalDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'takt-missing-assignment-'));
    projectDir = join(root, 'project');
    globalDir = join(root, 'global');
    mkdirSync(projectDir, { recursive: true });
    writeRuntime(projectDir);
    writeWorkflow(projectDir);
    writeConfig(projectDir, globalDir);
    originalConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    save.mockReset();
    await new GoalStore(projectDir).create(goalRecord());
  });

  afterEach(async () => {
    const { prepareRuntimeAssignmentInvocation } = await import('../infra/config/runtime-provider/invocation.js');
    prepareRuntimeAssignmentInvocation(projectDir, undefined);
    if (originalConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = originalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  function addTask(runner: TaskRunner, content: string, options: Record<string, unknown>): string {
    return runner.addTask(content, {
      workflow: 'preflight-it',
      ...options,
    } as never).name;
  }

  it('keeps running preflight for a goal task whose assignment is gone', async () => {
    const runner = new TaskRunner(projectDir);
    addTask(runner, 'goal task', { goal_id: goalId, runtime_assignment: VANISHED });
    await expect(
      checkPendingTaskProviders(runner, projectDir, {}, undefined, []),
    ).resolves.toBeUndefined();
  });

  it('stops preflight for a task without a goal whose assignment is gone', async () => {
    const runner = new TaskRunner(projectDir);
    addTask(runner, 'ordinary task', { runtime_assignment: VANISHED });
    await expect(
      checkPendingTaskProviders(runner, projectDir, {}, undefined, []),
    ).rejects.toThrow(EXPECTED);
  });

  it('marks only the goal task failed at the claim boundary and publishes one completion', () => {
    const warnings: string[] = [];
    const runner = new TaskRunner(projectDir, { onWarning: (warning) => warnings.push(warning) });
    const goalTask = addTask(runner, 'goal task', { goal_id: goalId, runtime_assignment: VANISHED });
    addTask(runner, 'unrelated pending', { workflow: 'preflight-it' });

    const signal = new AbortController().signal;
    const { tasks } = claimTasksWithGoalCompletions(runner, 1, projectDir, signal);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(goalTask);
    expect(warnings[0]).toContain(EXPECTED);

    const states = runner.listTaskStateItems();
    const failed = states.find((task) => task.name === goalTask);
    expect(tasks.map((task) => task.name)).not.toContain(goalTask);
    expect(failed).toMatchObject({
      status: 'failed',
      runSlug: expect.stringMatching(/^setup-/),
      completion: expect.objectContaining({ success: false, interrupted: false }),
    });
    expect(failed?.goalId).toBe(goalId);
    const saved = runner.listAllTaskItems().find((task) => task.name === goalTask);
    expect(saved?.failure?.error).toContain(EXPECTED);
    expect(states.find((task) => task.name !== goalTask)?.status).not.toBe('failed');
    expect(save).toHaveBeenCalledExactlyOnceWith(projectDir, expect.objectContaining({
      kind: 'completion', goalId, taskName: goalTask,
      result: expect.objectContaining({ success: false, interrupted: false, workflowResult: 'error' }),
    }));
  });

  it('leaves a task without a goal claimed unchanged at the claim boundary', () => {
    const runner = new TaskRunner(projectDir);
    const task = addTask(runner, 'ordinary task', { runtime_assignment: VANISHED });

    const { tasks } = claimTasksWithGoalCompletions(runner, 1, projectDir, new AbortController().signal);

    expect(tasks.map((info) => info.name)).toEqual([task]);
    const state = runner.listTaskStateItems().find((item) => item.name === task);
    expect(state?.status).toBe('running');
    expect(state?.status).toBe('running');
    expect(state?.runSlug ?? '').not.toMatch(/^setup-/u);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not judge a task whose assignment name is supplied by the invocation', async () => {
    const runner = new TaskRunner(projectDir);
    addTask(runner, 'goal task', { goal_id: goalId, runtime_assignment: VANISHED });

    const { initializeRuntimeAssignmentInvocation } = await import('../infra/config/runtime-provider/invocation.js');
    initializeRuntimeAssignmentInvocation(projectDir, 'keep');

    await expect(
      checkPendingTaskProviders(runner, projectDir, {}, undefined, []),
    ).resolves.toBeUndefined();
  });

  it('continues the run-all entry for a goal task whose assignment is gone', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'TAKT test'], { cwd: projectDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'takt-test@example.test'], { cwd: projectDir, stdio: 'pipe' });
    const runner = new TaskRunner(projectDir);
    const goalTask = addTask(runner, 'goal task', { goal_id: goalId, runtime_assignment: VANISHED });

    await expect(runAllTasks(projectDir)).resolves.toBeUndefined();

    const goal = runner.listTaskStateItems().find((task) => task.name === goalTask);
    expect(goal).toMatchObject({ status: 'failed', runSlug: expect.stringMatching(/^setup-/) });
    const saved = runner.listAllTaskItems().find((task) => task.name === goalTask);
    expect(saved?.failure?.error).toContain(EXPECTED);
  });
});
