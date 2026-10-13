import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getCloneMetaPath, saveCloneMeta } from '../infra/task/clone-meta.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { prepareFailedTaskRetry, buildFailedTaskRetryStartContext, resolveFailedTaskRetryStart } from '../features/tasks/taskRetryPreparation.js';
import { persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';
import { loadWorkflowByIdentifier } from '../infra/config/index.js';
import { getWorkflowReference } from '../core/workflow/workflow-reference.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { goalId, taskRemovalRecords } from './helpers/goal-fixtures.js';
import { buildGoalTurnContext } from '../features/manager/turnContext.js';
import { answerGoalQuestion } from '../infra/goals/questions.js';
import { encodeWorktreePath } from '../infra/config/project/sessionStore.js';
import { deleteTaskByKind } from '../features/tasks/list/taskDeleteActions.js';
import * as taskActions from '../features/tasks/list/taskActions.js';
import { confirm } from '../shared/prompt/index.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { firstTextContent } from './helpers/mcp-content.js';

vi.mock('../shared/prompt/index.js', async (original) => ({
  ...await original<typeof import('../shared/prompt/index.js')>(), confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, execFileSync: vi.fn(module.execFileSync) };
});

vi.mock('node:fs', async (original) => {
  const module = await original<typeof import('node:fs')>();
  return { ...module, rmSync: vi.fn(module.rmSync), unlinkSync: vi.fn(module.unlinkSync) };
});

const taskName = 'goal-work';
const branch = 'takt/goal-work';
const taskDir = '.takt/tasks/goal-work';
const originalOrder = '# Original canonical order\n\nApply the original requirements.';
const revisedOrder = '# Revised canonical order\n\nApply the corrected requirements.';
const note = 'Resume after provider capacity recovers.';
const workflowName = 'goal-retry-fixture';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function retryRecords(unit: unknown): Record<string, unknown>[] {
  if (unit === null || typeof unit !== 'object') return [];
  if (Array.isArray(unit)) return unit.flatMap(retryRecords);
  const record = unit as Record<string, unknown>;
  const values = Object.values(record);
  // 計画は履歴のフィールド名を定めていないため、操作種類と時刻という保存契約を観測する。
  if (values.some((value) => value === 'requeue' || value === 'retry')
    && values.some((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value)))) {
    return [record];
  }
  return values.flatMap(retryRecords);
}

