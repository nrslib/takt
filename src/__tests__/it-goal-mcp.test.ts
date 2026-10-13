import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer, type TaktMcpToolSet } from '../features/mcp/server.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { GoalStore } from '../infra/goals/store.js';
import { recordGoalCompletion } from '../infra/goals/reconcile.js';
import * as crypto from 'node:crypto';
import * as slack from '../shared/utils/slackWebhook.js';
import * as goalGit from '../infra/goals/git-command.js';
import { GOAL_TURN_OWNERS_ENV, withGoalTurns, type GoalTurnOwners } from '../infra/goals/turn-lock.js';
import { enqueueTaktGoalTask } from '../features/mcp/goalOperations.js';
import * as managerRecovery from '../features/manager/completionTurn.js';
import * as managerAutoRun from '../features/manager/autoRun.js';
import { TaskRunner } from '../infra/task/index.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../infra/config/index.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getRepertoireDir } from '../infra/config/paths.js';
import { attemptAutoRequeueTask, requeueExistingFailedTasks } from '../features/tasks/execute/parallelExecution.js';
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import type { Goal } from '../infra/goals/schema.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { firstTextContent } from './helpers/mcp-content.js';
import * as artifacts from '../shared/utils/private-artifact-backend.js';
import { readManagerRunFailures } from '../infra/task/manager-run-state.js';
import { goalId } from './helpers/goal-fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));
vi.mock('../shared/utils/private-artifact-backend.js', async (original) => ({ ...await original<typeof import('../shared/utils/private-artifact-backend.js')>() }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe('manager goal task enqueue', () => {
  let cwd: string;
  let goalBranch: string;
  const purpose = '入力検証を追加する';
  const task = 'input-validation';
  const enqueueTool = 'takt_enqueue_goal_task';

  beforeEach(async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-manager-enqueue-')));
    initializeRepository(cwd);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'provider: mock', 'branch_name_strategy: romaji', 'base_branch: release',
      'manager:', '  auto_run: false',
    ].join('\n'));
    goalBranch = (await registerFixtureGoal(cwd)).branch;
    const goalCommit = git(cwd, ['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'goal progress']);
    git(cwd, ['update-ref', `refs/heads/${goalBranch}`, goalCommit]);
    writeWorkflow('safe', [
      '  - name: work', '    persona: coder', '    instruction: Implement input validation',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
    await setImmediate();
  });

  it.each(['configuration changed', 'project moved'] as const)('reads and enqueues a local goal after %s', async (change) => {
    const previousConfig = process.env.TAKT_CONFIG_DIR;
    const moved = join(cwd, 'moved-project');
    let project = cwd;
    if (change === 'project moved') {
      mkdirSync(moved);
      cpSync(join(cwd, '.git'), join(moved, '.git'), { recursive: true });
      cpSync(join(cwd, '.takt'), join(moved, '.takt'), { recursive: true });
      project = moved;
    }
    const config = join(project, 'new-config');
    mkdirSync(config);
    process.env.TAKT_CONFIG_DIR = config;
    try {
      await withServer(project, 'manager', async (client) => {
        const read = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: project, goalId } });
        expect(read.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(read.content)).goal.branch).toBe(goalBranch);
        const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd: project } });
        expect(listed.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(listed.content)).goals).toEqual([await new GoalStore(project).get(goalId)]);
        const result = await client.callTool({ name: enqueueTool, arguments: { cwd: project, goalId, purpose, task, workflow: 'safe' } });
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        expect(new TaskRunner(project).listTaskStateItems()).toEqual([expect.objectContaining({ goalId, status: 'pending' })]);
        expect((await new GoalStore(project).get(goalId)).workUnits).toEqual([
          { taskName: JSON.parse(firstTextContent(result.content)).taskName, purpose },
        ]);
      });
    } finally {
      if (previousConfig === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfig;
    }
  });

  function writeWorkflow(name: string, steps: string, callable = false): void {
    writeFileSync(join(cwd, '.takt', 'workflows', `${name}.yaml`), [
      `name: ${name}`, `description: fixture ${name}`,
      ...(callable ? ['subworkflow:', '  callable: true'] : []),
      'max_steps: 4', `initial_step: ${name === 'parent' ? 'delegate' : 'work'}`,
      'steps:', steps, '',
    ].join('\n'));
  }

  async function withEnqueue<T>(action: (client: Client) => Promise<T>): Promise<T> {
    return withServer(cwd, 'manager', async (client) => {
      // 拒否テストを「ツールが未登録」のエラーで成功させない。
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(enqueueTool);
      return action(client);
    });
  }

  async function enqueue(client: Client, extra: Record<string, unknown> = {}) {
    return client.callTool({
      name: enqueueTool, arguments: { cwd, goalId, purpose, task, workflow: 'safe', ...extra },
    });
  }

  function pendingTasks() {
    return new TaskRunner(cwd).listPendingTaskItems();
  }

  function savedWorkUnits(): Array<{ taskName: string; purpose: string }> {
    const saved = JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')) as {
      workUnits: Array<{ taskName: string; purpose: string }>;
    };
    return saved.workUnits;
  }

  it('rejects a missing goal without saving a task', async () => {
    await withEnqueue(async (client) => {
      const result = await enqueue(client, { goalId: '550e8400-e29b-41d4-a716-446655440001' });
      expect(result.isError).toBe(true);
      expect(pendingTasks()).toEqual([]);
    });
  });

  it('fixes local execution to the goal branch and preserves ownership after claim', async () => {
    await withEnqueue(async (client) => {
      expect((await enqueue(client)).isError).toBeUndefined();
      const restored = pendingTasks();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.data).toMatchObject({
        goal_id: goalId, base_branch: goalBranch, worktree: true,
        auto_pr: false, should_publish_branch_to_origin: false,
      });
      const claimed = new TaskRunner(cwd).claimNextTasks(1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.data).toMatchObject({ goal_id: goalId, base_branch: goalBranch });
    });
  });

  it('keeps ordinary tasks pending across goal-only claims while a direct runner claims all tasks', () => {
    const runner = new TaskRunner(cwd);
    const ordinary = runner.addTask('ordinary work', { workflow: 'safe' });
    const first = runner.addTask('first goal work', { workflow: 'safe', goal_id: goalId });
    const goals = new TaskRunner(cwd, { goalTasksOnly: true });
    expect(goals.claimNextTasks(2).map(({ name }) => name)).toEqual([first.name]);
    const second = runner.addTask('second goal work', { workflow: 'safe', goal_id: goalId });
    expect(goals.claimNextTasks(2).map(({ name }) => name)).toEqual([second.name]);
    expect(goals.claimNextTasks(2)).toEqual([]);
    expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([ordinary.name]);
    const third = runner.addTask('third goal work', { workflow: 'safe', goal_id: goalId });
    expect(runner.claimNextTasks(2).map(({ name }) => name)).toEqual([ordinary.name, third.name]);
  });

  it('creates the execution branch from the goal commit despite a different configured base branch', async () => {
    await withEnqueue(async (client) => {
      expect((await enqueue(client)).isError).toBeUndefined();
      const claimed = new TaskRunner(cwd).claimNextTasks(1)[0]!;
      // 作業ツリーの出力先だけを fixture 内へ固定し、保存済みの土台を実 resolver へ渡す。
      const resolved = await resolveTaskExecution({
        ...claimed, data: { ...claimed.data!, worktree: join(cwd, 'clones') },
      }, cwd);
      expect(resolved.isWorktree).toBe(true);
      expect(resolved.baseBranch).toBe(goalBranch);
      expect(git(resolved.execCwd, ['rev-parse', 'HEAD'])).toBe(git(cwd, ['rev-parse', goalBranch]));
      expect(git(resolved.execCwd, ['rev-parse', 'HEAD'])).not.toBe(git(cwd, ['rev-parse', 'release']));
      expect(resolved.autoPr).toBe(false);
      expect(resolved.shouldPublishBranchToOrigin).toBe(false);
    });
  });

  it.each([
    { baseBranch: 'release' },
    { taskContext: { baseBranch: 'release' } },
    { issue: { number: 123 } },
    { autoPr: true },
    { shouldPublishBranchToOrigin: true },
  ])('does not accept caller-controlled execution context: %j', async (extra) => {
    await withEnqueue(async (client) => {
      const result = await enqueue(client, extra);
      if (result.isError !== true) {
        expect(pendingTasks()[0]!.data).toMatchObject({
          base_branch: goalBranch, auto_pr: false, should_publish_branch_to_origin: false,
        });
        expect(pendingTasks()[0]!.data).not.toHaveProperty('issue');
      } else {
        expect(pendingTasks()).toEqual([]);
      }
    });
  });

  it.each(['merge_pr', 'close_pr'] as const)('rejects a direct %s effect before enqueue', async (effect) => {
    writeWorkflow('forbidden', [
      '  - name: work', '    kind: system',
      `    effects: [{type: ${effect}, pr: 1}]`,
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    expect(loadWorkflowByIdentifier('forbidden', cwd)).not.toBeNull();
    await withEnqueue(async (client) => {
      expect((await enqueue(client, { workflow: 'forbidden' })).isError).toBe(true);
      expect(pendingTasks()).toEqual([]);
      const listed = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      const { workflows } = JSON.parse(firstTextContent(listed.content)) as { workflows: Array<{ name: string }> };
      expect(workflows.map(({ name }) => name)).not.toContain('forbidden');
    });
  });

  it.each(['./work.yaml', '../work.yml', 'work.yaml', '/work.yaml', '~/work.yaml'])('rejects workflow path %s without saving goal work', async (workflow) => {
    writeFileSync(join(cwd, 'work.yaml'), readFileSync(join(cwd, '.takt/workflows/safe.yaml')));
    await withEnqueue(async (client) => {
      expect((await enqueue(client, { workflow })).isError).toBe(true);
      expect(pendingTasks()).toEqual([]);
      expect((await new GoalStore(cwd).get(goalId)).workUnits ?? []).toEqual([]);
    });
  });

  it.each(['project', 'user', 'builtin', 'repertoire'] as const)('loads the validated %s workflow from the same source with a worktree lookup directory', async (source) => {
    const identifier = source === 'builtin' ? 'default' : source === 'user' ? 'goal-user-fixture' : source === 'repertoire' ? '@goal/work/safe' : 'safe';
    if (source === 'user') {
      const directory = join(process.env.TAKT_CONFIG_DIR!, 'workflows');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${identifier}.yaml`), readFileSync(join(cwd, '.takt/workflows/safe.yaml'), 'utf8').replace('name: safe', `name: ${identifier}`));
    }
    if (source === 'repertoire') {
      const directory = join(getRepertoireDir(), '@goal', 'work', 'workflows');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'safe.yaml'), readFileSync(join(cwd, '.takt/workflows/safe.yaml')));
    }
    const validated = loadWorkflowByIdentifier(identifier, cwd)!;
    expect(validated).not.toBeNull();
    await withEnqueue(async (client) => {
      const listed = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      const { workflows } = JSON.parse(firstTextContent(listed.content)) as { workflows: Array<{ name: string }> };
      expect(workflows.map(({ name }) => name)).toContain(identifier);
      expect((await enqueue(client, { workflow: identifier })).isError).toBeUndefined();
      const claimed = new TaskRunner(cwd).claimNextTasks(1)[0]!;
      const execution = await resolveTaskExecution({ ...claimed, data: { ...claimed.data!, worktree: join(cwd, 'clones') } }, cwd);
      mkdirSync(join(execution.execCwd, '.takt/workflows'), { recursive: true });
      writeFileSync(join(execution.execCwd, '.takt/workflows', `${identifier.split('/').at(-1)}.yaml`), 'name: forbidden\nsteps: []\n');
      const executed = loadWorkflowByIdentifier(identifier, cwd, { lookupCwd: execution.execCwd })!;
      expect(executed).toEqual(validated);
      expect(getWorkflowSourcePath(executed)).toBe(getWorkflowSourcePath(validated));
    });
  });

  it('rejects a forbidden effect in a workflow_call target before enqueue', async () => {
    writeWorkflow('child', [
      '  - name: work', '    kind: system', '    effects:',
      '      - type: close_pr', '        pr: 1',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'), true);
    writeWorkflow('parent', [
      '  - name: delegate', '    kind: workflow_call', '    call: child',
      '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      '      - condition: ABORT', '        next: ABORT',
    ].join('\n'));
    const parent = loadWorkflowByIdentifier('parent', cwd)!;
    const delegate = parent.steps[0]!;
    if (delegate.kind !== 'workflow_call') throw new Error('Fixture must call a child workflow');
    expect(resolveWorkflowCallTarget(parent, delegate, cwd, cwd)).not.toBeNull();
    await withEnqueue(async (client) => {
      expect((await enqueue(client, { workflow: 'parent' })).isError).toBe(true);
      expect(pendingTasks()).toEqual([]);
      const listed = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      const { workflows } = JSON.parse(firstTextContent(listed.content)) as { workflows: Array<{ name: string }> };
      expect(workflows.map(({ name }) => name)).not.toContain('parent');
    });
  });

  it.each(['project', 'repertoire'] as const)('resolves a relative workflow_call from the same %s parent source at validation and execution', async (source) => {
    writeWorkflow('child', [
      '  - name: work', '    instruction: Safe child', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'), true);
    writeWorkflow('parent', [
      '  - name: delegate', '    kind: workflow_call', '    call: ./child.yaml',
      '    rules:', '      - condition: COMPLETE', '        next: COMPLETE',
      '      - condition: ABORT', '        next: ABORT',
    ].join('\n'));
    const identifier = source === 'repertoire' ? '@goal/work/parent' : 'parent';
    if (source === 'repertoire') {
      const directory = join(getRepertoireDir(), '@goal', 'work', 'workflows');
      mkdirSync(directory, { recursive: true });
      for (const name of ['parent', 'child']) {
        writeFileSync(join(directory, `${name}.yaml`), readFileSync(join(cwd, '.takt/workflows', `${name}.yaml`)));
      }
    }
    const parent = loadWorkflowByIdentifier(identifier, cwd)!;
    const step = parent.steps[0]!;
    if (step.kind !== 'workflow_call') throw new Error('Fixture must call a child workflow');
    const validatedChild = resolveWorkflowCallTarget(parent, step, cwd, cwd)!;
    await withEnqueue(async (client) => {
      const listed = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      const { workflows } = JSON.parse(firstTextContent(listed.content)) as { workflows: Array<{ name: string }> };
      expect(workflows.map(({ name }) => name)).toContain(identifier);
      expect((await enqueue(client, { workflow: identifier })).isError).toBeUndefined();
      const worktree = join(cwd, 'different-worktree');
      mkdirSync(join(worktree, '.takt/workflows'), { recursive: true });
      writeFileSync(join(worktree, '.takt/workflows/child.yaml'), 'name: forbidden\nsteps: []\n');
      const executedParent = loadWorkflowByIdentifier(identifier, cwd, { lookupCwd: worktree })!;
      const executedStep = executedParent.steps[0]!;
      if (executedStep.kind !== 'workflow_call') throw new Error('Fixture must call a child workflow');
      const executedChild = resolveWorkflowCallTarget(executedParent, executedStep, cwd, worktree)!;
      expect(executedChild).toEqual(validatedChild);
      expect(getWorkflowSourcePath(executedChild)).toBe(getWorkflowSourcePath(validatedChild));
    });
  });

  it('allows effect names inside instructions and YAML comments without rejecting the task', async () => {
    writeWorkflow('mentions-only', [
      '  - name: work', '    persona: coder',
      '    instruction: |', '      Explain "merge_pr".',
      '      ```yaml', '      type: close_pr', '      ```',
      '      This block scalar documents merge_pr.',
      '    # type: merge_pr',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    expect(loadWorkflowByIdentifier('mentions-only', cwd)).not.toBeNull();
    await withEnqueue(async (client) => {
      expect((await enqueue(client, { workflow: 'mentions-only' })).isError).toBeUndefined();
      expect(pendingTasks()).toHaveLength(1);
    });
  });

  it('records the returned task name together with its purpose', async () => {
    await withEnqueue(async (client) => {
      const result = await enqueue(client);
      expect(result.isError).toBeUndefined();
      const { taskName } = JSON.parse(firstTextContent(result.content)) as { taskName: string };
      expect(pendingTasks().map(({ name }) => name)).toEqual([taskName]);
      expect(savedWorkUnits()).toEqual([expect.objectContaining({ taskName, purpose })]);
    });
  });

  it('preserves earlier work units when the task name collides', async () => {
    await withEnqueue(async (client) => {
      const created: Array<{ taskName: string; purpose: string }> = [];
      for (const nextPurpose of ['既存の作業', '別の既存作業', purpose]) {
        const result = await enqueue(client, { purpose: nextPurpose });
        expect(result.isError).toBeUndefined();
        const { taskName } = JSON.parse(firstTextContent(result.content)) as { taskName: string };
        created.push({ taskName, purpose: nextPurpose });
      }
      expect(new Set(created.map(({ taskName }) => taskName)).size).toBe(3);
      expect(created.map(({ taskName }) => taskName)).toEqual([
        created[0]!.taskName, `${created[0]!.taskName}-1`, `${created[0]!.taskName}-2`,
      ]);
      expect(pendingTasks().map(({ name }) => name)).toEqual(created.map(({ taskName }) => taskName));
      expect(savedWorkUnits()).toEqual(created.map((unit) => expect.objectContaining(unit)));
    });
  });

  it('leaves no runnable task or work unit when queue publication fails', async () => {
    vi.spyOn(TaskRunner.prototype, 'addTask').mockImplementationOnce(() => { throw new Error('injected queue publication failure'); });
    await withEnqueue(async (client) => {
      expect((await enqueue(client)).isError).toBe(true);
      expect(new TaskRunner(cwd).listAllTaskItems()).toEqual([]);
      expect(new TaskRunner(cwd).claimNextTasks(1)).toEqual([]);
      expect((await new GoalStore(cwd).get(goalId)).workUnits ?? []).toEqual([]);
    });
  });

  it('reports a saved task as partial success and restores its work unit without resubmission', async () => {
    const update = GoalStore.prototype.update;
    const fail = vi.spyOn(GoalStore.prototype, 'update').mockRejectedValue(new Error('injected goal publication failure'));
    await withEnqueue(async (client) => {
      const result = await enqueue(client);
      expect(result.isError).toBeUndefined();
      const created = JSON.parse(firstTextContent(result.content)) as { taskName: string };
      expect(created).toMatchObject({ taskEnqueued: true, workUnitRecorded: false, workUnitRecordError: expect.any(String) });
      expect(pendingTasks().map(({ name }) => name)).toEqual([created.taskName]);
      expect((await new GoalStore(cwd).get(goalId)).workUnits ?? []).toEqual([]);
      fail.mockImplementation(update);
      const restored = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(restored.isError).toBeUndefined();
      await vi.waitFor(() => expect(savedWorkUnits()).toEqual([{ taskName: created.taskName, purpose }]));
      expect(pendingTasks().map(({ name }) => name)).toEqual([created.taskName]);
      expect(new TaskRunner(cwd).claimNextTasks(2).map(({ name }) => name)).toEqual([created.taskName]);
      expect(pendingTasks()).toEqual([]);
    });
  });

  it.each(['all', 'manager'] as const)('recovers once per read and checks enqueue startup once with the %s tool set', async (toolSet) => {
    await withServer(cwd, toolSet, async (client) => {
      const recovery = vi.spyOn(managerRecovery, 'recoverManagerEvents');
      const startup = vi.spyOn(managerAutoRun, 'ensureManagerRun');
      expect((await enqueue(client)).isError).toBeUndefined();
      expect(recovery.mock.calls).toEqual([[cwd], [cwd]]);
      expect(startup).toHaveBeenCalledExactlyOnceWith(cwd);
      recovery.mockClear();
      startup.mockClear();
      const read = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(read.isError).toBeUndefined();
      expect(recovery).toHaveBeenCalledExactlyOnceWith(cwd);
      expect(startup).toHaveBeenCalledExactlyOnceWith(cwd);
    });
  });

  it('recovers a saved task whose goal work unit was not published without enqueueing a duplicate', async () => {
    const units: Array<{ taskName: string; purpose: string }> = [];
    await withEnqueue(async (client) => {
      for (const nextPurpose of ['保存済みの作業', purpose]) {
        const result = await enqueue(client, { purpose: nextPurpose });
        expect(result.isError).toBeUndefined();
        const { taskName } = JSON.parse(firstTextContent(result.content)) as { taskName: string };
        units.push({ taskName, purpose: nextPurpose });
      }
    });
    const file = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // タスクの保存後、対応するゴール更新だけが公開されなかった状態を再現する。
    writeFileSync(file, JSON.stringify({ ...saved, workUnits: savedWorkUnits().slice(0, 1) }));

    await withServer(cwd, 'manager', async (client) => {
      expect((await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } })).isError).toBeUndefined();
      await vi.waitFor(() => expect(savedWorkUnits()).toEqual(units.map((unit) => expect.objectContaining(unit))));
    });

    expect(savedWorkUnits()).toEqual(units.map((unit) => expect.objectContaining(unit)));
    expect(pendingTasks().map(({ name }) => name)).toEqual(units.map(({ taskName }) => taskName));
  });

  it('keeps both work units when two MCP clients enqueue into the same goal', async () => {
    await withEnqueue(async (first) => withEnqueue(async (second) => {
      const results = await Promise.all([
        enqueue(first, { purpose: '先行作業' }), enqueue(second, { purpose: '後続作業' }),
      ]);
      for (const result of results) expect(result.isError).toBeUndefined();
      const names = results.map((result) =>
        (JSON.parse(firstTextContent(result.content)) as { taskName: string }).taskName);
      expect(new Set(names).size).toBe(2);
      expect(savedWorkUnits()).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskName: names[0], purpose: '先行作業' }),
        expect.objectContaining({ taskName: names[1], purpose: '後続作業' }),
      ]));
      expect(pendingTasks()).toHaveLength(2);
    }));
  });

  it('waits for writes to a locked goal while allowing another goal to accept work', async () => {
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const lock = withGoalTurns(cwd, [goalId], async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await held;
    const input = { cwd, goalId, purpose, task, workflow: 'safe' };
    let sameFinished = false;
    const same = enqueueTaktGoalTask(input, {}, new AbortController().signal).then((result) => {
      sameFinished = true;
      return result;
    });
    try {
      const result = await enqueueTaktGoalTask({ ...input, goalId: other.id }, {}, new AbortController().signal);
      expect(result.isError).toBeUndefined();
      expect(sameFinished).toBe(false);
      expect(pendingTasks().map((task) => task.data!.goal_id)).toEqual([other.id]);
      expect((await new GoalStore(cwd).get(goalId)).workUnits).toBeUndefined();
    } finally { release(); await lock; await same; }
    expect((await same).isError).toBeUndefined();
    expect(pendingTasks().map((task) => task.data!.goal_id)).toEqual([other.id, goalId]);
  });

  it('preserves both goal updates from independent MCP server processes', async () => {
    const connections: Awaited<ReturnType<typeof connectManagerMcp>>[] = [];
    try {
      // 両サーバーを起動してから同じゴールへ同時に書き込む。
      const started = await Promise.allSettled([
        connectManagerMcp(cwd), connectManagerMcp(cwd),
      ]);
      for (const result of started) {
        if (result.status === 'fulfilled') connections.push(result.value);
      }
      expect(started.every((result) => result.status === 'fulfilled')).toBe(true);
      for (const connection of connections) {
        expect((await connection.client.listTools()).tools.map(({ name }) => name)).toContain(enqueueTool);
      }
      const purposes = ['入力を検証する', '出力を検証する'];
      const results = await Promise.all(connections.map(({ client }, index) => enqueue(client, { purpose: purposes[index] })));
      expect(results.every((result) => result.isError !== true)).toBe(true);
      const names = results.map((result) => (JSON.parse(firstTextContent(result.content)) as { taskName: string }).taskName);
      expect(new Set(names).size).toBe(2);
      expect(savedWorkUnits()).toEqual(expect.arrayContaining(names.map((taskName, index) =>
        expect.objectContaining({ taskName, purpose: purposes[index] }))));
      expect(savedWorkUnits()).toHaveLength(2);
      expect(pendingTasks().map(({ name }) => name).sort()).toEqual([...names].sort());
    } finally {
      await Promise.all(connections.map(({ dispose }) => dispose()));
    }
  });

  it('provides workflow names and descriptions through a read-only manager tool', async () => {
    await withServer(cwd, 'manager', async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_list_workflows');
      const result = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
        workflows: expect.arrayContaining([expect.objectContaining({ name: 'safe', description: 'fixture safe' })]),
      });
      expect(pendingTasks()).toEqual([]);
    });
  });

  it('reads globally configured workflow names and descriptions through the actual manager MCP child', async () => {
    const globalDir = process.env.TAKT_CONFIG_DIR!;
    mkdirSync(join(globalDir, 'workflows'), { recursive: true });
    writeFileSync(join(globalDir, 'workflows', 'global-goal-work.yaml'), [
      'name: global-goal-work', 'description: global workflow for goal work',
      'max_steps: 2', 'initial_step: work', 'steps:', '  - name: work',
      '    instruction: Implement self-contained work', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    let connection: Awaited<ReturnType<typeof connectManagerMcp>> | undefined;
    try {
      connection = await connectManagerMcp(cwd);
      const result = await connection.client.callTool({ name: 'takt_list_workflows', arguments: { cwd } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
        workflows: expect.arrayContaining([{ name: 'global-goal-work', description: 'global workflow for goal work' }]),
      });
      expect(pendingTasks()).toEqual([]);
    } finally {
      await connection?.dispose();
    }
  });

  it.each([
    { entry: 'startup', belongsToGoal: true },
    { entry: 'completion', belongsToGoal: true },
    { entry: 'startup', belongsToGoal: false },
    { entry: 'completion', belongsToGoal: false },
  ])('controls automatic requeue by persisted goal ownership: %j', ({ entry, belongsToGoal }) => {
    const runner = new TaskRunner(cwd);
    const options = { workflow: 'safe', ...(belongsToGoal ? { goal_id: goalId } : {}) };
    runner.addTask(task, options);
    const running = runner.claimNextTasks(1)[0]!;
    runner.failTask({
      task: running, success: false, response: 'retryable workflow failure',
      executionLog: [], failureStep: 'work',
      startedAt: '2026-10-06T00:00:00.000Z', completedAt: '2026-10-06T00:01:00.000Z',
    });

    const count = entry === 'startup'
      ? requeueExistingFailedTasks(new TaskRunner(cwd), 1)
      : Number(attemptAutoRequeueTask(new TaskRunner(cwd), running.name, 1));

    expect(count).toBe(belongsToGoal ? 0 : 1);
    const restored = new TaskRunner(cwd).listAllTaskItems()[0]!;
    expect(restored.kind).toBe(belongsToGoal ? 'failed' : 'pending');
    if (belongsToGoal) {
      expect(restored.data).toMatchObject({ goal_id: goalId });
      expect(restored.data).not.toHaveProperty('retry_note');
    }
  });
});


function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
      GIT_AUTHOR_DATE: '2026-10-04T14:43:00Z', GIT_COMMITTER_DATE: '2026-10-04T14:43:00Z',
    },
  }).trim();
}

function initializeRepository(cwd: string): { mainCommit: string; releaseCommit: string } {
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'user.name', 'Goal Test']);
  git(cwd, ['config', 'user.email', 'goal@example.test']);
  const tree = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '');
  const mainCommit = git(cwd, ['commit-tree', tree, '-m', 'main fixture']);
  const releaseCommit = git(cwd, ['commit-tree', tree, '-p', mainCommit, '-m', 'release fixture']);
  git(cwd, ['update-ref', 'refs/heads/main', mainCommit]);
  git(cwd, ['update-ref', 'refs/heads/release', releaseCommit]);
  git(cwd, ['update-ref', 'refs/heads/feature/current', releaseCommit]);
  git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/feature/current']);
  return { mainCommit, releaseCommit };
}

describe('local goal integration and inspection through manager MCP', () => {
  let cwd: string;
  let branch: string;
  let base: string;
  let temporaryDirectories: string[];
  const summary = '受け入れ条件: 出力を取得できる。根拠: fixture のテスト成功と成果物確認。';
  const mergeTool = 'takt_merge_goal_task';
  const completeTool = 'takt_complete_goal';
  const checkTool = 'takt_check_goal_completion';

  beforeEach(async () => {
    temporaryDirectories = [];
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-integration-')));
    initializeRepository(cwd);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.gitignore'), '.takt/\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), [
      'name: safe', 'description: fixture', 'max_steps: 2', 'initial_step: work', 'steps:',
      '  - name: work', '    instruction: "{task}"', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    configure('approve');
    base = commitFiles('main', { 'tracked.txt': 'base\n', 'src/a.ts': 'old\n' });
    for (const name of ['main', 'release', 'feature/current']) git(cwd, ['update-ref', `refs/heads/${name}`, base]);
    git(cwd, ['read-tree', '--reset', '-u', 'HEAD']);
    branch = (await registerFixtureGoal(cwd)).branch;
  }, 30000);

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    await setImmediate();
  });

  function configure(mode: 'auto' | 'approve' | undefined, target?: string) {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'provider: mock', 'branch_name_strategy: romaji', ...(target === undefined ? [] : [`base_branch: ${target}`]),
      'manager:', '  auto_run: false', ...(mode === undefined ? [] : [`  main_merge: ${mode}`]),
    ].join('\n'));
  }

  function commitFiles(parent: string, files: Record<string, string | Buffer>): string {
    const index = join(cwd, '.git', 'fixture-index');
    const run = (args: string[], input?: string | Buffer) => execFileSync('git', args, {
      cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_INDEX_FILE: index },
    }).trim();
    try {
      run(['read-tree', parent]);
      for (const [path, content] of Object.entries(files)) {
        const hash = run(['hash-object', '-w', '--stdin'], content);
        run(['update-index', '--add', '--cacheinfo', '100644', hash, path]);
      }
      const tree = run(['write-tree']);
      return git(cwd, ['commit-tree', tree, '-p', parent, '-m', 'fixture changes']);
    } finally { rmSync(index, { force: true }); }
  }

  async function saveResult(files: Record<string, string | Buffer>, owner: string | null = goalId, success = true, sourceOverride?: string) {
    const sha = commitFiles(branch, files);
    const source = sourceOverride ?? `takt/task-${sha.slice(0, 12)}`;
    git(cwd, ['update-ref', `refs/heads/${source}`, sha]);
    const runner = new TaskRunner(cwd);
    const added = runner.addTask('fixture result', { workflow: 'safe', worktree: false, ...(owner === null ? {} : { goal_id: owner }), branch: source });
    const claimed = runner.claimNextTasks(1)[0]!;
    const task = runner.updateRunningTaskExecution(claimed.name, { runSlug: `run-${sha}`, branch: source });
    const result = { task, success, branch: source, completion: { success, interrupted: false, branch: source, sha },
      response: 'fixture result', executionLog: [], startedAt: '2026-10-07T00:00:00Z', completedAt: '2026-10-07T00:01:00Z' };
    if (success) runner.completeTask(result); else runner.failTask(result);
    if (owner !== null) await new GoalStore(cwd).update(owner, (goal) => ({
      ...goal, workUnits: [...(goal.workUnits ?? []), { taskName: added.name, purpose: '成果を確認する' }],
    }));
    if (owner !== null) {
      await recordGoalCompletion(cwd, owner, { taskName: added.name, runSlug: `run-${sha}`, result: result.completion });
      await new GoalStore(cwd).update(owner, (goal) => ({ ...goal, events: goal.events?.map((event) => ({ ...event, processed: true })) }));
    }
    return { taskName: added.name, sha, source };
  }

  async function call(client: Client, name: string, extra: Record<string, unknown> = {}) {
    expect((await client.listTools()).tools.map((tool) => tool.name), '拒否を未登録ツールのエラーで代替しない').toContain(name);
    return client.callTool({ name, arguments: { cwd, goalId, ...extra } });
  }

  function humanSnapshot(directory = cwd) {
    return {
      head: git(directory, ['rev-parse', 'HEAD']), symbolicHead: git(directory, ['symbolic-ref', 'HEAD']),
      index: git(directory, ['ls-files', '--stage', '-z']),
      files: ['tracked.txt', 'untracked.txt'].map((path) => readFileSync(join(directory, path))),
      status: git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'tracked.txt', 'untracked.txt']),
    };
  }

  function dirtyHumanTree(directory = cwd) {
    writeFileSync(join(directory, 'tracked.txt'), 'staged\n');
    const hash = git(directory, ['hash-object', '-w', 'tracked.txt']);
    git(directory, ['update-index', '--cacheinfo', '100644', hash, 'tracked.txt']);
    writeFileSync(join(directory, 'tracked.txt'), 'unstaged\n');
    writeFileSync(join(directory, 'untracked.txt'), 'human data\n');
  }

  function expectIncluded(sha: string, target: string) {
    expect(git(cwd, ['merge-base', '--is-ancestor', sha, target])).toBe('');
  }

  function observeCleanup(failure: boolean): void {
    const remove = fsPromises.rm;
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (typeof path === 'string' && path.startsWith(join(tmpdir(), 'takt-goal-merge-'))) {
        temporaryDirectories.push(path);
        if (failure) throw new Error('Injected temporary clone cleanup failure');
      }
      await remove(path, options);
    });
  }

  it.each(['task', 'goal'] as const)('reuses the saved %s operation result after the goal has completed and its branch has advanced', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const eventId = Reflect.get((await new GoalStore(cwd).get(goalId)).events![0]!, 'id') as string;
    const input = kind === 'task'
      ? { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha }
      : { operationName: 'complete:acceptance', expectedSha: task.sha, summary };
    const tool = kind === 'task' ? mergeTool : completeTool;
    if (kind === 'goal') { configure('auto'); git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]); }
    let first: unknown;
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, tool, input);
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      first = JSON.parse(firstTextContent(response.content));
      if (kind === 'task') {
        configure('auto');
        expect((await call(client, completeTool, {
          operationName: 'complete:after-merge', expectedSha: git(cwd, ['rev-parse', branch]), summary,
        })).isError).toBeUndefined();
      }
    }, { goalId, eventId });
    const completed = await new GoalStore(cwd).get(goalId);
    expect(completed.status).toBe('completed');
    expect(completed.workLog).toEqual([]);
    git(cwd, ['update-ref', `refs/heads/${branch}`, commitFiles(branch, { 'later.txt': 'later\n' })]);
    const refs = git(cwd, ['show-ref', '--heads']);
    const saved = await new GoalStore(cwd).get(goalId);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, tool, input);
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      expect(JSON.parse(firstTextContent(response.content))).toEqual(first);
    }, { goalId, eventId });
    expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
  });

  it.each(['task', 'goal'] as const)('recovers a %s operation after Git publication and before goal publication without losing its original evidence', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const eventId = Reflect.get((await new GoalStore(cwd).get(goalId)).events![0]!, 'id') as string;
    const target = kind === 'task' ? branch : 'main';
    const originalTarget = git(cwd, ['rev-parse', target]);
    if (kind === 'goal') { configure('auto'); git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]); }
    const update = GoalStore.prototype.update;
    let failed = false;
    const publication = vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
      if (!failed && git(cwd, ['rev-parse', target]) !== originalTarget) {
        failed = true;
        throw new Error('Injected goal failure after Git publication');
      }
      return update.call(this, id, transform);
    });
    const tool = kind === 'task' ? mergeTool : completeTool;
    const input = kind === 'task'
      ? { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha }
      : { operationName: 'complete:acceptance', expectedSha: task.sha, summary };
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, tool, input)).isError).toBe(true);
    }, { goalId, eventId });
    expect(failed).toBe(true);
    const publishedSha = git(cwd, ['rev-parse', target]);
    expectIncluded(task.sha, target);
    publication.mockRestore();
    // 更新済みの参照が人の作業ツリーで checkout されても、保存だけを回復できる。
    git(cwd, ['switch', target]);
    if (kind === 'goal') git(cwd, ['update-ref', `refs/heads/${branch}`, commitFiles(branch, { 'later.txt': 'new goal work\n' })]);
    else git(cwd, ['update-ref', `refs/heads/${task.source}`, commitFiles(task.source, { 'later.txt': 'new result work\n' })]);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, tool, input);
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(git(cwd, ['rev-parse', target])).toBe(publishedSha);
      const saved = await new GoalStore(cwd).get(goalId);
      if (kind === 'task') {
        expect(saved.workUnits?.find((unit) => unit.taskName === task.taskName)?.integration)
          .toMatchObject({ status: 'merged', expectedSha: task.sha, goalSha: publishedSha });
        expect(saved.notifications?.filter(({ kind }) => kind === 'progress')).toHaveLength(1);
      } else {
        expect(saved.status).toBe('completed');
        expect(saved.completion).toMatchObject({ goalSha: task.sha, targetSha: publishedSha, summary,
          changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [{ path: 'result.txt', additions: 1, deletions: 0 }] } });
        expect(saved.notifications?.filter(({ kind }) => kind === 'completed')).toHaveLength(1);
      }
    }, { goalId, eventId });
  });

  it.each(['integrate', 'complete', 'enqueue'] as const)('settles initial %s validation failure, rejects changed arguments and processes the event after a corrected operation', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const store = new GoalStore(cwd);
    const eventId = (await store.get(goalId)).events![0]!.id;
    if (kind === 'complete') git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    await store.update(goalId, (goal) => ({ ...goal, events: goal.events?.map((event) => ({ ...event, processed: false })) }));
    const tool = kind === 'integrate' ? mergeTool : kind === 'complete' ? completeTool : 'takt_enqueue_goal_task';
    const input = kind === 'integrate'
      ? { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha }
      : kind === 'complete' ? { operationName: 'complete:acceptance', expectedSha: task.sha, summary }
        : { operationName: 'work:validation', purpose: '入力検証', task: 'Validate input', workflow: 'safe' };
    const invalid = kind === 'integrate' ? { ...input, taskName: 'unrelated-task' }
      : kind === 'complete' ? { ...input, expectedSha: base } : { ...input, workflow: 'missing' };
    const before = await store.get(goalId);
    const refs = git(cwd, ['show-ref', '--heads']);
    const tasks = new TaskRunner(cwd).listTaskStateItems();
    await withServer(cwd, 'manager', async (client) => {
      const failed = await call(client, tool, invalid);
      expect(failed.isError).toBe(true);
      const settled = await store.get(goalId);
      const { operationName, ...arguments_ } = invalid;
      expect(settled.operations).toEqual([expect.objectContaining({ id: expect.any(String), eventId, operationName,
        tool: kind, status: 'failed', arguments: arguments_,
        result: { status: 'failed', reason: expect.any(String) } })]);
      expect(JSON.parse(firstTextContent(failed.content))).toEqual(settled.operations![0]!.result);
      expect({ ...settled, operations: before.operations }).toEqual(before);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
      const validation = vi.spyOn(goalGit, 'goalGitText');
      expect(await call(client, tool, invalid)).toEqual(failed);
      expect((await call(client, tool, input)).isError).toBe(true);
      expect(validation).not.toHaveBeenCalled();
      validation.mockRestore();
      expect(await store.get(goalId)).toEqual(settled);
      const result = await call(client, tool, { ...input, operationName: `${input.operationName}:corrected` });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const saved = await store.get(goalId);
      expect(saved.operations).toEqual([settled.operations![0], expect.objectContaining({ status: 'completed',
        operationName: `${input.operationName}:corrected`, result: JSON.parse(firstTextContent(result.content)) })]);
    }, { goalId, eventId });
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '修正した操作を確認', summary: null }) }]);
    await managerRecovery.processGoalCompletions(cwd, goalId);
    const processed = await store.get(goalId);
    expect(processed.events![0]).toMatchObject({ processed: true, summary: '修正した操作を確認' });
    expect(processed.operations?.map((operation) => operation.status)).toEqual(['failed', 'completed']);
  });

  it.each(['auto', 'approve', 'checked_out', 'already_included', 'approve_already_included'] as const)('checks the actual side effect before handling a stale completion retry in %s mode', async (mode) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    const includesResult = mode === 'already_included' || mode === 'approve_already_included';
    const mainMerge = mode === 'approve' || mode === 'approve_already_included' ? 'approve' : 'auto';
    configure(mainMerge);
    if (mode === 'checked_out') git(cwd, ['switch', 'main']);
    if (includesResult) git(cwd, ['update-ref', 'refs/heads/main', task.sha]);
    const input = { operationName: 'complete:acceptance', expectedSha: task.sha, summary };
    const refs = git(cwd, ['show-ref', '--heads']);
    const command = goalGit.goalGitText;
    const publication = GoalStore.prototype.update;
    let failed = false;
    const failure = mode === 'auto'
      ? vi.spyOn(goalGit, 'goalGitText').mockImplementation(async (repository, args, signal) => {
        if (!failed && args[0] === 'clone') {
          failed = true;
          throw new Error('Injected failure before Git publication');
        }
        return command(repository, args, signal);
      })
      : vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
        return publication.call(this, id, (current) => {
          const next = transform(current);
          if (!failed && (next.status === 'awaiting_merge' || next.status === 'completed')) {
            failed = true;
            throw new Error('Injected failure before completion publication');
          }
          return next;
        });
      });
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, input)).isError).toBe(true);
    }, { goalId, eventId });
    failure.mockRestore();
    expect(failed).toBe(true);
    expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
    expect((await new GoalStore(cwd).get(goalId)).operations).toEqual([
      expect.objectContaining({ status: 'pending', recovery: { completion: expect.objectContaining({ goalSha: task.sha }),
        mainMerge, beforeSha: includesResult ? task.sha : base } }),
    ]);
    git(cwd, ['update-ref', `refs/heads/${branch}`, commitFiles(branch, { 'later.txt': 'new work\n' })]);
    if (includesResult) git(cwd, ['update-ref', 'refs/heads/main', commitFiles('main', { 'unrelated.txt': 'other work\n' })]);
    const advancedRefs = git(cwd, ['show-ref', '--heads']);
    const pending = await new GoalStore(cwd).get(goalId);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, input);
      if (includesResult) {
        expect(response.isError, firstTextContent(response.content)).toBeUndefined();
        expect(JSON.parse(firstTextContent(response.content))).toMatchObject({ status: 'merged', recorded: true });
      } else {
        expect(response.isError).toBe(true);
        expect(JSON.parse(firstTextContent(response.content))).toMatchObject({ status: 'failed', reason: expect.stringContaining('Reviewed SHA changed') });
        expect(await call(client, completeTool, input)).toEqual(response);
      }
    }, { goalId, eventId });
    expect(git(cwd, ['show-ref', '--heads'])).toBe(advancedRefs);
    const saved = await new GoalStore(cwd).get(goalId);
    if (includesResult) {
      expect(saved).toMatchObject({ status: 'completed', completion: { goalSha: task.sha, summary, targetSha: git(cwd, ['rev-parse', 'main']) } });
      expect(saved.operations![0]).toMatchObject({ status: 'completed' });
      expect(saved.notifications?.filter(({ kind }) => kind === 'completed')).toHaveLength(1);
    } else {
      expect({ ...saved, operations: pending.operations }).toEqual(pending);
      expect(saved.operations).toEqual([{ ...pending.operations![0], status: 'failed', result: {
        status: 'failed', reason: expect.stringContaining('Reviewed SHA changed'),
      } }]);
      expect(saved.status).toBe('created');
      expect(saved.completion).toBeUndefined();
    }
  });

  it.each([
    { mode: 'auto', sameSha: false },
    { mode: 'approve', sameSha: false },
    { mode: 'auto', sameSha: true },
    { mode: 'approve', sameSha: true },
  ] as const)('recovers completion A after B from actual inclusion while preserving B ($mode, same SHA: $sameSha)', async ({ mode, sameSha }) => {
    const task = await saveResult({ 'result.txt': 'reviewed A\n' });
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    configure('auto');
    const inputA = { operationName: 'complete:A', expectedSha: task.sha, summary: 'Evidence A' };
    const originalRefs = git(cwd, ['show-ref', '--heads']);
    const command = goalGit.goalGitText;
    let failed = false;
    const failure = vi.spyOn(goalGit, 'goalGitText').mockImplementation(async (repository, args, signal) => {
      if (!failed && args[0] === 'clone') {
        expect((await new GoalStore(cwd).get(goalId)).operations![0]).toMatchObject({ recovery: { completion: { goalSha: task.sha } } });
        failed = true;
        throw new Error('Injected failure before Git publication');
      }
      return command(repository, args, signal);
    });
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, inputA);
      expect(response.isError).toBe(true);
      expect(failed, firstTextContent(response.content)).toBe(true);
    }, { goalId, eventId });
    failure.mockRestore();
    expect(failed).toBe(true);
    expect(git(cwd, ['show-ref', '--heads'])).toBe(originalRefs);
    const pendingA = (await new GoalStore(cwd).get(goalId)).operations![0]!;
    expect(pendingA).toMatchObject({ operationName: inputA.operationName, status: 'pending', recovery: { completion: { goalSha: task.sha } } });

    const shaB = sameSha ? task.sha : commitFiles(branch, { 'result.txt': 'reviewed B\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, shaB]);
    configure(mode);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, { operationName: 'complete:B', expectedSha: shaB, summary: 'Evidence B' });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
    }, { goalId, eventId });
    const completedB = await new GoalStore(cwd).get(goalId);
    expect(completedB).toMatchObject({ status: mode === 'auto' ? 'completed' : 'awaiting_merge', completion: { goalSha: shaB, summary: 'Evidence B' } });
    const refsB = git(cwd, ['show-ref', '--heads']);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, inputA);
      if (sameSha) {
        expect(response.isError, firstTextContent(response.content)).toBeUndefined();
        expect(JSON.parse(firstTextContent(response.content))).toEqual({ status: completedB.status, completion: completedB.completion, recorded: true });
      } else if (mode === 'auto') {
        expect(response.isError, firstTextContent(response.content)).toBeUndefined();
        expect(JSON.parse(firstTextContent(response.content))).toEqual({ status: 'merged', sha: git(cwd, ['rev-parse', 'main']),
          completion: pendingA.recovery!.completion, recorded: true });
      } else expect(response.isError).toBe(true);
    }, { goalId, eventId });
    const recovered = await new GoalStore(cwd).get(goalId);
    expect(git(cwd, ['show-ref', '--heads'])).toBe(refsB);
    if (sameSha) {
      expect(recovered.operations![0]).toMatchObject({ ...pendingA, status: 'completed', result: { status: completedB.status, completion: completedB.completion, recorded: true } });
      expect({ ...recovered, operations: completedB.operations }).toEqual(completedB);
    } else if (mode === 'auto') {
      expectIncluded(task.sha, 'main');
      expect(recovered.operations).toEqual([{ ...pendingA, status: 'completed', result: { status: 'merged',
        sha: git(cwd, ['rev-parse', 'main']), completion: pendingA.recovery!.completion, recorded: true } }, completedB.operations![1]]);
      expect({ ...recovered, operations: completedB.operations }).toEqual(completedB);
    } else {
      expect({ ...recovered, operations: completedB.operations }).toEqual(completedB);
      expect(recovered.operations).toEqual([{ ...pendingA, status: 'failed', result: {
        status: 'failed', reason: `Reviewed SHA changed: expected ${task.sha}, current ${shaB}`,
      } }, completedB.operations![1]]);
    }
  });

  async function interruptBeforeEffect(tool: string, input: Record<string, unknown>, eventId: string): Promise<void> {
    const update = GoalStore.prototype.update;
    let interrupted = false;
    const publication = vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
      const saved = await update.call(this, id, transform);
      if (!interrupted && saved.operations?.some((operation) => operation.status === 'pending')) {
        interrupted = true;
        throw new Error('Injected interruption after the operation record and before its effect');
      }
      return saved;
    });
    try {
      await withServer(cwd, 'manager', async (client) => {
        const response = await call(client, tool, input);
        expect(response.isError).toBe(true);
        expect(interrupted, firstTextContent(response.content)).toBe(true);
      }, { goalId, eventId });
      expect(interrupted).toBe(true);
      expect((await new GoalStore(cwd).get(goalId)).operations).toEqual([
        expect.objectContaining({ status: 'pending', operationName: input.operationName }),
      ]);
    } finally { publication.mockRestore(); }
  }

  it.each(['integrate', 'complete'] as const)('revalidates and retries %s against an advanced target when the reviewed source is unchanged', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    if (kind === 'complete') { configure('auto'); git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]); }
    const target = kind === 'integrate' ? branch : 'main';
    const source = kind === 'integrate' ? task.source : branch;
    const originalTarget = git(cwd, ['rev-parse', target]);
    const tool = kind === 'integrate' ? mergeTool : completeTool;
    const input = kind === 'integrate' ? { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha }
      : { operationName: 'complete:acceptance', expectedSha: task.sha, summary };
    await interruptBeforeEffect(tool, input, eventId);
    expect(git(cwd, ['rev-parse', target])).toBe(originalTarget);
    const advancedTarget = commitFiles(target, { 'unrelated.txt': 'independent target update\n' });
    git(cwd, ['update-ref', `refs/heads/${target}`, advancedTarget]);
    expect(() => git(cwd, ['merge-base', '--is-ancestor', task.sha, target])).toThrow();
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, tool, input);
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      expect(JSON.parse(firstTextContent(response.content))).toMatchObject({ status: 'merged', recorded: true });
      expect(await call(client, tool, input)).toEqual(response);
    }, { goalId, eventId });
    expectIncluded(task.sha, target);
    expectIncluded(advancedTarget, target);
    expect(git(cwd, ['rev-parse', source])).toBe(task.sha);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.operations).toEqual([expect.objectContaining({ status: 'completed', recovery: expect.objectContaining({ beforeSha: advancedTarget }) })]);
    if (kind === 'integrate') {
      expect(saved.workUnits![0]!.integration).toMatchObject({ status: 'merged', expectedSha: task.sha, goalSha: git(cwd, ['rev-parse', target]) });
    } else expect(saved).toMatchObject({ status: 'completed', completion: { goalSha: task.sha, targetSha: git(cwd, ['rev-parse', target]), summary } });
  });

  it('revalidates and enqueues pending work when its task was never saved', async () => {
    const task = await saveResult({ 'result.txt': 'trigger\n' });
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    const input = { operationName: 'work:validation', workKey: 'validation', purpose: '入力検証', task: 'Validate input', workflow: 'safe' };
    const tasks = new TaskRunner(cwd).listTaskStateItems();
    await interruptBeforeEffect('takt_enqueue_goal_task', input, eventId);
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, 'takt_enqueue_goal_task', input);
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      expect(await call(client, 'takt_enqueue_goal_task', input)).toEqual(response);
      const created = JSON.parse(firstTextContent(response.content));
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.workUnits).toEqual([
        { taskName: task.taskName, purpose: '成果を確認する' },
        { taskName: created.taskName, purpose: input.purpose, workKey: input.workKey },
      ]);
      expect(saved.operations).toEqual([expect.objectContaining({ status: 'completed', result: created })]);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([
        ...tasks, expect.objectContaining({ name: created.taskName, goalOperationId: saved.operations![0]!.id, status: 'pending' }),
      ]);
    }, { goalId, eventId });
  });

  it.each(['integrate', 'complete', 'enqueue'] as const)('settles failed pending %s validation, reports its reason in the next turn and allows event processing', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed result\n' });
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    if (kind === 'complete') { configure('auto'); git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]); }
    const tool = kind === 'integrate' ? mergeTool : kind === 'complete' ? completeTool : 'takt_enqueue_goal_task';
    const input = kind === 'integrate' ? { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha }
      : kind === 'complete' ? { operationName: 'complete:acceptance', expectedSha: task.sha, summary }
        : { operationName: 'work:validation', workKey: 'validation', purpose: '入力検証', task: 'Validate input', workflow: 'safe' };
    await interruptBeforeEffect(tool, input, eventId);
    if (kind === 'enqueue') {
      writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), [
        'name: safe', 'initial_step: work', 'steps:', '  - name: work', '    kind: system',
        '    effects: [{type: close_pr, pr: 1}]', '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n'));
    } else {
      const source = kind === 'integrate' ? task.source : branch;
      const target = kind === 'integrate' ? branch : 'main';
      git(cwd, ['update-ref', `refs/heads/${source}`, commitFiles(source, { 'later.txt': 'unreviewed source update\n' })]);
      git(cwd, ['update-ref', `refs/heads/${target}`, commitFiles(target, { 'unrelated.txt': 'independent target update\n' })]);
    }
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: goal.events?.map((event) => ({ ...event, processed: false })) }));
    const pending = await new GoalStore(cwd).get(goalId);
    const refs = git(cwd, ['show-ref', '--heads']);
    const tasks = new TaskRunner(cwd).listTaskStateItems();
    const setup = MockProvider.prototype.setup;
    const responses: Awaited<ReturnType<Client['callTool']>>[] = [];
    const prompts: string[] = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        prompts.push(prompt);
        const context = JSON.parse(prompt) as { event: { id: string }; goal: Pick<Goal, 'operations'> };
        expect(options.sessionId).toBeUndefined();
        if (context.event.id === eventId) {
          expect(context.goal.operations).toEqual(pending.operations);
          const server = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME]!;
          if (server.type !== 'stdio') throw new Error('Expected the manager stdio server');
          const owners = JSON.parse(server.env![GOAL_TURN_OWNERS_ENV]!) as GoalTurnOwners;
          const response = await withServer(cwd, 'manager', (client) => call(client, tool, input), { goalId, eventId }, owners);
          expect(response.isError).toBe(true);
          expect(JSON.parse(firstTextContent(response.content))).toEqual({ status: 'failed',
            reason: expect.stringContaining(kind === 'enqueue' ? 'workflows' : 'Reviewed SHA changed') });
          responses.push(response);
        } else {
          expect(context.goal.operations).toEqual([
            { ...pending.operations![0], status: 'failed', result: JSON.parse(firstTextContent(responses[0]!.content)) },
          ]);
        }
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '失敗理由を確認', summary: null }) }]);
        return agent.call(prompt, options);
      } };
    });
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      const failed = await new GoalStore(cwd).get(goalId);
      expect(failed.events![0]).toMatchObject({ processed: true, summary: '失敗理由を確認' });
      expect(failed.operations).toEqual([{ ...pending.operations![0], status: 'failed', result: JSON.parse(firstTextContent(responses[0]!.content)) }]);
      expect({ ...failed, events: pending.events, operations: pending.operations }).toEqual(pending);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
      await withServer(cwd, 'manager', async (client) => {
        expect(await call(client, tool, input)).toEqual(responses[0]);
        const changed = kind === 'enqueue' ? { ...input, task: 'different' } : { ...input, expectedSha: base };
        expect((await call(client, tool, changed)).isError).toBe(true);
      }, { goalId, eventId });
      expect(await new GoalStore(cwd).get(goalId)).toEqual(failed);
      await recordGoalCompletion(cwd, goalId, { taskName: task.taskName, runSlug: 'next-run', result: { success: true, interrupted: false } });
      await managerRecovery.processGoalCompletions(cwd, goalId);
      expect(prompts).toHaveLength(2);
      expect((await new GoalStore(cwd).get(goalId)).events!.every((event) => event.processed)).toBe(true);
    } finally { resetScenario(); }
  }, 30_000);

  it.each(['integrate', 'enqueue'] as const)('keeps the event pending after %s publication fails even when the provider returns done, then recovers the same operation', async (kind) => {
    const task = kind === 'integrate' ? await saveResult({ 'result.txt': 'reviewed result\n' }) : undefined;
    if (task === undefined) await recordGoalCompletion(cwd, goalId, {
      taskName: 'trigger', runSlug: 'trigger-run', result: { success: true, interrupted: false },
    });
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: goal.events?.map((event) => ({ ...event, processed: false })) }));
    const eventId = (await new GoalStore(cwd).get(goalId)).events![0]!.id;
    const tool = kind === 'integrate' ? mergeTool : 'takt_enqueue_goal_task';
    const argumentsToSave = task === undefined
      ? { operationName: 'work:validation', workKey: 'validation', purpose: '入力を検証する', task: 'Validate input', workflow: 'safe' }
      : { operationName: 'merge:result', taskName: task.taskName, expectedSha: task.sha };
    const update = GoalStore.prototype.update;
    let failed = false;
    vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
      return update.call(this, id, (current) => {
        const next = transform(current);
        if (!failed && next.operations?.some((operation) => operation.operationName === argumentsToSave.operationName && operation.status === 'completed')) {
          failed = true;
          throw new Error('Injected goal failure after side effect publication');
        }
        return next;
      });
    });
    const setup = MockProvider.prototype.setup;
    const prompts: string[] = [];
    const responses: string[] = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        prompts.push(prompt);
        const input = JSON.parse(prompt) as { event: { id: string }; goal: Pick<Goal, 'operations'> };
        const previous = input.goal.operations?.[0];
        expect(options.sessionId).toBeUndefined();
        expect(input.event.id).toBe(eventId);
        const server = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME]!;
        if (server.type !== 'stdio') throw new Error('Expected the manager stdio server');
        const owners = JSON.parse(server.env![GOAL_TURN_OWNERS_ENV]!) as GoalTurnOwners;
        const args = previous === undefined ? argumentsToSave : { ...previous.arguments, operationName: previous.operationName };
        if (previous !== undefined) expect(previous).toMatchObject({ eventId, status: 'pending', operationName: argumentsToSave.operationName });
        const response = await withServer(cwd, 'manager', (client) => call(client, tool, args), { goalId, eventId }, owners);
        if (previous === undefined) {
          expect(response.isError).toBe(true);
          expect(failed, firstTextContent(response.content)).toBe(true);
        } else expect(response.isError, firstTextContent(response.content)).toBeUndefined();
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '保存操作から復旧', summary: null }) }]);
        const reply = await agent.call(prompt, options);
        responses.push(reply.status);
        return reply;
      } };
    });
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      expect(failed).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(responses).toEqual(['done']);
      const pending = await new GoalStore(cwd).get(goalId);
      expect(pending.events![0]!.processed).toBe(false);
      expect(pending.events![0]).not.toHaveProperty('summary');
      expect(pending.operations).toEqual([expect.objectContaining({ eventId, status: 'pending', operationName: argumentsToSave.operationName })]);
      const publishedSha = git(cwd, ['rev-parse', branch]);
      const tasks = new TaskRunner(cwd).listTaskStateItems();
      expect(tasks).toHaveLength(1);
      if (task === undefined) {
        expect(pending.workUnits ?? []).toEqual([]);
        expect(tasks[0]!.goalOperationId).toBe(pending.operations![0]!.id);
      } else {
        expectIncluded(task.sha, branch);
        expect(pending.workUnits![0]!.integration).toBeUndefined();
      }

      await managerRecovery.recoverManagerEvents(cwd);

      expect(prompts).toHaveLength(2);
      expect(responses).toEqual(['done', 'done']);
      expect(JSON.parse(prompts[1]!).goal.operations).toEqual(pending.operations);
      const recovered = await new GoalStore(cwd).get(goalId);
      expect(recovered.events![0]).toMatchObject({ processed: true, summary: '保存操作から復旧' });
      expect(recovered.operations).toEqual([expect.objectContaining({ id: pending.operations![0]!.id, status: 'completed' })]);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
      expect(git(cwd, ['rev-parse', branch])).toBe(publishedSha);
      if (task === undefined) {
        expect(recovered.workUnits).toEqual([expect.objectContaining({ taskName: tasks[0]!.name, purpose: argumentsToSave.purpose })]);
        expect(recovered.operations![0]!.result).toMatchObject({ taskName: tasks[0]!.name });
      } else {
        expect(recovered.workUnits![0]!.integration).toMatchObject({ status: 'merged', expectedSha: task.sha, goalSha: publishedSha });
        expect(recovered.operations![0]!.result).toMatchObject({ status: 'merged', sha: publishedSha, recorded: true });
        expect(recovered.notifications?.filter((notification) => notification.kind === 'progress')).toHaveLength(1);
      }
    } finally { resetScenario(); }
  }, 30_000);

  it.each([false, true])('merges a reviewed task and persists its source and resulting goal SHA while preserving human files and saved events (cleanup failure: %s)', async (cleanupFailure) => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    const goalProgress = commitFiles(branch, { 'goal-progress.txt': 'retained\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, goalProgress]);
    const before = await new GoalStore(cwd).get(goalId);
    dirtyHumanTree();
    const human = humanSnapshot();
    observeCleanup(cleanupFailure);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const merged = git(cwd, ['rev-parse', branch]);
      const data = JSON.parse(firstTextContent(result.content));
      expect(data).toMatchObject({ status: 'merged', sha: merged, recorded: true });
      expectIncluded(task.sha, branch);
      expectIncluded(goalProgress, branch);
      if (cleanupFailure) {
        const clone = join(temporaryDirectories[0]!, 'repository');
        expect(readFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(join(cwd, '.git', 'objects'));
        expect(existsSync(join(clone, '.git', 'objects', task.sha.slice(0, 2), task.sha.slice(2)))).toBe(false);
      }
      expect(git(cwd, ['show', `${branch}:result.txt`])).toBe('result');
      expect(git(cwd, ['show', `${branch}:goal-progress.txt`])).toBe('retained');
      const saved = await new GoalStore(cwd).get(goalId);
      expect(data.goal).toEqual(saved);
      expect(saved.workUnits?.find((unit) => unit.taskName === task.taskName)?.integration).toMatchObject({ status: 'merged', goalSha: merged, expectedSha: task.sha, sourceBranch: task.source });
      const record = JSON.stringify(saved.workUnits?.find((unit) => unit.taskName === task.taskName));
      expect(record).toContain(task.sha);
      expect(record).toContain(task.source);
      expect(record).toContain(merged);
      expect(saved.workUnits?.find((unit) => unit.taskName === task.taskName)?.purpose).toBe('成果を確認する');
      expect(saved.events).toEqual(before.events);
      expect(humanSnapshot()).toEqual(human);
      expect(temporaryDirectories).toHaveLength(1);
      expect(existsSync(temporaryDirectories[0]!)).toBe(cleanupFailure);
    });
  });

  it.each(['other goal', 'ordinary task'])('rejects a result owned by %s without changing either goal branch', async (ownership) => {
    const otherId = '650e8400-e29b-41d4-a716-446655440001';
    const other = await registerFixtureGoal(cwd, { id: otherId });
    const task = await saveResult({ 'result.txt': 'foreign\n' }, ownership === 'other goal' ? otherId : null);
    const refs = git(cwd, ['show-ref', '--heads']);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBe(true);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(git(cwd, ['rev-parse', other.branch])).toBe(base);
    });
  });

  it('rejects another goal branch even if the task itself names the requested goal', async () => {
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    const task = await saveResult({ 'foreign.txt': 'other goal\n' }, goalId, true, other.branch);
    const refs = git(cwd, ['show-ref', '--heads']);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBe(true);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
    });
  });

  it('does not permit a caller to redirect integration into another goal branch', async () => {
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    const task = await saveResult({ 'result.txt': 'owned\n' });
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha, targetBranch: other.branch });
      if (result.isError !== true) expectIncluded(task.sha, branch);
      expect(git(cwd, ['rev-parse', other.branch])).toBe(base);
    });
  });

  it('leaves business acceptance to the manager even when a task reports failure', async () => {
    const task = await saveResult({ 'useful.txt': 'reviewed partial result\n' }, goalId, false);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBeUndefined();
      expectIncluded(task.sha, branch);
    });
  });

  it.each(['task', 'goal'])('rejects a stale reviewed %s SHA before changing references or completion state', async (kind) => {
    const task = await saveResult({ 'result.txt': 'reviewed\n' });
    const source = kind === 'task' ? task.source : branch;
    const reviewed = git(cwd, ['rev-parse', source]);
    git(cwd, ['update-ref', `refs/heads/${source}`, commitFiles(source, { 'later.txt': 'changed\n' })]);
    configure('auto');
    const refs = git(cwd, ['show-ref', '--heads']);
    const saved = await new GoalStore(cwd).get(goalId);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, kind === 'task' ? mergeTool : completeTool,
        kind === 'task' ? { taskName: task.taskName, expectedSha: reviewed } : { expectedSha: reviewed, summary });
      expect(result.isError).toBe(true);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
    });
  });

  it.each(['root', 'linked'])('refuses a checked-out goal branch in the %s worktree and reports its location', async (location) => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    const directory = location === 'root' ? cwd : join(cwd, 'linked goal');
    if (location === 'root') git(cwd, ['switch', branch]);
    else git(cwd, ['worktree', 'add', directory, branch]);
    dirtyHumanTree(directory);
    const human = humanSnapshot(directory);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha });
      expect(firstTextContent(result.content)).toContain(directory);
      expect(git(cwd, ['rev-parse', branch])).toBe(base);
      expect(humanSnapshot(directory)).toEqual(human);
    });
  });

  it.each([
    { kind: 'task', location: 'root', cleanupFailure: false }, { kind: 'task', location: 'root', cleanupFailure: true },
    { kind: 'task', location: 'linked', cleanupFailure: false }, { kind: 'task', location: 'linked', cleanupFailure: true },
    { kind: 'main', location: 'root', cleanupFailure: false }, { kind: 'main', location: 'root', cleanupFailure: true },
    { kind: 'main', location: 'linked', cleanupFailure: false }, { kind: 'main', location: 'linked', cleanupFailure: true },
  ])('preserves a $kind target checked out in the $location worktree after the isolated merge (cleanup failure: $cleanupFailure)', async ({ kind, location, cleanupFailure }) => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    const target = kind === 'task' ? branch : 'main';
    if (kind === 'main') git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    configure('auto');
    const directory = location === 'root' ? cwd : join(cwd, 'late checkout');
    if (location === 'linked') git(cwd, ['worktree', 'add', '--detach', directory, base]);
    const text = goalGit.goalGitText;
    const snapshots: ReturnType<typeof humanSnapshot>[] = [];
    vi.spyOn(goalGit, 'goalGitText').mockImplementation(async (repository, args, signal) => {
      const result = await text(repository, args, signal);
      if (repository === cwd && args[0] === 'fetch' && args[4] !== cwd) {
        git(directory, ['switch', target]);
        dirtyHumanTree(directory);
        snapshots.push(humanSnapshot(directory));
      }
      return result;
    });
    observeCleanup(cleanupFailure);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, kind === 'task' ? mergeTool : completeTool,
        kind === 'task' ? { taskName: task.taskName, expectedSha: task.sha } : { expectedSha: task.sha, summary });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(snapshots).toHaveLength(1);
      expect(humanSnapshot(directory)).toEqual(snapshots[0]);
      expect(git(cwd, ['rev-parse', target])).toBe(base);
      expect(temporaryDirectories).toHaveLength(1);
      expect(existsSync(temporaryDirectories[0]!)).toBe(cleanupFailure);
      const data = JSON.parse(firstTextContent(result.content));
      const saved = await new GoalStore(cwd).get(goalId);
      expect(data).toMatchObject({ recorded: true, goal: saved });
      if (kind === 'task') {
        expect(data).toMatchObject({ status: 'checked_out', worktrees: [directory] });
        expect(saved.status).toBe('created');
        expect(saved.workUnits?.find((unit) => unit.taskName === task.taskName)?.integration).toMatchObject({ status: 'checked_out', worktrees: [directory], expectedSha: task.sha });
      } else {
        expect(data.status).toBe('awaiting_merge');
        expect(saved.status).toBe('awaiting_merge');
        expect(data.completion).toEqual(saved.completion);
        expect(saved.completion).toMatchObject({ goalBranch: branch, goalSha: task.sha, targetBranch: 'main', summary, worktrees: [directory], reason: expect.any(String) });
        expect(saved.completion!.reason!.length).toBeGreaterThan(0);
        expect(saved.completion!.instructions).toEqual(expect.arrayContaining([expect.stringContaining('git -C'), expect.stringContaining(task.sha)]));
      }
    });
  });

  it('does not confuse detached paths or similarly named worktree branches with the destination reference', async () => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    const directory = join(cwd, `branch refs/heads/${branch}\nlocked`);
    git(cwd, ['worktree', 'add', '--detach', directory, base]);
    git(cwd, ['worktree', 'lock', '--reason', branch, directory]);
    const missing = join(cwd, `prunable ${branch}`);
    git(cwd, ['worktree', 'add', '--detach', missing, base]);
    rmSync(missing, { recursive: true, force: true });
    const copy = `${branch}-copy`;
    git(cwd, ['branch', copy, base]);
    git(cwd, ['worktree', 'add', join(cwd, 'other'), copy]);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBeUndefined();
      expectIncluded(task.sha, branch);
      expect(git(cwd, ['rev-parse', copy])).toBe(base);
      expect(git(directory, ['rev-parse', 'HEAD'])).toBe(base);
    });
  });

  it.each([
    { kind: 'task', cleanupFailure: false }, { kind: 'task', cleanupFailure: true },
    { kind: 'main', cleanupFailure: false }, { kind: 'main', cleanupFailure: true },
  ])('aborts a conflicting $kind merge and preserves target references and the dirty human tree (cleanup failure: $cleanupFailure)', async ({ kind, cleanupFailure }) => {
    const task = await saveResult({ 'tracked.txt': 'source\n' });
    const target = kind === 'task' ? branch : 'main';
    if (kind === 'main') git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    const original = commitFiles(base, { 'tracked.txt': 'destination\n' });
    git(cwd, ['update-ref', `refs/heads/${target}`, original]);
    configure('auto');
    dirtyHumanTree();
    const human = humanSnapshot();
    const before = await new GoalStore(cwd).get(goalId);
    observeCleanup(cleanupFailure);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, kind === 'task' ? mergeTool : completeTool,
        kind === 'task' ? { taskName: task.taskName, expectedSha: task.sha } : { expectedSha: task.sha, summary });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const data = JSON.parse(firstTextContent(result.content));
      expect(data).toMatchObject({ status: 'conflict', conflicts: ['tracked.txt'] });
      expect(git(cwd, ['rev-parse', target])).toBe(original);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).toBe('created');
      if (kind === 'task') {
        expect(data).toMatchObject({ recorded: true, goal: saved });
        expect(saved.workUnits?.find((unit) => unit.taskName === task.taskName)?.integration).toMatchObject({ status: 'conflict', conflicts: ['tracked.txt'], expectedSha: task.sha });
      } else expect(saved).toEqual(before);
      expect(temporaryDirectories).toHaveLength(1);
      expect(existsSync(temporaryDirectories[0]!)).toBe(cleanupFailure);
      expect(existsSync(join(temporaryDirectories[0]!, 'repository', '.git', 'MERGE_HEAD'))).toBe(false);
      if (cleanupFailure) {
        const clone = join(temporaryDirectories[0]!, 'repository');
        expect(git(clone, ['rev-parse', 'HEAD'])).toBe(original);
        expect(git(clone, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
      }
      expect(humanSnapshot()).toEqual(human);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
      git(cwd, ['update-ref', `refs/heads/${target}`, base]);
      const retried = await call(client, kind === 'task' ? mergeTool : completeTool,
        kind === 'task' ? { taskName: task.taskName, expectedSha: task.sha } : { expectedSha: task.sha, summary });
      expect(retried.isError).toBeUndefined();
      expectIncluded(task.sha, target);
      expect(humanSnapshot()).toEqual(human);
    });
  });

  it('serializes integration with another write to the same goal', async () => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = withGoalTurns(cwd, [goalId], async () => { entered(); await gate; });
    await held;
    try {
      await withServer(cwd, 'manager', async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(mergeTool);
        let finished = false;
        const merging = client.callTool({ name: mergeTool, arguments: { cwd, goalId, taskName: task.taskName, expectedSha: task.sha } }).then((result) => { finished = true; return result; });
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 80));
          expect(finished).toBe(false);
          expect(git(cwd, ['rev-parse', branch])).toBe(base);
        } finally { release(); await lock; }
        expect((await merging).isError).toBeUndefined();
        expectIncluded(task.sha, branch);
      });
    } finally { release(); await lock; }
  });

  it.each([false, true])('merges into the saved integration branch despite changed base branch configuration and rejects further enqueue (cleanup failure: %s)', async (cleanupFailure) => {
    configure('auto', 'release');
    const sha = commitFiles(branch, { 'result.txt': 'ready\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    dirtyHumanTree();
    const human = humanSnapshot();
    observeCleanup(cleanupFailure);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, completeTool, { expectedSha: sha, summary });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expectIncluded(sha, 'main');
      expect(git(cwd, ['rev-parse', 'release'])).toBe(base);
      const saved = await new GoalStore(cwd).get(goalId);
      const targetSha = git(cwd, ['rev-parse', 'main']);
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'merged', sha: targetSha, recorded: true, goal: saved, completion: { goalBranch: branch, goalSha: sha, targetBranch: 'main', summary } });
      expect(saved.status).toBe('completed');
      expect(saved.completion).toMatchObject({ targetSha, goalSha: sha, summary });
      expect(temporaryDirectories).toHaveLength(1);
      expect(existsSync(temporaryDirectories[0]!)).toBe(cleanupFailure);
      expect(JSON.stringify(saved)).toContain(summary);
      expect(humanSnapshot()).toEqual(human);
      expect((await call(client, 'takt_enqueue_goal_task', { task: 'new work', purpose: 'new work', workflow: 'safe' })).isError).toBe(true);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
    });
  });

  it.each(['approve', 'default', 'auto root', 'auto linked'])('records human merge instructions without moving references for %s', async (mode) => {
    configure(mode.startsWith('auto') ? 'auto' : mode === 'default' ? undefined : 'approve');
    const sha = commitFiles(branch, { 'result.txt': 'ready\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    const directory = mode === 'auto linked' ? join(cwd, 'human main') : cwd;
    if (mode === 'auto root') git(cwd, ['switch', 'main']);
    if (mode === 'auto linked') git(cwd, ['worktree', 'add', directory, 'main']);
    dirtyHumanTree(directory);
    const human = humanSnapshot(directory);
    const refs = git(cwd, ['show-ref', '--heads']);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, completeTool, { expectedSha: sha, summary });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).not.toBe('created');
      expect(saved.status).not.toBe('completed');
      for (const text of [JSON.stringify(saved), firstTextContent(result.content)]) {
        for (const value of [branch, sha, 'main', summary]) expect(text).toContain(value);
        expect(text).toMatch(/git[^\n]*merge/);
        if (mode.startsWith('auto')) expect(text).toContain(directory);
      }
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(humanSnapshot(directory)).toEqual(human);
    });
  });

  it.each([
    { mode: 'auto', location: 'linked' },
    { mode: 'approve', location: 'linked' },
    { mode: 'approve', location: 'root' },
  ] as const)('executes the returned human merge commands in the $location target worktree in $mode mode', async ({ mode, location }) => {
    configure(mode);
    const sha = commitFiles(branch, { 'result.txt': 'ready\n', 'src/a.ts': 'new one\nnew two\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    const directory = location === 'linked' ? join(cwd, "human's main tree") : cwd;
    if (location === 'linked') git(cwd, ['worktree', 'add', directory, 'main']);
    else git(cwd, ['switch', 'main']);
    const originalBranch = git(cwd, ['symbolic-ref', 'HEAD']);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, { expectedSha: sha, summary });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      const saved = await new GoalStore(cwd).get(goalId);
      const completion = saved.completion!;
      expect(JSON.parse(firstTextContent(response.content))).toMatchObject({ completion });
      expect(completion.worktrees).toEqual([directory]);
      expect(completion.summary).toBe(summary);
      expect(completion.changeSummary).toEqual({
        filesChanged: 2, additions: 3, deletions: 1,
        files: [{ path: 'result.txt', additions: 1, deletions: 0 }, { path: 'src/a.ts', additions: 2, deletions: 1 }],
        truncated: false, totalsTruncated: false,
      });
      expect(completion.instructions).toHaveLength(2);
      for (const command of completion.instructions) {
        execFileSync('/bin/sh', ['-c', command], {
          cwd, stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
            GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
          },
        });
      }
      expect(git(cwd, ['symbolic-ref', 'HEAD'])).toBe(originalBranch);
      expect(git(directory, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(readFileSync(join(directory, 'result.txt'), 'utf8')).toBe('ready\n');
      expectIncluded(sha, 'main');
      expect((await call(client, checkTool)).isError).toBeUndefined();
      expect((await new GoalStore(cwd).get(goalId)).completion?.changeSummary).toEqual(completion.changeSummary);
      expect((await new GoalStore(cwd).get(goalId)).status).toBe('completed');
    });
  });

  it.each(['auto', 'approve'] as const)('persists and returns only goal-side changes when main diverges in %s mode', async (mode) => {
    configure(mode);
    const sha = commitFiles(branch, { 'goal-only.txt': 'goal change\n' });
    const mainSha = commitFiles('main', { 'main-only.txt': 'main change\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    git(cwd, ['update-ref', 'refs/heads/main', mainSha]);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, { expectedSha: sha, summary });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      const saved = await new GoalStore(cwd).get(goalId);
      const changeSummary = {
        filesChanged: 1, additions: 1, deletions: 0,
        files: [{ path: 'goal-only.txt', additions: 1, deletions: 0 }],
        truncated: false, totalsTruncated: false,
      };
      expect(saved.completion?.changeSummary).toEqual(changeSummary);
      expect(JSON.parse(firstTextContent(response.content))).toMatchObject({
        recorded: true, goal: saved, completion: { changeSummary },
      });
      expect(saved.status).toBe(mode === 'auto' ? 'completed' : 'awaiting_merge');
      if (mode === 'auto') {
        expectIncluded(sha, 'main');
        expect(git(cwd, ['show', 'main:goal-only.txt'])).toBe('goal change');
      } else expect(git(cwd, ['rev-parse', 'main'])).toBe(mainSha);
      expect(git(cwd, ['show', 'main:main-only.txt'])).toBe('main change');
    });
  });

  it.each([false, true])('persists and returns a bounded change summary in approve mode (long paths: %s)', async (longPaths) => {
    const count = 60;
    const files = Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `files/${String(index).padStart(3, '0')}-${'x'.repeat(longPaths ? 80 : 0)}.txt`, 'one\ntwo\n',
    ]));
    const sha = commitFiles(branch, files);
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, completeTool, { expectedSha: sha, summary });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      const completion = (await new GoalStore(cwd).get(goalId)).completion!;
      expect(JSON.parse(firstTextContent(response.content))).toMatchObject({ completion });
      expect(completion.summary).toBe(summary);
      expect(completion.changeSummary.truncated).toBe(true);
      expect(completion.changeSummary.files.length).toBeLessThanOrEqual(50);
      if (!longPaths) {
        expect(completion.changeSummary).toMatchObject({ filesChanged: 60, additions: 120, deletions: 0, totalsTruncated: false });
        expect(completion.changeSummary.files).toHaveLength(50);
      } else {
        expect(completion.changeSummary.totalsTruncated).toBe(true);
        expect(completion.changeSummary.filesChanged).toBeLessThan(count);
        expect(Buffer.byteLength(JSON.stringify(completion.changeSummary))).toBeLessThan(8192);
      }
      expect(git(cwd, ['rev-parse', 'main'])).toBe(base);
      expect(completion.worktrees).toBeUndefined();
      expect(completion.instructions.slice(1)).toEqual([
        'git status --short', "git switch 'main'", `git merge --no-ff --no-edit '${sha}'`,
      ]);
    });
  });

  it('completes only after the saved approval SHA is included even when the goal branch advances', async () => {
    const sha = commitFiles(branch, { 'result.txt': 'approved\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      await call(client, checkTool);
      expect((await new GoalStore(cwd).get(goalId)).status).not.toBe('completed');
      const later = commitFiles(branch, { 'later.txt': 'not reviewed\n' });
      git(cwd, ['update-ref', `refs/heads/${branch}`, later]);
      git(cwd, ['update-ref', 'refs/heads/main', sha]);
      expect((await call(client, checkTool)).isError).toBeUndefined();
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).toBe('completed');
      expect(JSON.stringify(saved)).toContain(summary);
      expect(git(cwd, ['rev-parse', branch])).toBe(later);
    });
  });

  it('does not let tool input grant automatic main merge permission', async () => {
    configure(undefined);
    const sha = commitFiles(branch, { 'result.txt': 'requires approval\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, completeTool, { expectedSha: sha, summary, mainMerge: 'auto' });
      expect(git(cwd, ['rev-parse', 'main'])).toBe(base);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).not.toBe('completed');
      if (result.isError !== true) expect(saved.status).not.toBe('created');
    });
  });

  it('returns ordinary file counts and the requested patch', async () => {
    const task = await saveResult({ 'src/a.ts': 'new one\nnew two\n' });
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_get_goal_diff', { taskName: task.taskName, file: 'src/a.ts' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(firstTextContent(result.content));
      expect(data.files).toEqual([expect.objectContaining({ path: 'src/a.ts', additions: 2, deletions: 1 })]);
      expect(data.patch).toContain('-old');
      expect(data.patch).toContain('+new one');
      expect(data.patch).toContain('+new two');
      expect(JSON.stringify(data)).toContain(task.sha);
    });
  });

  it.each(['goal', 'task'] as const)('reports only source-side changes and patches for diverged %s branches', async (kind) => {
    const task = await saveResult({ 'source-only.txt': 'source change\n' });
    const comparisonBranch = kind === 'task' ? branch : 'main';
    if (kind === 'goal') git(cwd, ['update-ref', `refs/heads/${branch}`, task.sha]);
    const comparisonSha = commitFiles(base, { 'comparison-only.txt': 'comparison change\n' });
    git(cwd, ['update-ref', `refs/heads/${comparisonBranch}`, comparisonSha]);
    const selection = kind === 'task' ? { taskName: task.taskName } : {};
    await withServer(cwd, 'manager', async (client) => {
      const response = await call(client, 'takt_get_goal_diff', { ...selection, file: 'source-only.txt' });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      const data = JSON.parse(firstTextContent(response.content));
      expect(data).toMatchObject({ sourceSha: task.sha, comparisonBranch, comparisonSha, truncated: false });
      expect(data.files).toEqual([{ path: 'source-only.txt', additions: 1, deletions: 0 }]);
      expect(data.patch).toContain('+source change');
      const comparison = await call(client, 'takt_get_goal_diff', { ...selection, file: 'comparison-only.txt' });
      expect(comparison.isError, firstTextContent(comparison.content)).toBeUndefined();
      expect(JSON.parse(firstTextContent(comparison.content)).patch).toBe('');
    });
  });

  it('preserves tabs and newlines in changed filenames when returning counts and a literal file patch', async () => {
    const path = 'docs/a\tb\nc.md';
    const task = await saveResult({ [path]: 'literal path\n', 'docs/other.md': 'other\n' });
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_get_goal_diff', { taskName: task.taskName, file: path });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(firstTextContent(result.content));
      expect(data.files).toHaveLength(2);
      expect(data.files).toContainEqual(expect.objectContaining({ path, additions: 1, deletions: 0 }));
      expect(data.patch).toContain('+literal path');
      expect(data.patch).not.toContain('+other');
    });
  });

  it('reports binary line counts as unknown rather than zero', async () => {
    const task = await saveResult({ 'image.bin': Buffer.from([0, 1, 2, 3]) });
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_get_goal_diff', { taskName: task.taskName });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content)).files).toEqual([
        expect.objectContaining({ path: 'image.bin', additions: null, deletions: null }),
      ]);
    });
  });

  it('bounds file lists and large patches and explicitly reports truncation', async () => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`file-${index}.txt`, 'small\n']));
    const task = await saveResult({ ...files, 'large.txt': 'large changed line\n'.repeat(20000) });
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_get_goal_diff', { taskName: task.taskName, file: 'large.txt', limit: 3 });
      expect(result.isError).toBeUndefined();
      const text = firstTextContent(result.content);
      const data = JSON.parse(text);
      expect(data.files.length).toBeLessThanOrEqual(3);
      expect(data.truncated).toBe(true);
      expect(Buffer.byteLength(text)).toBeLessThan(128 * 1024);
      expect(data.patch).toContain('+large changed line');
    });
  });

  it('bounds commit history count and large messages and reports omitted results', async () => {
    let sha = base;
    for (let index = 0; index < 8; index++) sha = git(cwd, ['commit-tree', `${base}^{tree}`, '-p', sha, '-m', `history ${index}\n${'long message '.repeat(10000)}`]);
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_get_goal_history', { limit: 3 });
      expect(result.isError).toBeUndefined();
      const text = firstTextContent(result.content);
      const data = JSON.parse(text);
      expect(data.commits).toHaveLength(3);
      expect(data.commits[0].sha).toBe(sha);
      expect(data.truncated).toBe(true);
      expect(Buffer.byteLength(text)).toBeLessThan(128 * 1024);
    });
  });

  it('compares against the saved integration branch despite changed configuration before and after completion', async () => {
    const first = commitFiles(branch, { 'result.txt': 'ready\n' });
    const sha = commitFiles(first, { 'goal-progress.txt': 'second goal commit\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    git(cwd, ['update-ref', 'refs/heads/main', commitFiles(base, { 'main.txt': 'different\n' })]);
    configure('auto', 'release');
    await withServer(cwd, 'manager', async (client) => {
      const before = await call(client, 'takt_get_goal_relation');
      expect(before.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(before.content))).toMatchObject({ targetBranch: 'main', targetSha: git(cwd, ['rev-parse', 'main']), included: false, ahead: 2 });
      const diff = await call(client, 'takt_get_goal_diff');
      expect(diff.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(diff.content))).toMatchObject({ comparisonBranch: 'main', comparisonSha: git(cwd, ['rev-parse', 'main']) });
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      const after = await call(client, 'takt_get_goal_relation');
      expect(after.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(after.content))).toMatchObject({ included: true, ahead: 0 });
    });
  });
});

async function withServer<T>(
  cwd: string,
  toolSet: 'all' | 'read-only' | 'manager',
  action: (client: Client) => Promise<T>,
  goalEventContext?: { goalId: string; eventId: string },
  goalTurnOwners?: GoalTurnOwners,
): Promise<T> {
  const options = { allowedProjectRoot: cwd, toolSet: toolSet as TaktMcpToolSet,
    ...(goalEventContext === undefined ? {} : { goalEventContext, goalTurnOwners: goalTurnOwners ?? {} }),
  };
  const server = createTaktMcpServer({}, options);
  const client = new Client({ name: 'goal-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain('takt_list_goals');
    expect(names).toContain('takt_get_goal');
    expect(names).not.toContain('takt_create_goal');
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}


describe('persisted goal event operations through manager MCP', () => {
  let cwd: string;
  let eventId: string;
  let initialSha: string;

  beforeEach(async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-event-operations-')));
    ({ mainCommit: initialSha } = initializeRepository(cwd));
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nbranch_name_strategy: romaji\nmanager:\n  auto_run: false\n  main_merge: auto\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), [
      'name: safe', 'max_steps: 2', 'initial_step: work', 'steps:',
      '  - name: work', '    instruction: "{task}"', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    await registerFixtureGoal(cwd);
    await recordGoalCompletion(cwd, goalId, { taskName: 'trigger', runSlug: 'trigger-run', result: { success: true, interrupted: false } });
    eventId = Reflect.get((await new GoalStore(cwd).get(goalId)).events![0]!, 'id') as string;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(crypto.randomUUID).mockReset().mockImplementation(() => crypto.webcrypto.randomUUID());
    rmSync(cwd, { recursive: true, force: true });
    await setImmediate();
  });

  function eventServer<T>(action: (client: Client) => Promise<T>) {
    return withServer(cwd, 'manager', action, { goalId, eventId });
  }

  function call(client: Client, name: string, extra: Record<string, unknown>) {
    return client.callTool({ name, arguments: { cwd, goalId, ...extra } });
  }

  async function successfulCall(client: Client, name: string, extra: Record<string, unknown>) {
    const response = await call(client, name, extra);
    expect(response.isError, firstTextContent(response.content)).toBeUndefined();
    return JSON.parse(firstTextContent(response.content)) as Record<string, unknown>;
  }

  const notice = { operationName: 'notify:progress', kind: 'custom', body: '作業A完了' };
  const work = { operationName: 'work:validation', workKey: 'validation', purpose: '入力を検証する', task: 'Validate input', workflow: 'safe' };

  it('processes the event after settling an invalid workflow and submitting corrected work with a new name', async () => {
    const before = await new GoalStore(cwd).get(goalId);
    const setup = MockProvider.prototype.setup;
    const turns = vi.fn();
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        turns();
        const input = JSON.parse(prompt) as { event: { id: string } };
        expect(input.event.id).toBe(eventId);
        const server = options.mcpServers![TAKT_MANAGER_MCP_SERVER_NAME]!;
        if (server.type !== 'stdio') throw new Error('Expected the manager stdio server');
        const owners = JSON.parse(server.env![GOAL_TURN_OWNERS_ENV]!) as GoalTurnOwners;
        await withServer(cwd, 'manager', async (client) => {
          const invalid = { ...work, workflow: 'missing-workflow' };
          const failed = await call(client, 'takt_enqueue_goal_task', invalid);
          expect(failed.isError).toBe(true);
          const settled = await new GoalStore(cwd).get(goalId);
          expect(settled.operations).toEqual([expect.objectContaining({ status: 'failed', operationName: work.operationName,
            result: JSON.parse(firstTextContent(failed.content)), arguments: expect.objectContaining({ workflow: invalid.workflow }) })]);
          expect({ ...settled, operations: before.operations }).toEqual(before);
          expect(await call(client, 'takt_enqueue_goal_task', invalid)).toEqual(failed);
          expect((await call(client, 'takt_enqueue_goal_task', work)).isError).toBe(true);
          expect(await new GoalStore(cwd).get(goalId)).toEqual(settled);
          expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
          await successfulCall(client, 'takt_enqueue_goal_task', {
            ...work, operationName: 'work:corrected',
          });
        }, { goalId, eventId }, owners);
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '入力を修正して投入済み', summary: null }) }]);
        return agent.call(prompt, options);
      } };
    });
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.events![0]).toMatchObject({ processed: true, summary: '入力を修正して投入済み' });
      expect(saved.operations).toEqual([expect.objectContaining({ status: 'failed', operationName: work.operationName }),
        expect.objectContaining({ status: 'completed', operationName: 'work:corrected', arguments: expect.objectContaining({ workflow: 'safe' }) })]);
      const tasks = new TaskRunner(cwd).listTaskStateItems();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.goalOperationId).toBe(saved.operations![1]!.id);
      await managerRecovery.recoverManagerEvents(cwd);
      expect(turns).toHaveBeenCalledOnce();
      expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
      expect(new TaskRunner(cwd).listTaskStateItems()).toEqual(tasks);
    } finally { resetScenario(); }
  }, 30_000);

  it.each([
    { tool: 'takt_ask_goal_question', invalid: { body: '' }, valid: { body: '形式はどれですか' } },
    { tool: 'takt_notify_goal', invalid: { kind: 'custom', body: '' }, valid: { kind: 'custom', body: '入力を修正した' } },
  ])('rejects malformed $tool input before preparing an operation', async ({ tool, invalid, valid }) => {
    const before = await new GoalStore(cwd).get(goalId);
    const operationName = 'correctable-operation';
    expect((await eventServer((client) => call(client, tool, { operationName, ...invalid }))).isError).toBe(true);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(before);
    const result = await eventServer((client) => successfulCall(client, tool, { operationName, ...valid }));
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.operations).toEqual([expect.objectContaining({ status: 'completed', result })]);
    expect(await eventServer((client) => successfulCall(client, tool, { operationName, ...valid }))).toEqual(result);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
  });

  it.each(['takt_withdraw_goal_question', 'takt_check_goal_completion'])('settles %s precondition failures and requires a new name after correction', async (tool) => {
    const store = new GoalStore(cwd);
    const before = await store.get(goalId);
    const operationName = 'correctable-operation';
    const invalid = tool === 'takt_withdraw_goal_question' ? { questionId: '650e8400-e29b-41d4-a716-446655440001' } : {};
    const failed = await eventServer((client) => call(client, tool, { operationName, ...invalid }));
    expect(failed.isError).toBe(true);
    const settled = await store.get(goalId);
    expect(settled.operations).toEqual([expect.objectContaining({ status: 'failed', operationName,
      arguments: invalid, result: { status: 'failed', reason: expect.any(String) } })]);
    expect({ ...settled, operations: before.operations }).toEqual(before);
    let corrected: Record<string, unknown> = {};
    if (tool === 'takt_withdraw_goal_question') {
      const question = await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', { operationName: 'question:format', body: '形式はどれですか' }));
      corrected = { questionId: question.questionId };
    } else {
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  main_merge: approve\n');
      await eventServer((client) => successfulCall(client, 'takt_complete_goal', { operationName: 'complete:acceptance', expectedSha: initialSha, summary: '確認済み' }));
    }
    const ready = await store.get(goalId);
    expect(await eventServer((client) => call(client, tool, { operationName, ...invalid }))).toEqual(failed);
    if (tool === 'takt_withdraw_goal_question') {
      expect((await eventServer((client) => call(client, tool, { operationName, ...corrected }))).isError).toBe(true);
    }
    expect(await store.get(goalId)).toEqual(ready);
    const result = await eventServer((client) => successfulCall(client, tool, { operationName: 'corrected-operation', ...corrected }));
    const saved = await store.get(goalId);
    expect(saved.operations).toEqual([...ready.operations!, expect.objectContaining({ status: 'completed', operationName: 'corrected-operation', result })]);
    expect(await eventServer((client) => successfulCall(client, tool, { operationName: 'corrected-operation', ...corrected }))).toEqual(result);
    expect(await store.get(goalId)).toEqual(saved);
  });

  function injectSaveFailure(matches: (goal: Goal) => boolean) {
    const goalPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const injected = vi.fn(() => { throw new Error('Injected goal publication failure'); });
    const publish = artifacts.publishPrivateArtifact;
    const spy = vi.spyOn(artifacts, 'publishPrivateArtifact').mockImplementation((...args) => {
      if (args[2] === goalPath && matches(JSON.parse(readFileSync(args[1], 'utf8')) as Goal)) injected();
      return publish(...args);
    });
    return { injected, restore: () => spy.mockRestore() };
  }

  it('preserves saved question state without event context after publication failure', async () => {
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [] }));
    const before = await new GoalStore(cwd).get(goalId);
    const failure = injectSaveFailure((goal) => goal.questions?.length === 1);
    await withServer(cwd, 'manager', async (client) => {
      const result = await call(client, 'takt_ask_goal_question', { body: '形式はどれですか', recipient: 'human' });
      expect(failure.injected).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(await new GoalStore(cwd).get(goalId)).toEqual(before);
    });
  });

  it.each(['pending', 'question'] as const)('preserves question responses and replay after %s publication failure with event context', async (stage) => {
    const input = { operationName: 'question:format', body: '形式はどれですか', recipient: 'human' };
    const failure = injectSaveFailure((goal) => stage === 'pending'
      ? goal.operations?.[0]?.status === 'pending' && (goal.questions?.length ?? 0) === 0
      : goal.operations?.[0]?.status === 'completed' && goal.questions?.length === 1);
    const first = await eventServer((client) => call(client, 'takt_ask_goal_question', input));
    expect(failure.injected).toHaveBeenCalledTimes(1);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(first.isError).toBe(true);
    expect(saved.questions ?? []).toEqual([]);
    expect(saved.operations ?? []).toEqual(stage === 'pending' ? [] : [expect.objectContaining({ status: 'pending' })]);
    failure.restore();
    const replay = await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', input));
    expect(await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', input))).toEqual(replay);
    const recovered = await new GoalStore(cwd).get(goalId);
    expect(recovered.questions).toHaveLength(1);
    expect(recovered.questions![0]!.id).toBe(replay.questionId);
    await eventServer(async (client) => {
      expect((await call(client, 'takt_ask_goal_question', { ...input, body: '別の質問' })).isError).toBe(true);
    });
    expect(await new GoalStore(cwd).get(goalId)).toEqual(recovered);
  });

  it('keeps completion state and failure diagnostics consistent after final publication failure', async () => {
    const failure = injectSaveFailure((goal) => goal.events?.[0]?.processed === true);
    const setup = vi.spyOn(MockProvider.prototype, 'setup');
    const before = readManagerRunFailures(cwd);
    setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '保存完了', summary: null }) }]);
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      expect(failure.injected).toHaveBeenCalledTimes(1);
      expect(setup).toHaveBeenCalledTimes(1);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.events![0]).toMatchObject({ id: eventId, processed: false });
      expect(saved.events![0]).not.toHaveProperty('summary');
      expect(readManagerRunFailures(cwd).slice(before.length)).toEqual([
        expect.objectContaining({ message: 'Injected goal publication failure' }),
      ]);
    } finally { resetScenario(); }
  }, 30_000);

  it('rebuilds a fresh event turn from the MCP work log and replays the operation read from its actual input', async () => {
    const setup = MockProvider.prototype.setup;
    const observed: Array<{ sessionId?: string }> = [];
    const decision = { summary: 'テスト結果を確認し、通知する判断を記録した' };
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        const input = JSON.parse(prompt) as { goal: Pick<Goal, 'workLog' | 'operations'> };
        const previous = input.goal.operations?.[0];
        observed.push({ sessionId: options.sessionId });
        if (previous === undefined) {
          setMockScenario([{ persona: 'manager', status: 'error', content: '', error: 'failure after persisted MCP effects',
            mcpToolCalls: [
              { server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_record_goal_work_log', arguments: { cwd, goalId, ...decision } },
              { server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_notify_goal', arguments: { cwd, goalId, ...notice } },
            ] }]);
        } else {
          expect(input.goal.workLog).toEqual([expect.objectContaining(decision)]);
          expect(previous).toMatchObject({ eventId, status: 'completed', result: { notificationId: expect.any(String) } });
          setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '保存記録から復旧', summary: null }),
            mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_notify_goal',
              arguments: { cwd, goalId, ...previous.arguments, operationName: previous.operationName } }] }]);
        }
        return agent.call(prompt, options);
      } };
    });
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      const first = await new GoalStore(cwd).get(goalId);
      expect(first.events![0]!.processed).toBe(false);
      expect(first.workLog).toHaveLength(1);
      // MCP で保存した通知に加え、ターン失敗そのものを blocked 通知として保存する。
      expect(first.notifications).toEqual([
        expect.objectContaining({ kind: 'custom', body: notice.body }),
        expect.objectContaining({ kind: 'blocked', severity: 'error', body: expect.stringContaining('failure after persisted MCP effects') }),
      ]);
      await managerRecovery.processGoalCompletions(cwd, goalId);
      const recovered = await new GoalStore(cwd).get(goalId);
      expect(observed).toEqual([{ sessionId: undefined }, { sessionId: undefined }]);
      expect(recovered.workLog).toEqual(first.workLog);
      expect(recovered.operations).toEqual(first.operations);
      expect(recovered.notifications).toEqual(first.notifications);
      expect(recovered.events![0]).toMatchObject({ processed: true, summary: '保存記録から復旧' });
    } finally { resetScenario(); }
  }, 30_000);

  it('reuses a saved notification result across fresh MCP servers and permits another operation name', async () => {
    const first = await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    const replayed = await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    expect(replayed).toEqual(first);
    await eventServer((client) => successfulCall(client, 'takt_notify_goal', { ...notice, operationName: 'notify:blocked', body: '回答待ち' }));
    expect((await new GoalStore(cwd).get(goalId)).notifications?.map(({ body }) => body)).toEqual(['作業A完了', '回答待ち']);
    const listed = await eventServer((client) => successfulCall(client, 'takt_list_goal_operations', {}));
    expect(listed.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId, operationName: 'notify:progress', status: 'completed', result: first }),
      expect.objectContaining({ eventId, operationName: 'notify:blocked', status: 'completed' }),
    ]));
    expect(listed.operations).toEqual((await new GoalStore(cwd).get(goalId)).operations);
  });

  it('rejects changed arguments under the same operation name without changing the saved result', async () => {
    await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    const saved = await new GoalStore(cwd).get(goalId);
    await eventServer(async (client) => {
      expect((await call(client, 'takt_notify_goal', { ...notice, body: '作業B完了' })).isError).toBe(true);
    });
    expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
  });

  it('uses the event ID as well as the operation name to distinguish separate notifications', async () => {
    await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    await recordGoalCompletion(cwd, goalId, { taskName: 'next-trigger', runSlug: 'next-run', result: { success: true, interrupted: false } });
    eventId = Reflect.get((await new GoalStore(cwd).get(goalId)).events!.at(-1)!, 'id') as string;
    await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    expect((await new GoalStore(cwd).get(goalId)).notifications?.map(({ body }) => body)).toEqual(['作業A完了', '作業A完了']);
  });

  it('reuses a saved question ID without duplicating its question notification', async () => {
    const input = { operationName: 'question:format', body: '形式はどれですか', options: ['CSV', 'JSON'], recipient: 'human' };
    const first = await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', input));
    expect(await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', input))).toEqual(first);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.questions).toHaveLength(1);
    expect(saved.questions![0]!.id).toBe(first.questionId);
    expect(saved.notifications?.filter(({ kind }) => kind === 'question')).toHaveLength(1);
  });

  it.each(['withdrawal', 'completion check'] as const)('reuses the saved %s result after its state transition', async (kind) => {
    const input: Record<string, unknown> = { operationName: `replay:${kind}` };
    const tool = kind === 'withdrawal' ? 'takt_withdraw_goal_question' : 'takt_check_goal_completion';
    if (kind === 'withdrawal') {
      const asked = await eventServer((client) => successfulCall(client, 'takt_ask_goal_question', {
        operationName: 'question:replay', body: '確認が必要ですか',
      }));
      input.questionId = asked.questionId;
    } else {
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, status: 'awaiting_merge', completion: {
        goalBranch: goal.branch, goalSha: initialSha, targetBranch: goal.integrationBranch, summary: '保存された証拠',
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
        instructions: ['git merge reviewed SHA'],
      } }));
    }
    const first = await eventServer((client) => successfulCall(client, tool, input));
    const saved = await new GoalStore(cwd).get(goalId);
    if (kind === 'withdrawal') expect(saved.questions![0]!.status).toBe('withdrawn');
    else expect(saved.status).toBe('completed');
    expect(await eventServer((client) => successfulCall(client, tool, input))).toEqual(first);
    expect(await new GoalStore(cwd).get(goalId)).toEqual(saved);
  });

  it('reuses an enqueued task and permits distinct work names in the same event', async () => {
    const first = await eventServer((client) => successfulCall(client, 'takt_enqueue_goal_task', work));
    expect(await eventServer((client) => successfulCall(client, 'takt_enqueue_goal_task', work))).toEqual(first);
    await eventServer((client) => successfulCall(client, 'takt_enqueue_goal_task', { ...work, operationName: 'work:documentation', workKey: 'documentation', task: 'Document input' }));
    const tasks = new TaskRunner(cwd).listTaskStateItems();
    expect(tasks).toHaveLength(2);
    expect(tasks.map(({ name }) => name)).toContain(first.taskName);
    expect((await new GoalStore(cwd).get(goalId)).workUnits).toHaveLength(2);
    const operations = Reflect.get(await new GoalStore(cwd).get(goalId), 'operations') as Array<{ id: string; operationName: string }>;
    const operation = operations.find(({ operationName }) => operationName === work.operationName)!;
    expect(operation.id).toEqual(expect.any(String));
    expect(tasks.find(({ name }) => name === first.taskName)).toMatchObject({ goalOperationId: operation.id });
    expect(new TaskRunner(cwd).listPendingTaskItems().find(({ name }) => name === first.taskName)?.data)
      .toMatchObject({ goal_operation_id: operation.id });
  });

  it.each([true, false])('replays the pending enqueue from the actual next event input (same operation name=%s)', async (sameName) => {
    const update = GoalStore.prototype.update;
    let failed = false;
    const publication = vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async function (this: GoalStore, id, transform) {
      if (!failed && new TaskRunner(cwd).listTaskStateItems().length > 0) {
        failed = true;
        throw new Error('Injected goal failure after queue publication');
      }
      return update.call(this, id, transform);
    });
    await eventServer(async (client) => {
      expect((await call(client, 'takt_enqueue_goal_task', work)).isError).toBe(true);
    });
    expect(failed).toBe(true);
    const queued = new TaskRunner(cwd).listTaskStateItems();
    expect(queued).toHaveLength(1);
    const pending = await new GoalStore(cwd).get(goalId);
    expect(pending.operations).toEqual([expect.objectContaining({ status: 'pending', eventId, operationName: work.operationName })]);
    expect(pending.events![0]!.processed).toBe(false);
    expect(pending.workUnits ?? []).toEqual([]);
    const operation = pending.operations![0]!;
    expect(queued[0]!.goalOperationId).toBe(operation.id);
    publication.mockRestore();
    if (sameName) {
      writeFileSync(join(cwd, '.takt', 'workflows', 'safe.yaml'), [
        'name: safe', 'initial_step: work', 'steps:', '  - name: work', '    kind: system',
        '    effects: [{type: close_pr, pr: 1}]', '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      ].join('\n'));
    }
    const setup = MockProvider.prototype.setup;
    const prompts: string[] = [];
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        prompts.push(prompt);
        const input = JSON.parse(prompt) as { goal: Pick<Goal, 'operations' | 'workUnits'> };
        const previous = input.goal.operations![0]!;
        expect(options.sessionId).toBeUndefined();
        expect(previous).toEqual(operation);
        expect(previous.arguments).toMatchObject({ workKey: 'validation', task: 'Validate input', workflow: 'safe' });
        // Reconciliation restores the work unit before this prompt, but leaves the operation pending.
        expect(input.goal.workUnits).toEqual([expect.objectContaining({ taskName: queued[0]!.name })]);
        setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '保存操作から再送', summary: null }),
          mcpToolCalls: [{ server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_enqueue_goal_task', arguments: {
            cwd, goalId, ...previous.arguments, operationName: sameName ? previous.operationName : `${previous.operationName}:another`,
          } }] }]);
        return agent.call(prompt, options);
      } };
    });
    try {
      await managerRecovery.processGoalCompletions(cwd, goalId);
      expect(prompts).toHaveLength(1);
      const recovered = await new GoalStore(cwd).get(goalId);
      const tasks = new TaskRunner(cwd).listTaskStateItems();
      if (sameName) expect(recovered.events![0]).toMatchObject({ processed: true, summary: '保存操作から再送' });
      else {
        expect(recovered.events![0]!.processed).toBe(false);
        expect(recovered.events![0]).not.toHaveProperty('summary');
      }
      expect(tasks.find(({ name }) => name === queued[0]!.name)).toMatchObject({ goalOperationId: operation.id });
      if (sameName) {
        expect(tasks.map(({ name }) => name)).toEqual([queued[0]!.name]);
        expect(recovered.workUnits).toEqual([expect.objectContaining({ taskName: queued[0]!.name, purpose: work.purpose })]);
        expect(recovered.operations).toEqual([expect.objectContaining({ id: operation.id, status: 'completed', result: { taskName: queued[0]!.name, tasksFile: join(cwd, '.takt', 'tasks.yaml'), workflow: 'safe' } })]);
      } else {
        expect(tasks).toHaveLength(2);
        expect(recovered.workUnits).toHaveLength(2);
        expect(recovered.operations).toEqual([operation, expect.objectContaining({ status: 'completed', operationName: `${operation.operationName}:another` })]);
        expect(tasks.find(({ name }) => name !== queued[0]!.name)?.goalOperationId).not.toBe(operation.id);
      }
    } finally { resetScenario(); }
  }, 30_000);

  it('does not enqueue when saving the operation before its side effect fails', async () => {
    const publication = vi.spyOn(GoalStore.prototype, 'update').mockRejectedValue(new Error('Injected operation publication failure'));
    await eventServer(async (client) => {
      expect((await call(client, 'takt_enqueue_goal_task', work)).isError).toBe(true);
    });
    expect(publication).toHaveBeenCalled();
    expect(new TaskRunner(cwd).listTaskStateItems()).toEqual([]);
  });

  it('reuses an event operation through independent manager MCP child processes', async () => {
    await withGoalTurns(cwd, [goalId], async (owners) => {
      const context = { goalId, eventId };
      const invoke = async () => {
        const connection: Awaited<ReturnType<typeof connectManagerMcp>> = await Reflect.apply(
          connectManagerMcp, undefined, [cwd, owners, context],
        );
        try { return await successfulCall(connection.client, 'takt_notify_goal', notice); }
        finally { await connection.dispose(); }
      };
      const first = await invoke();
      expect(await invoke()).toEqual(first);
      expect((await new GoalStore(cwd).get(goalId)).notifications).toHaveLength(1);
    });
  });

  it('persists a notification despite Slack delivery failure and does not resend it on replay', async () => {
    vi.spyOn(slack, 'getSlackWebhookUrl').mockReturnValue('https://example.test/webhook');
    const send = vi.spyOn(slack, 'sendSlackNotification').mockImplementation(async (_url, _message, onFailure) => {
      onFailure?.('Injected delivery failure');
    });
    const first = await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice));
    expect(await eventServer((client) => successfulCall(client, 'takt_notify_goal', notice))).toEqual(first);
    expect((await new GoalStore(cwd).get(goalId)).notifications).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent calls sharing a delegated owner and the same operation name', async () => {
    await withGoalTurns(cwd, [goalId], async (owners) => {
      const options = { allowedProjectRoot: cwd, toolSet: 'manager' as const, goalTurnOwners: owners, goalEventContext: { goalId, eventId } };
      const server = createTaktMcpServer({}, options);
      const client = new Client({ name: 'parallel-operation-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        const results = await Promise.all([
          successfulCall(client, 'takt_notify_goal', notice), successfulCall(client, 'takt_notify_goal', notice),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect((await new GoalStore(cwd).get(goalId)).notifications).toHaveLength(1);
      } finally { await client.close(); await server.close(); }
    });
  });
});
