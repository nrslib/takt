import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
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
import { goalId } from './helpers/goal-fixtures.js';
import { initializeGitFixture } from './helpers/git-fixture.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { firstTextContent } from './helpers/mcp-content.js';

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
    persistFailedTaskRetry({ task: failed, projectDir: cwd, worktreePath: clone,
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
});