describe('goal task retry through manager MCP and persistent task execution', () => {
  let root: string;
  let cwd: string;
  let clone: string;
  let goalBranch: string;
  let initialSha: string;
  let resultSha: string;
  let runner: TaskRunner;
  let store: GoalStore;
  let eventId: string;

  beforeEach(async () => {
    vi.mocked(confirm).mockReset().mockResolvedValue(true);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-retry-')));
    cwd = join(root, 'project');
    clone = join(cwd, '.takt', 'worktrees', 'goal-work');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'README.md'), 'fixture\n');
    initializeGitFixture(cwd, ['README.md']);
    git(cwd, ['branch', '-M', 'main']);
    git(cwd, ['config', 'user.name', 'TAKT test']);
    git(cwd, ['config', 'user.email', 'takt-test@example.invalid']);
    initialSha = git(cwd, ['rev-parse', 'HEAD']);
    mkdirSync(join(cwd, '.takt', 'workflows', 'personas'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_pr: false\nmanager:\n  auto_run: false\n');
    writeFileSync(join(cwd, '.takt', 'workflows', `${workflowName}.yaml`), [
      `name: ${workflowName}`, 'max_steps: 10', 'initial_step: plan', 'steps:',
      '  - name: plan', '    persona: ./personas/planner.md', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: review',
      '  - name: review', '    persona: ./personas/reviewer.md', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(cwd, '.takt', 'workflows', 'personas', 'planner.md'), 'Plan the fixture task.');
    writeFileSync(join(cwd, '.takt', 'workflows', 'personas', 'reviewer.md'), 'Review the fixture task.');
    invalidateGlobalConfigCache();
    resetScenario();
    goalBranch = (await registerFixtureGoal(cwd)).branch;
    git(cwd, ['branch', branch, goalBranch]);
    mkdirSync(join(cwd, '.takt', 'worktrees'), { recursive: true });
    git(root, ['clone', '--quiet', cwd, clone]);
    git(clone, ['config', 'user.name', 'TAKT test']);
    git(clone, ['config', 'user.email', 'takt-test@example.invalid']);
    git(clone, ['checkout', '--quiet', branch]);
    cpSync(join(cwd, '.takt', 'workflows'), join(clone, '.takt', 'workflows'), { recursive: true });
    cpSync(join(cwd, '.takt', 'config.yaml'), join(clone, '.takt', 'config.yaml'));
    writeFileSync(join(clone, 'result.txt'), 'reviewed fixture result\n');
    git(clone, ['add', 'result.txt']);
    git(clone, ['commit', '--quiet', '-m', 'fixture result']);
    resultSha = git(clone, ['rev-parse', 'HEAD']);
    git(cwd, ['fetch', '--quiet', clone, `${branch}:${branch}`]);
    mkdirSync(join(cwd, taskDir), { recursive: true });
    writeFileSync(join(cwd, taskDir, 'order.md'), originalOrder);
    runner = new TaskRunner(cwd);
    runner.addTask(taskName, { task_dir: taskDir, workflow: workflowName, worktree: true,
      worktree_path: clone, branch, goal_id: goalId, goal_purpose: '入力検証', goal_work_key: 'validation' });
    const claimed = runner.claimNextTasks(1)[0]!;
    const running = runner.updateRunningTaskExecution(claimed.name, { runSlug: 'failed-run', worktreePath: clone, branch });
    runner.failTask({ task: running, success: false, response: 'provider unavailable', executionLog: [],
      failureStep: 'review', branch, worktreePath: clone,
      startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z',
      completion: { success: false, interrupted: false, branch, sha: resultSha, workflowResult: 'error' } });
    for (const runSlug of ['failed-run', 'exceeded-run']) {
      const runDir = join(clone, '.takt', 'runs', runSlug);
      for (const directory of ['logs', 'reports', 'context']) mkdirSync(join(runDir, directory), { recursive: true });
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
        task: taskName, workflow: workflowName, status: 'failed', runSlug,
        runRoot: `.takt/runs/${runSlug}`, reportDirectory: `.takt/runs/${runSlug}/reports`,
        contextDirectory: `.takt/runs/${runSlug}/context`, logsDirectory: `.takt/runs/${runSlug}/logs`,
        startTime: '2026-10-08T00:00:00Z', endTime: '2026-10-08T00:01:00Z', currentStep: 'review',
      }));
    }
    store = new GoalStore(cwd);
    eventId = 'completion-a';
    await store.update(goalId, (goal) => ({ ...goal,
      workUnits: [{ taskName, purpose: '入力検証', workKey: 'validation', integration: {
        sourceBranch: branch, expectedSha: initialSha, goalSha: initialSha, status: 'merged',
        recordedAt: '2026-10-08T00:00:00Z',
      } }],
      events: [{ id: eventId, kind: 'completion', taskName, runSlug: 'failed-run',
        result: { success: false, interrupted: false }, processed: true }],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); resetScenario(); invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function withClient<T>(action: (client: Client) => Promise<T>, toolSet: 'manager' | 'read-only' = 'manager'): Promise<T> {
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet,
      goalEventContext: { goalId, eventId }, goalTurnOwners: {} });
    const client = new Client({ name: 'goal-retry-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await action(client);
    } finally { await client.close(); await server.close(); }
  }

  async function call(kind: 'requeue' | 'retry', extra: Record<string, unknown> = {}) {
    return withClient(async (client) => {
      const name = kind === 'requeue' ? 'takt_requeue_goal_task' : 'takt_retry_goal_task';
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(name);
      return client.callTool({ name, arguments: { cwd, goalId, taskName, operationName: `redo:${kind}`,
        ...(kind === 'retry' ? { task: revisedOrder } : { retryNote: note }), ...extra } });
    });
  }

  async function exceed() {
    runner.requeueFailedTask(taskName, 'review');
    const running = runner.claimNextTasks(1)[0]!;
    runner.updateRunningTaskExecution(running.name, { runSlug: 'exceeded-run', branch, worktreePath: clone });
    const workflow = loadWorkflowByIdentifier(workflowName, cwd, { lookupCwd: clone })!;
    runner.exceedTask(taskName, { currentStep: 'review', currentIteration: 4, newMaxSteps: 10,
      branch, worktreePath: clone, resumePoint: {
        version: 2, stack: [{ workflow: workflowName, workflow_ref: getWorkflowReference(workflow), step: 'review', kind: 'agent', occurrence: 2,
          step_iterations: { plan: 1, review: 2 } }], iteration: 4, elapsed_ms: 1000,
        workflow_call_invocations: {}, workflow_step_participations: {},
      } });
  }

  async function runAndMerge(expectedPersona: 'planner' | 'reviewer', expectedOrder: string, expectedNote?: string) {
    const originalSetup = MockProvider.prototype.setup;
    const started: string[] = [];
    const managerInputs: Array<{ event: { runSlug?: string }; goal: { id: string } }> = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = originalSetup.call(this, config);
      return { call: async (prompt, options) => {
        if (config.name === 'manager') {
          managerInputs.push(JSON.parse(prompt));
          expect(options.allowedTools).toContain(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_requeue_goal_task`);
          expect(options.allowedTools).toContain(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_retry_goal_task`);
          setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '再実行の終了を確認', summary: null }) }]);
        } else {
          started.push(config.name);
          if (expectedNote !== undefined) expect(prompt).toContain(expectedNote);
          setMockScenario([{ persona: config.name, status: 'done', content: 'Complete.' }]);
        }
        return agent.call(prompt, options);
      } };
    });
    const pending = runner.listTasks()[0]!;
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved.startStep).toBe(expectedPersona === 'planner' ? 'plan' : 'review');
    const result = await runWithWorkerPool(runner, runner.claimNextTasks(1), 1, cwd, { provider: 'mock' }, undefined, 10);
    expect(result).toMatchObject({ success: 1, fail: 0, executedTaskNames: [taskName] });
    expect(started).toEqual(expectedPersona === 'planner' ? ['planner', 'reviewer'] : ['reviewer']);
    const completed = new TaskRunner(cwd).listTaskStateItems()[0]!;
    expect(completed).toMatchObject({ name: taskName, goalId, branch, status: 'completed',
      completion: { success: true, branch, sha: resultSha } });
    expect(completed.runSlug).toBeDefined();
    expect(completed.runSlug).not.toBe('failed-run');
    const saved = await store.get(goalId);
    const event = saved.events!.find((event) => event.kind === 'completion' && event.runSlug === completed.runSlug);
    expect(event).toMatchObject({ taskName, runSlug: completed.runSlug, processed: true, result: { success: true, branch } });
    expect(managerInputs).toEqual([expect.objectContaining({ goal: expect.objectContaining({ id: goalId }),
      event: expect.objectContaining({ taskName, runSlug: completed.runSlug }) })]);
    const stagedOrder = join(clone, '.takt', 'runs', completed.runSlug!, 'context', 'task', 'order.md');
    expect(readFileSync(stagedOrder, 'utf8')).toBe(expectedOrder);
    const history = retryRecords(saved.workUnits![0]);
    expect(history).toHaveLength(1);
    expect(Object.values(history[0]!)).toContain(expectedOrder === revisedOrder ? 'retry' : 'requeue');
    expect(Object.values(history[0]!)).toContain(saved.operations![0]!.id);
    const merged = await withClient((client) => client.callTool({ name: 'takt_merge_goal_task', arguments: {
      cwd, goalId, taskName, expectedSha: resultSha, operationName: 'merge:rerun',
    } }));
    expect(merged.isError, firstTextContent(merged.content)).toBeUndefined();
    expect(JSON.parse(firstTextContent(merged.content))).toMatchObject({ status: 'merged', expectedSha: resultSha, sourceBranch: branch });
    expect(git(cwd, ['merge-base', '--is-ancestor', resultSha, goalBranch])).toBe('');
    const unit = (await new GoalStore(cwd).get(goalId)).workUnits![0]!;
    expect(unit).toMatchObject({ taskName, purpose: '入力検証', workKey: 'validation', integration: { status: 'merged', expectedSha: resultSha } });
    expect(retryRecords(unit)).toEqual(history);
  }

  it('registers both retry tools for manager use while keeping read-only tools unchanged', async () => {
    await withClient(async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(['takt_requeue_goal_task', 'takt_retry_goal_task']));
    });
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).not.toContain('takt_requeue_goal_task');
      expect(names).not.toContain('takt_retry_goal_task');
    }, 'read-only');
  });

  it('preserves the existing human Requeue path for an ordinary failed task', async () => {
    new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
      ...task, goal_id: undefined, goal_purpose: undefined, goal_work_key: undefined,
    })) }));
    const failed = runner.listFailedTasks()[0]!;
    const preparation = prepareFailedTaskRetry(failed, cwd);
    const context = buildFailedTaskRetryStartContext(preparation, cwd, workflowName);
    const start = resolveFailedTaskRetryStart(context, context.startOptions.defaultId);
    await persistFailedTaskRetry({ task: failed, projectDir: cwd, worktreePath: clone,
      startStep: start.startStep, retryNote: note, resumePoint: start.resumePoint,
      restartPoint: start.restartPoint, workflow: context.workflowOverride,
      taskDir: failed.taskDir, sourceRunSlug: preparation.matchedRunSlug });
    const pending = runner.listTasks()[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.data?.goal_id).toBeUndefined();
    expect(pending.data?.goal_operation_id).toBeUndefined();
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved.startStep).toBe('review');
    const setup = vi.spyOn(MockProvider.prototype, 'setup');
    setMockScenario([{ persona: 'reviewer', status: 'done', content: 'Complete.' }]);
    expect(await executeAndCompleteTask(runner.claimNextTasks(1)[0]!, runner, cwd,
      { provider: 'mock' }, { outputMode: 'silent' })).toBe(true);
    expect(setup.mock.calls.map(([config]) => config.name)).toEqual(['reviewer']);
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
    expect(runner.listTaskStateItems()[0]!.status).toBe('completed');
  });

  it.each([false, true])('requeues failed goal work from its stopping step with an additional note (interrupted: %s)', async (interrupted) => {
    if (interrupted) new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
      ...task, completion: { success: false, interrupted: true, branch, workflowResult: 'error' },
    })) }));
    const previousIntegration = (await store.get(goalId)).workUnits![0]!.integration;
    const result = await call('requeue');
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const pending = new TaskRunner(cwd).listPendingTaskItems();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: taskName, branch, worktreePath: clone, sourceRunSlug: 'failed-run' });
    expect(pending[0]!.data?.retry_note).toContain(note);
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
    expect((await store.get(goalId)).workUnits![0]!.integration).toEqual(previousIntegration);
    await runAndMerge('reviewer', originalOrder, note);
  });

  it('requeues exceeded work with the saved checkpoint, iteration, limit and note', async () => {
    await exceed();
    const stopped = runner.listAllTaskItems()[0]!;
    const result = await call('requeue');
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const pending = runner.listTasks()[0]!;
    expect(pending.data).toMatchObject({ goal_id: goalId, branch, start_step: 'review',
      exceeded_current_iteration: 4, exceeded_max_steps: 10, resume_point: stopped.data!.resume_point });
    expect(pending.data!.retry_note).toContain(note);
    const resolved = await resolveTaskExecution(pending, cwd, undefined, { outputMode: 'silent' });
    expect(resolved).toMatchObject({ startStep: 'review', initialIterationOverride: 4, maxStepsOverride: 10 });
    await runAndMerge('reviewer', originalOrder, note);
  });

  it.each(['plan', undefined])('retries corrected instructions from the requested or default start (%s)', async (startStep) => {
    const result = await call('retry', startStep === undefined ? {} : { startStep });
    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const pending = runner.listPendingTaskItems()[0]!;
    expect(pending).toMatchObject({ name: taskName, kind: 'pending', branch, worktreePath: clone });
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(revisedOrder);
    expect(pending.data?.retry_note?.includes(revisedOrder)).not.toBe(true);
    const archives = readdirSync(join(cwd, taskDir)).filter((name) => name.startsWith('order.md.'));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(cwd, taskDir, archives[0]!), 'utf8')).toBe(originalOrder);
    await runAndMerge(startStep === 'plan' ? 'planner' : 'reviewer', revisedOrder);
  });

  it.each(['failed requeue', 'retry', 'exceeded requeue'] as const)('restores %s after queue publication without repeating queue or order writes', async (path) => {
    if (path === 'exceeded requeue') await exceed();
    const kind = path === 'retry' ? 'retry' : 'requeue';
    const update = GoalStore.prototype.update;
    let rejected = false;
    const publication = vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
      if (!rejected && runner.listTaskStateItems()[0]!.status === 'pending') {
        rejected = true; throw new Error('Injected goal failure after queue publication');
      }
      return update.call(this, id, transform);
    });
    expect((await call(kind)).isError).toBe(true);
    expect(rejected).toBe(true);
    const saved = await store.get(goalId);
    expect(saved.operations).toEqual([expect.objectContaining({ status: 'pending' })]);
    const operation = saved.operations![0]!;
    expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'pending', goalOperationId: operation.id });
    expect(runner.listPendingTaskItems()[0]!.data).toMatchObject({ goal_operation_id: operation.id });
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(kind === 'retry' ? revisedOrder : originalOrder);
    publication.mockRestore();
    const tasksFile = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    const archives = readdirSync(join(cwd, taskDir));
    const queueWrite = vi.spyOn(TaskStore.prototype, 'update');
    const recovered = await call(kind);
    expect(recovered.isError, firstTextContent(recovered.content)).toBeUndefined();
    expect(await call(kind)).toEqual(recovered);
    expect(queueWrite).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(tasksFile);
    expect(readdirSync(join(cwd, taskDir))).toEqual(archives);
    const goal = await new GoalStore(cwd).get(goalId);
    expect(goal.operations).toEqual([expect.objectContaining({ id: operation.id, status: 'completed', result: JSON.parse(firstTextContent(recovered.content)) })]);
    const history = retryRecords(goal.workUnits![0]);
    expect(history).toHaveLength(1);
    expect(Object.values(history[0]!)).toContain(kind);
    expect(Object.values(history[0]!)).toContain(operation.id);
  });

  it('rolls back the revised order when the task queue rejects Retry', async () => {
    const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    const update = vi.spyOn(TaskStore.prototype, 'update').mockImplementation(() => { throw new Error('Injected queue publication failure'); });
    expect((await call('retry')).isError).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
    expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
    expect(readdirSync(join(cwd, taskDir)).filter((name) => name.startsWith('order.md.'))).toEqual([]);
    expect(retryRecords((await store.get(goalId)).workUnits![0])).toEqual([]);
  });

  it('continues to skip automatic retries for failed goal-owned work', () => {
    const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    expect(runner.autoRequeueFailedTask(taskName, { maxAttempts: 3 })).toMatchObject({ requeued: false, reason: 'goal_owned' });
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
  });

  describe('goal task removal through manager MCP', () => {
    const reason = '方針変更により不要';

    async function remove(extra: Record<string, unknown> = {}) {
      return withClient((client) => client.callTool({ name: 'takt_remove_goal_task', arguments: {
        cwd, goalId, taskName, reason, operationName: 'remove:goal-work', ...extra,
      } }));
    }

    function setStatus(status: 'pending' | 'completed' | 'failed' | 'exceeded' | 'pr_failed') {
      new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, status,
        started_at: status === 'pending' ? null : '2026-10-08T00:00:00Z',
        completed_at: status === 'pending' ? null : '2026-10-08T00:01:00Z',
        owner_pid: null, owner_start_time: null,
        failure: status === 'failed' || status === 'pr_failed' ? task.failure : undefined,
        completion: status === 'completed' ? { success: true, interrupted: false, branch, sha: resultSha } : undefined,
      })) }));
    }

    function prepareOrphanedClone() {
      const cloneBase = join(root, 'takt-worktrees');
      mkdirSync(cloneBase);
      const orphan = join(cloneBase, taskName);
      fs.renameSync(clone, orphan);
      clone = orphan;
      new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
        ...task, worktree_path: undefined, worktree: false,
      })) }));
      saveCloneMeta(cwd, branch, clone);
      return getCloneMetaPath(cwd, branch);
    }

    it.each([[false, false], [true, false], [true, true]])(
      'retains failed orphan cleanup and resumes the same removal (deletion failure: %s, clone disappears: %s)', async (deletionFailure, cloneDisappears) => {
        const metadata = prepareOrphanedClone();
        const tasksBefore = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
        const metadataBefore = readFileSync(metadata, 'utf8');
        const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs');
        let failCloneRemoval = deletionFailure;
        const directoryRemovals = vi.mocked(fs.rmSync).mockClear().mockImplementation((path, options) => {
          if (path === clone && failCloneRemoval) throw Object.assign(new Error('clone deletion denied'), { code: 'EACCES' });
          return originalFs.rmSync(path, options);
        });
        const gitCommands = vi.mocked(childProcess.execFileSync).mockClear();
        const taskWrites = vi.spyOn(TaskStore.prototype, 'update');

        const first = await remove();

        expect(first.isError).toBe(deletionFailure ? true : undefined);
        if (deletionFailure) {
          const pending = await new GoalStore(cwd).get(goalId);
          expect(pending.operations).toEqual([expect.objectContaining({ status: 'pending', recovery: expect.any(Object) })]);
          expect(taskRemovalRecords(pending.workUnits)).toEqual([]);
          expect(taskWrites).not.toHaveBeenCalled();
          expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(tasksBefore);
          expect(readFileSync(metadata, 'utf8')).toBe(metadataBefore);
          expect(existsSync(clone)).toBe(true);
          expect(git(cwd, ['branch', '--format=%(refname:short)']).split('\n')).not.toContain(branch);
          const listed = await withClient((client) => client.callTool({ name: 'takt_list_tasks', arguments: { cwd } }));
          expect(listed.isError).toBeUndefined();
          expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([expect.objectContaining({ name: taskName, status: 'failed' })]);

          expect((await remove()).isError).toBe(true);
          expect(await new GoalStore(cwd).get(goalId)).toEqual(pending);
          expect(taskWrites).not.toHaveBeenCalled();
          expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(tasksBefore);
          expect(readFileSync(metadata, 'utf8')).toBe(metadataBefore);
          expect(existsSync(clone)).toBe(true);
          if (cloneDisappears) originalFs.rmSync(clone, { recursive: true, force: true });
          else failCloneRemoval = false;
        }

        const recovered = await remove();

        expect(recovered.isError, firstTextContent(recovered.content)).toBeUndefined();
        expect(existsSync(clone)).toBe(false);
        expect(existsSync(metadata)).toBe(false);
        expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
        const saved = await new GoalStore(cwd).get(goalId);
        expect(saved.operations).toEqual([expect.objectContaining({ status: 'completed',
          operationName: 'remove:goal-work', arguments: { taskName, reason },
          result: JSON.parse(firstTextContent(recovered.content)),
        })]);
        expect(taskRemovalRecords(saved.workUnits)).toEqual([expect.objectContaining({ kind: 'cleanup', reason,
          operationId: saved.operations![0]!.id, recordedAt: saved.operations![0]!.recordedAt,
        })]);
        const listed = await withClient((client) => client.callTool({ name: 'takt_list_tasks', arguments: { cwd } }));
        expect(listed.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([]);
        expect(await remove()).toEqual(recovered);
        expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
        expect(taskWrites).toHaveBeenCalledOnce();
        expect(gitCommands.mock.calls.filter(([, args]) => args?.[0] === 'branch' && args[1] === '-D')).toHaveLength(1);
        expect(directoryRemovals.mock.calls.filter(([path]) => path === clone)).toHaveLength(deletionFailure ? (cloneDisappears ? 2 : 3) : 1);
      },
    );

    it.each([false, true])('preserves human Delete when orphan clone deletion fails (%s)', async (deletionFailure) => {
      const metadata = prepareOrphanedClone();
      new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
        ...task, goal_id: undefined, goal_purpose: undefined, goal_work_key: undefined,
      })) }));
      const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const directoryRemovals = vi.mocked(fs.rmSync).mockClear().mockImplementation((path, options) => {
        if (path === clone && deletionFailure) throw Object.assign(new Error('clone deletion denied'), { code: 'EACCES' });
        return originalFs.rmSync(path, options);
      });

      expect(await deleteTaskByKind(runner.listAllTaskItems()[0]!)).toBe(true);

      expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
      expect(runner.listTaskStateItems()).toEqual([]);
      expect(existsSync(metadata)).toBe(false);
      expect(existsSync(clone)).toBe(deletionFailure);
      expect(git(cwd, ['branch', '--format=%(refname:short)']).split('\n')).not.toContain(branch);
      expect(directoryRemovals.mock.calls.filter(([path]) => path === clone)).toHaveLength(1);
      expect((await store.get(goalId)).operations).toBeUndefined();
      expect(taskRemovalRecords((await store.get(goalId)).workUnits)).toEqual([]);
    });

    it('preserves the task, branch and worktree when human Delete is cancelled', async () => {
      const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
      vi.mocked(confirm).mockResolvedValue(false);
      expect(await deleteTaskByKind(runner.listAllTaskItems()[0]!)).toBe(false);
      expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
      expect(existsSync(clone)).toBe(true);
      expect(git(cwd, ['rev-parse', branch])).toBe(resultSha);
    });

    it('rejects human Delete of running work before confirmation or resource cleanup', async () => {
      runner.requeueFailedTask(taskName, 'review');
      runner.claimNextTasks(1);
      const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
      await expect(deleteTaskByKind(runner.listAllTaskItems()[0]!)).rejects.toThrow(/running/u);
      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(before);
      expect(existsSync(clone)).toBe(true);
    });

    it('registers removal for the manager and its allowed tools without exposing it read-only', async () => {
      await withClient(async (client) => {
        const tools = (await client.listTools()).tools;
        const tool = tools.find(({ name }) => name === 'takt_remove_goal_task');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(['goalId', 'taskName', 'reason']));
      });
      const { createManagerConversationPlan } = await import('../features/manager/conversationPlan.js');
      expect(createManagerConversationPlan(cwd, {}).strategy.allowedTools)
        .toContain(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__takt_remove_goal_task`);
      await withClient(async (client) => {
        expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain('takt_remove_goal_task');
      }, 'read-only');
    });

    it('persists pending cancellation and projects it separately from outstanding work', async () => {
      setStatus('pending');
      await store.update(goalId, (goal) => ({ ...goal, workUnits: [
        { taskName, purpose: '入力検証', workKey: 'validation' },
        { taskName: 'still-needed', purpose: '残る作業', workKey: 'remaining' },
      ] }));

      const result = await remove();

      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
      const saved = await new GoalStore(cwd).get(goalId);
      const unit = saved.workUnits![0]!;
      const records = taskRemovalRecords(unit);
      expect(records).toEqual([expect.objectContaining({ kind: expect.any(String), reason,
        operationId: saved.operations![0]!.id, recordedAt: expect.any(String),
      })]);
      expect(unit).toMatchObject({ taskName, purpose: '入力検証', workKey: 'validation' });
      expect(unit.integration).toBeUndefined();
      expect(saved.operations).toEqual([expect.objectContaining({ operationName: 'remove:goal-work',
        status: 'completed', arguments: { taskName, reason }, result: JSON.parse(firstTextContent(result.content)),
      })]);
      const context = JSON.parse(buildGoalTurnContext(cwd, saved, saved.events![0]!, []));
      expect(context.goal.workUnits[0]).toMatchObject({ taskName, awaitingIntegration: false });
      expect(taskRemovalRecords(context.goal.workUnits[0])).toEqual(records);
      expect(taskRemovalRecords(context.goal.workUnits[1])).toEqual([]);
      expect(context.goal.workUnits[1].awaitingIntegration).toBe(true);
      const listed = await withClient((client) => client.callTool({ name: 'takt_list_tasks', arguments: { cwd } }));
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([]);
    });

    it.each([false, true])('matches human Delete for merged work, sessions, branches and run records (worktree: %s)', async (worktree) => {
      setStatus('completed');
      git(cwd, ['update-ref', `refs/heads/${goalBranch}`, resultSha]);
      await store.update(goalId, (goal) => ({ ...goal, workUnits: goal.workUnits!.map((unit) => ({ ...unit,
        integration: { ...unit.integration!, expectedSha: resultSha, goalSha: resultSha },
      })) }));
      if (!worktree) new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
        ...task, worktree_path: undefined, worktree: false,
      })) }));
      const humanBranch = 'takt/human-cleanup';
      const humanClone = join(cwd, '.takt', 'worktrees', 'human-cleanup');
      git(cwd, ['branch', humanBranch, resultSha]);
      if (worktree) { mkdirSync(humanClone, { recursive: true }); writeFileSync(join(humanClone, 'result.txt'), 'fixture'); }
      runner.addTask('human-cleanup', { workflow: workflowName,
        branch: humanBranch, worktree: false, ...(worktree ? { worktree_path: humanClone } : {}) });
      setStatus('completed');
      const sessionDirectory = join(cwd, '.takt', 'worktree-sessions');
      mkdirSync(sessionDirectory, { recursive: true });
      const session = join(sessionDirectory, `${encodeWorktreePath(clone)}.json`);
      const humanSession = join(sessionDirectory, `${encodeWorktreePath(humanClone)}.json`);
      writeFileSync(session, '{}'); writeFileSync(humanSession, '{}');
      const runRecord = join(cwd, '.takt', 'runs', 'root-run', 'meta.json');
      mkdirSync(join(cwd, '.takt', 'runs', 'root-run'), { recursive: true });
      writeFileSync(runRecord, 'retained run evidence');
      const humanTask = runner.listAllTaskItems().find(({ name }) => name === 'human-cleanup')!;

      expect(await deleteTaskByKind(humanTask)).toBe(true);
      const result = await remove();

      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(runner.listTaskStateItems()).toEqual([]);
      expect(existsSync(clone)).toBe(!worktree);
      expect(existsSync(humanClone)).toBe(false);
      expect(existsSync(session)).toBe(!worktree);
      expect(existsSync(humanSession)).toBe(!worktree);
      const branches = git(cwd, ['branch', '--format=%(refname:short)']).split('\n');
      expect(branches.includes(branch)).toBe(worktree);
      expect(branches.includes(humanBranch)).toBe(worktree);
      expect(readFileSync(runRecord, 'utf8')).toBe('retained run evidence');
      expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(originalOrder);
      expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
    });

    it('retains cancellation state in bounded manager context when the reason and purpose are oversized', async () => {
      setStatus('pending');
      await store.update(goalId, (goal) => ({ ...goal, workUnits: [{ taskName,
        workKey: 'validation', purpose: '日本語'.repeat(5000) }] }));
      const result = await remove({ reason: '日本語'.repeat(5000) });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const saved = await new GoalStore(cwd).get(goalId);
      const record = taskRemovalRecords(saved.workUnits![0])[0]!;
      const prompt = buildGoalTurnContext(cwd, saved, saved.events![0]!, []);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
      const context = JSON.parse(prompt);
      expect(context.goal.workUnits).toHaveLength(1);
      expect(context.goal.workUnits[0]).toMatchObject({ taskName, awaitingIntegration: false });
      const projected = taskRemovalRecords(context.goal.workUnits[0])[0]!;
      expect(projected).toMatchObject({ kind: record.kind, recordedAt: record.recordedAt, operationId: record.operationId });
      expect(saved.workUnits![0]!.integration).toBeUndefined();
    });

    it.each(['failed', 'exceeded', 'pr_failed'] as const)('cleans stopped %s work with a reason and retains previous integration and retry evidence', async (status) => {
      setStatus(status);
      await store.update(goalId, (goal) => ({ ...goal, workUnits: goal.workUnits!.map((unit) => ({
        ...unit, retries: [{ kind: 'requeue', recordedAt: '2026-10-08T00:00:00Z', operationId: 'previous-retry' }],
      })) }));
      const unit = (await store.get(goalId)).workUnits![0]!;
      const result = await remove();
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(runner.listTaskStateItems()).toEqual([]);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.workUnits![0]).toMatchObject(unit);
      expect(taskRemovalRecords(saved.workUnits![0])).toEqual([expect.objectContaining({ reason })]);
      expect(saved.operations![0]!.arguments).toEqual({ taskName, reason });
    });

    it('returns a saved removal result on replay after the task has disappeared', async () => {
      const first = await remove();
      expect(first.isError, firstTextContent(first.content)).toBeUndefined();
      const before = await store.get(goalId);
      const taskWrites = vi.spyOn(TaskStore.prototype, 'update');
      expect(await remove()).toEqual(first);
      expect(taskWrites).not.toHaveBeenCalled();
      expect(await new GoalStore(cwd).get(goalId)).toEqual(before);
    });

    it.each([[false, false, false], [false, true, false], [true, false, false], [true, true, false],
      [false, true, true], [true, true, true]])(
      'completes removal without repeating cleanup (worktree: %s, row write failure: %s, recovery write failure: %s)', async (worktree, rowWriteFailure, recoveryWriteFailure) => {
        if (!worktree) new TaskStore(cwd).update((current) => ({ tasks: current.tasks.map((task) => ({
          ...task, worktree_path: undefined, worktree: false,
        })) }));
        const session = join(cwd, '.takt', 'worktree-sessions', `${encodeWorktreePath(clone)}.json`);
        mkdirSync(join(cwd, '.takt', 'worktree-sessions'), { recursive: true });
        writeFileSync(session, '{}');
        const cleanup = vi.spyOn(taskActions, 'deleteBranch');
        const gitCommands = vi.mocked(childProcess.execFileSync).mockClear();
        const directoryRemovals = vi.mocked(fs.rmSync).mockClear();
        const sessionRemovals = vi.mocked(fs.unlinkSync).mockClear();
        const taskWrite = vi.spyOn(TaskStore.prototype, 'update');
        const goalUpdate = GoalStore.prototype.update;
        let failGoalWrite = false;
        vi.spyOn(GoalStore.prototype, 'update').mockImplementation(function (this: GoalStore, ...args) {
          if (failGoalWrite) {
            failGoalWrite = false;
            return Promise.reject(new Error('Injected cleanup recovery write failure'));
          }
          return goalUpdate.apply(this, args);
        });
        if (rowWriteFailure) taskWrite.mockImplementationOnce(() => {
          failGoalWrite = recoveryWriteFailure;
          throw new Error('Injected task row deletion failure');
        });

        const first = await remove();

        expect(first.isError).toBe(rowWriteFailure ? true : undefined);
        expect(taskWrite).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(cleanup.mock.results[0]!.value).toBe(true);
        expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(rowWriteFailure
          ? [expect.objectContaining({ name: taskName, status: 'failed' })] : []);
        expect(existsSync(clone)).toBe(!worktree);
        expect(existsSync(session)).toBe(!worktree);
        expect(git(cwd, ['branch', '--format=%(refname:short)']).split('\n').includes(branch)).toBe(worktree);
        const pending = await new GoalStore(cwd).get(goalId);
        expect(pending.operations).toEqual([expect.objectContaining({ status: rowWriteFailure ? 'pending' : 'completed' })]);
        if (rowWriteFailure) expect(taskRemovalRecords(pending.workUnits)).toEqual([]);

        failGoalWrite = false;
        const recovered = await remove();

        expect(recovered.isError, firstTextContent(recovered.content)).toBeUndefined();
        expect(cleanup).toHaveBeenCalledTimes(rowWriteFailure ? 2 : 1);
        expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
        const saved = await new GoalStore(cwd).get(goalId);
        expect(saved.operations).toEqual([expect.objectContaining({ id: pending.operations![0]!.id,
          status: 'completed', result: JSON.parse(firstTextContent(recovered.content)),
        })]);
        expect(taskRemovalRecords(saved.workUnits)).toEqual([expect.objectContaining({ reason,
          operationId: pending.operations![0]!.id, recordedAt: pending.operations![0]!.recordedAt,
        })]);
        const listed = await withClient((client) => client.callTool({ name: 'takt_list_tasks', arguments: { cwd } }));
        expect(listed.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([]);
        expect(await remove()).toEqual(recovered);
        expect(taskWrite).toHaveBeenCalledTimes(rowWriteFailure ? 2 : 1);
        expect(cleanup).toHaveBeenCalledTimes(rowWriteFailure ? 2 : 1);
        expect(gitCommands.mock.calls.filter(([, args]) => args?.[0] === 'branch' && args[1] === '-D')).toHaveLength(worktree ? 0 : 1);
        expect(directoryRemovals.mock.calls.filter(([path]) => path === clone)).toHaveLength(worktree ? 1 : 0);
        expect(sessionRemovals.mock.calls.filter(([path]) => path === session)).toHaveLength(worktree ? 1 : 0);
      },
    );

    it.each([false, true])('keeps pending removal recoverable when claiming intervenes before recovery saving (%s)', async (claimIntervenes) => {
      setStatus('pending');
      const other = runner.addTask('other-goal-work', { workflow: workflowName, goal_id: goalId });
      const ordinary = runner.addTask('ordinary-work', { workflow: workflowName });
      await store.update(goalId, (goal) => ({ ...goal, workUnits: [...goal.workUnits!, {
        taskName: other.name, purpose: '残る作業',
      }] }));
      const taskUpdate = TaskStore.prototype.update;
      const events: string[] = [];
      const claims: string[] = [];
      vi.spyOn(TaskStore.prototype, 'update').mockImplementationOnce(() => {
        events.push('row-failed');
        throw new Error('Injected pending row deletion failure');
      });
      const goalUpdate = GoalStore.prototype.update;
      function claimAfterFailure() {
        if (claimIntervenes && events.includes('row-failed') && claims.length === 0) {
          vi.spyOn(TaskStore.prototype, 'update').mockImplementation(taskUpdate);
          claims.push(...runner.claimNextTasks(2).map((task) => task.name));
          events.push('claimed');
        }
      }
      vi.spyOn(GoalStore.prototype, 'update').mockImplementation(function (this: GoalStore, ...args) {
        if (events.includes('row-failed')) {
          events.push('saving-recovery');
          claimAfterFailure();
        }
        return goalUpdate.apply(this, args);
      });
      const goalGet = GoalStore.prototype.get;
      vi.spyOn(GoalStore.prototype, 'get').mockImplementation(function (this: GoalStore, ...args) {
        claimAfterFailure();
        return goalGet.apply(this, args);
      });

      expect((await remove()).isError).toBe(true);
      if (claimIntervenes) {
        expect(events.filter((event) => event !== 'saving-recovery')).toEqual(['row-failed', 'claimed']);
        expect(claims).toEqual([other.name, ordinary.name]);
        expect(runner.listTaskStateItems().find((task) => task.name === taskName)?.status).toBe('pending');
      }
      const recovered = await remove();
      expect(recovered.isError, firstTextContent(recovered.content)).toBeUndefined();
      expect(runner.listTaskStateItems().some((task) => task.name === taskName)).toBe(false);
      const saved = await store.get(goalId);
      expect(saved.operations![0]!.status).toBe('completed');
      expect(taskRemovalRecords(saved.workUnits)).toEqual([expect.objectContaining({ kind: 'cancel', reason })]);
    });

    it.each([false, true])('serializes removal preparation with pending claims (claim first: %s)', async (claimFirst) => {
      setStatus('pending');
      const update = GoalStore.prototype.update;
      const claims: string[] = [];
      vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async function (this: GoalStore, ...args) {
        if (claimFirst) claims.push(...runner.claimNextTasks(1).map((task) => task.name));
        const result = await update.apply(this, args);
        if (!claimFirst) claims.push(...runner.claimNextTasks(1).map((task) => task.name));
        return result;
      });

      const result = await remove();

      expect(result.isError).toBe(claimFirst ? true : undefined);
      expect(claims).toEqual(claimFirst ? [taskName] : []);
      if (claimFirst) {
        expect(runner.listTaskStateItems()[0]!.status).toBe('running');
        expect(existsSync(clone)).toBe(true);
        expect(git(cwd, ['rev-parse', branch])).toBe(resultSha);
        expect(taskRemovalRecords((await store.get(goalId)).workUnits)).toEqual([]);
      } else {
        expect(runner.listTaskStateItems()).toEqual([]);
      }
    });

    it('rejects a changed reason under the same event operation name', async () => {
      expect((await remove()).isError).toBeUndefined();
      const before = await store.get(goalId);
      const result = await remove({ reason: '容量不足' });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/different arguments/iu);
      expect(await store.get(goalId)).toEqual(before);
      expect(runner.listTaskStateItems()).toEqual([]);
    });

    it('retains workKey question dependencies across cancellation and allows work only after an answer', async () => {
      setStatus('pending');
      const questionId = '650e8400-e29b-41d4-a716-446655440001';
      await store.update(goalId, (goal) => ({ ...goal, questions: [{ id: questionId, recipient: 'human',
        body: '実行条件を確認してください', dependentWorkKeys: ['validation'], status: 'pending' }],
      }));
      const before = (await store.get(goalId)).questions;
      expect((await remove()).isError).toBeUndefined();
      expect((await store.get(goalId)).questions).toEqual(before);
      const enqueue = () => withClient((client) => client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
        cwd, goalId, task: 'Implement corrected work', purpose: '検証', workKey: 'validation',
        workflow: workflowName, operationName: 'work:replacement',
      } }));
      const blocked = await enqueue();
      expect(blocked.isError).toBe(true);
      expect(firstTextContent(blocked.content)).toContain(questionId);
      expect(runner.listTaskStateItems()).toEqual([]);
      await store.update(goalId, (goal) => answerGoalQuestion(goal, questionId, '続行してください'));
      eventId = (await store.get(goalId)).events!.find((event) => event.kind === 'answer')!.id;
      const allowed = await enqueue();
      expect(allowed.isError, firstTextContent(allowed.content)).toBeUndefined();
      expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ status: 'pending', goalWorkKey: 'validation' })]);
      expect((await store.get(goalId)).questions![0]!.status).toBe('answered');
    });

    describe.each(['completed', 'aborted'] as const)('completed work for a %s goal', (status) => {
      it.each(['merged', 'conflict'] as const)('allows cleanup only for merged integration (integration: %s)', async (integrationStatus) => {
        await store.update(goalId, (goal) => ({ ...goal,
          ...(status === 'completed' ? { status } : { executionStatus: status }),
          completion: { goalBranch, goalSha: resultSha, targetBranch: 'main', targetSha: resultSha,
            summary: '検証済み', instructions: [],
            changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
          },
          workUnits: goal.workUnits!.map((unit) => ({ ...unit, integration: { ...unit.integration!,
            status: integrationStatus, expectedSha: resultSha, goalSha: resultSha,
          } })),
        }));
        expect((await call('requeue')).isError).toBe(true);
        expect((await call('retry')).isError).toBe(true);
        expect(runner.listTaskStateItems()[0]!.status).toBe('failed');
        setStatus('completed');
        git(cwd, ['update-ref', `refs/heads/${goalBranch}`, resultSha]);
        const before = await new GoalStore(cwd).get(goalId);
        const tasksBefore = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
        const cleanup = vi.spyOn(taskActions, 'deleteBranch');

        const result = await remove();

        const saved = await new GoalStore(cwd).get(goalId);
        expect(saved.status).toBe(before.status);
        expect(saved.executionStatus).toBe(before.executionStatus);
        expect(saved.completion).toEqual(before.completion);
        const listed = await withClient((client) => client.callTool({ name: 'takt_list_tasks', arguments: { cwd } }));
        expect(listed.isError).toBeUndefined();
        if (integrationStatus === 'merged') {
          expect(result.isError, firstTextContent(result.content)).toBeUndefined();
          expect(cleanup).toHaveBeenCalledOnce();
          expect(runner.listTaskStateItems()).toEqual([]);
          expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([]);
          expect(existsSync(clone)).toBe(false);
          expect(taskRemovalRecords(saved.workUnits)).toEqual([expect.objectContaining({ kind: 'cleanup', reason })]);
        } else {
          expect(result.isError).toBe(true);
          expect(cleanup).not.toHaveBeenCalled();
          expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(tasksBefore);
          expect(JSON.parse(firstTextContent(listed.content)).tasks).toEqual([expect.objectContaining({ name: taskName, status: 'completed' })]);
          expect(existsSync(clone)).toBe(true);
          expect(taskRemovalRecords(saved.workUnits)).toEqual([]);
        }
        expect(git(cwd, ['rev-parse', branch])).toBe(resultSha);
        expect(saved.workUnits![0]!.integration).toEqual(before.workUnits![0]!.integration);
        expect(saved.workUnits![0]!.retries).toEqual(before.workUnits![0]!.retries);
      });
    });

    it.each(['paused', 'aborted', 'completed', 'awaiting_merge'] as const)('cleans ended work for a %s goal while preserving its status and retry restrictions', async (status) => {
      await store.update(goalId, (goal) => status === 'paused' || status === 'aborted'
        ? { ...goal, executionStatus: status }
        : { ...goal, status, completion: { goalBranch, goalSha: initialSha, targetBranch: 'main',
          summary: '検証済み', instructions: [], targetSha: initialSha,
          changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
        } });
      const before = await store.get(goalId);
      expect((await call('requeue')).isError).toBe(true);
      const result = await remove();
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const saved = await store.get(goalId);
      expect(saved.status).toBe(before.status);
      expect(saved.executionStatus).toBe(before.executionStatus);
      expect(saved.completion).toEqual(before.completion);
      expect(runner.listTaskStateItems()).toEqual([]);
    });
  });
});
