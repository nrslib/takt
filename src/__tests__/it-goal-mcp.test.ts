import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer, TAKT_MCP_READ_ONLY_TOOL_NAMES, type TaktMcpToolSet } from '../features/mcp/server.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { GoalStore } from '../infra/goals/store.js';
import * as goalGit from '../infra/goals/git-command.js';
import { withGoalTurns } from '../infra/goals/turn-lock.js';
import { enqueueTaktGoalTask } from '../features/mcp/goalOperations.js';
import * as managerRecovery from '../features/manager/completionTurn.js';
import * as managerAutoRun from '../features/manager/autoRun.js';
import { TaskRunner } from '../infra/task/index.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../infra/config/index.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getRepertoireDir } from '../infra/config/paths.js';
import { attemptAutoRequeueTask, requeueExistingFailedTasks } from '../features/tasks/execute/parallelExecution.js';
import { connectManagerMcp } from '../features/manager/managerMcp.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { firstTextContent } from './helpers/mcp-content.js';
import {
  confirmationKeys, confirmationPayload, goalId, goalInput, goalRecord, signedConfirmation,
} from './helpers/goal-fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

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
      await withServer(project, undefined, 'manager', async (client) => {
        const read = await client.callTool({ name: 'takt_get_goal', arguments: { cwd: project, goalId } });
        expect(read.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(read.content)).goal.branch).toBe(goalBranch);
        const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd: project } });
        expect(listed.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(listed.content)).goals).toEqual([await new GoalStore(project).get(goalId)]);
        const result = await client.callTool({ name: enqueueTool, arguments: { cwd: project, goalId, purpose, task, workflow: 'safe' } });
        expect(result.isError).toBeUndefined();
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
    return withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, toolSet, async (client) => {
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

    await withServer(cwd, undefined, 'manager', async (client) => {
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
    const key = confirmationKeys().publicKey;
    const connections: Awaited<ReturnType<typeof connectManagerMcp>>[] = [];
    try {
      // 両サーバーを起動してから同じゴールへ同時に書き込む。
      const started = await Promise.allSettled([
        connectManagerMcp(cwd, key), connectManagerMcp(cwd, key),
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
      connection = await connectManagerMcp(cwd, confirmationKeys().publicKey);
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
      events: [...(goal.events ?? []), { taskName: added.name, runSlug: `run-${sha}`, processed: true, result: result.completion }],
    }));
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

  it.each([false, true])('merges a reviewed task and persists its source and resulting goal SHA while preserving human files and saved events (cleanup failure: %s)', async (cleanupFailure) => {
    const task = await saveResult({ 'result.txt': 'result\n' });
    const goalProgress = commitFiles(branch, { 'goal-progress.txt': 'retained\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, goalProgress]);
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, sessions: [{ provider: 'mock', sessionId: 'retained-session' }] }));
    const before = await new GoalStore(cwd).get(goalId);
    dirtyHumanTree();
    const human = humanSnapshot();
    observeCleanup(cleanupFailure);
    await withServer(cwd, undefined, 'manager', async (client) => {
      const result = await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const merged = git(cwd, ['rev-parse', branch]);
      const data = JSON.parse(firstTextContent(result.content));
      expect(data).toMatchObject({ status: 'merged', sha: merged, recorded: true });
      expectIncluded(task.sha, branch);
      expectIncluded(goalProgress, branch);
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
      expect(saved.sessions).toEqual(before.sessions);
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
    await withServer(cwd, undefined, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBe(true);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
      expect(git(cwd, ['rev-parse', other.branch])).toBe(base);
    });
  });

  it('rejects another goal branch even if the task itself names the requested goal', async () => {
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    const task = await saveResult({ 'foreign.txt': 'other goal\n' }, goalId, true, other.branch);
    const refs = git(cwd, ['show-ref', '--heads']);
    await withServer(cwd, undefined, 'manager', async (client) => {
      expect((await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha })).isError).toBe(true);
      expect(git(cwd, ['show-ref', '--heads'])).toBe(refs);
    });
  });

  it('does not permit a caller to redirect integration into another goal branch', async () => {
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    const task = await saveResult({ 'result.txt': 'owned\n' });
    await withServer(cwd, undefined, 'manager', async (client) => {
      const result = await call(client, mergeTool, { taskName: task.taskName, expectedSha: task.sha, targetBranch: other.branch });
      if (result.isError !== true) expectIncluded(task.sha, branch);
      expect(git(cwd, ['rev-parse', other.branch])).toBe(base);
    });
  });

  it('leaves business acceptance to the manager even when a task reports failure', async () => {
    const task = await saveResult({ 'useful.txt': 'reviewed partial result\n' }, goalId, false);
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
      await withServer(cwd, undefined, 'manager', async (client) => {
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

  it.each([false, true])('merges into the configured base branch before persisting a completed goal and rejects further enqueue (cleanup failure: %s)', async (cleanupFailure) => {
    configure('auto', 'release');
    const sha = commitFiles(branch, { 'result.txt': 'ready\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    dirtyHumanTree();
    const human = humanSnapshot();
    observeCleanup(cleanupFailure);
    await withServer(cwd, undefined, 'manager', async (client) => {
      const result = await call(client, completeTool, { expectedSha: sha, summary });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expectIncluded(sha, 'release');
      expect(git(cwd, ['rev-parse', 'main'])).toBe(base);
      const saved = await new GoalStore(cwd).get(goalId);
      const targetSha = git(cwd, ['rev-parse', 'release']);
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'merged', sha: targetSha, recorded: true, goal: saved, completion: { goalBranch: branch, goalSha: sha, targetBranch: 'release', summary } });
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
      const result = await call(client, completeTool, { expectedSha: sha, summary, mainMerge: 'auto' });
      expect(git(cwd, ['rev-parse', 'main'])).toBe(base);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).not.toBe('completed');
      if (result.isError !== true) expect(saved.status).not.toBe('created');
    });
  });

  it('returns ordinary file counts and the requested patch', async () => {
    const task = await saveResult({ 'src/a.ts': 'new one\nnew two\n' });
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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
    await withServer(cwd, undefined, 'manager', async (client) => {
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

  it('reports goal containment and ahead count for diverged and integrated branches', async () => {
    const first = commitFiles(branch, { 'result.txt': 'ready\n' });
    const sha = commitFiles(first, { 'goal-progress.txt': 'second goal commit\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    git(cwd, ['update-ref', 'refs/heads/main', commitFiles(base, { 'main.txt': 'different\n' })]);
    await withServer(cwd, undefined, 'manager', async (client) => {
      const before = await call(client, 'takt_get_goal_relation');
      expect(before.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(before.content))).toMatchObject({ included: false, ahead: 2 });
      configure('auto');
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      const after = await call(client, 'takt_get_goal_relation');
      expect(after.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(after.content))).toMatchObject({ included: true, ahead: 0 });
    });
  });
});

async function withServer<T>(
  cwd: string,
  publicKey: string | undefined,
  toolSet: 'all' | 'read-only' | 'manager',
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const options = { allowedProjectRoot: cwd, toolSet: toolSet as TaktMcpToolSet, goalConfirmationPublicKey: publicKey };
  const server = createTaktMcpServer({}, options);
  const client = new Client({ name: 'goal-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain('takt_list_goals');
    expect(names).toContain('takt_get_goal');
    if (toolSet === 'all') expect(names).toContain('takt_create_goal');
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('Goal MCP registration', () => {
  let cwd: string;
  let mainCommit: string;
  let releaseCommit: string;
  let keys: ReturnType<typeof confirmationKeys>;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-mcp-')));
    ({ mainCommit, releaseCommit } = initializeRepository(cwd));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'base_branch: release\n');
    keys = confirmationKeys();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
    // Synchronous Git and in-memory MCP turns must yield so worker IPC can flush.
    await setImmediate();
  });

  function request(extra: Partial<ReturnType<typeof confirmationPayload>> & {
    startBranch?: string; integrationBranch?: string;
  } = {}) {
    const payload = { ...confirmationPayload(cwd), ...extra };
    const { id: _id, projectRoot: _projectRoot, confirmedAt: _confirmedAt, confirmedBy: _confirmedBy, ...input } = payload;
    return { cwd, ...input, confirmation: signedConfirmation(payload, keys.privateKey) };
  }

  async function create(client: Client, input: Record<string, unknown>) {
    const result = await client.callTool({ name: 'takt_create_goal', arguments: input });
    expect(result.isError).toBeUndefined();
    const goal = (JSON.parse(firstTextContent(result.content)) as { goal: ReturnType<typeof goalRecord> }).goal;
    expect(await new GoalStore(cwd).get(goal.id)).toEqual(goal);
    return goal;
  }

  function expectNoGoalSideEffects(branches: string): void {
    expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
  }

  it('exposes goal operations and refuses unrestricted task enqueue and intervention', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'manager', async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'takt_create_goal', 'takt_get_goal', 'takt_get_run', 'takt_list_goals', 'takt_list_tasks',
        'takt_enqueue_goal_task', 'takt_list_workflows', 'takt_merge_goal_task',
        'takt_complete_goal', 'takt_check_goal_completion',
        'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation',
      ]));
      for (const name of ['takt_enqueue_task', 'takt_tell_run']) {
        expect((await client.callTool({ name, arguments: { cwd } })).isError).toBe(true);
      }
      expectNoGoalSideEffects(branches);
      expect(existsSync(join(cwd, '.takt', 'tasks.yaml'))).toBe(false);
    });
  });

  function setRemoteDefault(commit: string): void {
    git(cwd, ['update-ref', 'refs/remotes/origin/main', commit]);
    git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  }

  function expectSavedGoal(created: ReturnType<typeof goalRecord>, startBranch: string,
    integrationBranch: string, commit: string): void {
    expect(created).toMatchObject({ startBranch, integrationBranch });
    expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(commit);
    expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
  }

  it.each(['human', 'director'] as const)('creates a saved %s goal and its branch from the default branch through MCP', async (creationOrigin) => {
    const head = git(cwd, ['symbolic-ref', 'HEAD']);
    const index = git(cwd, ['ls-files', '--stage']);
    const status = git(cwd, ['status', '--porcelain']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request({ creationOrigin }));
      expect(created).toMatchObject({ ...goalRecord(), creationOrigin, branch: expect.stringMatching(/^takt\/\d{8}T\d{4}-.+/) });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(mainCommit);
      expect(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf-8'))).toEqual(created);
      expect(git(cwd, ['symbolic-ref', 'HEAD'])).toBe(head);
      expect(git(cwd, ['ls-files', '--stage'])).toBe(index);
      // ゴール保存が追加する未追跡ファイルだけを除き、利用者の作業状態を比較する。
      expect(git(cwd, ['status', '--porcelain']).split('\n').filter((line) => !line.includes('.takt/goals/')).join('\n')).toBe(status);
    });
  });

  it.each(['main', 'release'] as const)('uses the current local main commit from %s when the start is omitted', async (source) => {
    const commit = source === 'main' ? mainCommit : releaseCommit;
    git(cwd, ['update-ref', 'refs/heads/main', commit]);
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request()));
    expectSavedGoal(created, 'main', 'main', commit);
  });

  it.each([true, false])('handles a local master default with reference present=%s', async (present) => {
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    if (present) git(cwd, ['update-ref', 'refs/heads/master', mainCommit]);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      if (present) {
        expectSavedGoal(await create(client, request()), 'master', 'master', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('creates from a remote-only default only when its reference exists: %s', async (present) => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      if (present) {
        expectSavedGoal(await create(client, request()), 'main', 'main', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('prefers the local default over a different remote commit with local present=%s', async (localPresent) => {
    setRemoteDefault(releaseCommit);
    if (!localPresent) git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request()));
    expectSavedGoal(created, 'main', 'main', localPresent ? mainCommit : releaseCommit);
  });

  it('rejects an explicit start when only the remote default reference exists', async () => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request({ startBranch: 'main' }) })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it.each([true, false])('validates an explicit integration branch with a remote-only default and local integration present=%s', async (present) => {
    setRemoteDefault(mainCommit);
    git(cwd, ['update-ref', '-d', 'refs/heads/main']);
    git(cwd, ['update-ref', 'refs/remotes/origin/release', releaseCommit]);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/heads/release']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ integrationBranch: 'release' });
      if (present) {
        expectSavedGoal(await create(client, input), 'main', 'release', mainCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([true, false])('uses an explicit local start as the omitted integration branch with local start present=%s', async (present) => {
    git(cwd, ['update-ref', 'refs/remotes/origin/release', releaseCommit]);
    if (!present) git(cwd, ['update-ref', '-d', 'refs/heads/release']);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ startBranch: 'release' });
      if (present) {
        expectSavedGoal(await create(client, input), 'release', 'release', releaseCommit);
      } else {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      }
    });
  });

  it.each([goalInput().objective, 'replacement'])('reads the created goal with objective %s from a new read-only server using list and detail tools', async (objective) => {
    const created = await withServer(cwd, keys.publicKey, 'all', (client) => create(client, request({ objective })));
    expect(created.objective).toBe(objective);
    await withServer(cwd, undefined, 'read-only', async (client) => {
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ goals: [expect.objectContaining({ id: goalId, objective })] });
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: created });
    });
  });

  it('uses a signed explicit start and integration branch instead of the default', async () => {
    const input = request();
    const payload = { ...confirmationPayload(cwd), startBranch: 'release', integrationBranch: 'main' };
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, {
        ...input, startBranch: 'release', integrationBranch: 'main',
        confirmation: signedConfirmation(payload, keys.privateKey),
      });
      expect(created).toMatchObject({ startBranch: 'release', integrationBranch: 'main' });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
    });
  });

  it('lists healthy goals with corrupt-file errors and keeps the same MCP connection usable', async () => {
    const healthy = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', objective: '{' };
    await new GoalStore(cwd).create(healthy);
    const healthyPath = join(cwd, '.takt', 'goals', healthy.id, 'goal.json');
    const saved = readFileSync(healthyPath);
    const corruptPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    mkdirSync(join(cwd, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(corruptPath, '{');
    await withServer(cwd, undefined, 'read-only', async (client) => {
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBe(true);
      const output = JSON.parse(firstTextContent(listed.content)) as {
        goals: unknown[]; errors: { goalId: string; error: string }[];
      };
      expect(output.goals).toEqual([healthy]);
      expect(output.errors).toEqual([{ goalId, error: expect.stringMatching(/Invalid goal file/) }]);
      expect(output.errors[0]!.error).not.toContain(cwd);
      const corrupt = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(corrupt.isError).toBe(true);
      expect(firstTextContent(corrupt.content)).toMatch(/Invalid goal file/);
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: healthy.id } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: healthy });
    });
    expect(readFileSync(corruptPath, 'utf-8')).toBe('{');
    expect(readFileSync(healthyPath)).toEqual(saved);
  });

  it('rejects a missing explicit integration branch before publication', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const input = request({ startBranch: 'release', integrationBranch: 'missing' });
      expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('rejects reuse of a confirmed ID without changing the existing goal or branch', async () => {
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request());
      const saved = readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'));
      const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
      const duplicate = await client.callTool({ name: 'takt_create_goal', arguments: request({ objective: 'replacement' }) });
      expect(duplicate.isError).toBe(true);
      expect(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toEqual(saved);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(mainCommit);
      expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
    });
  });

  it('rejects a branch name collision without overwriting the existing Git reference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T14:43:00.000Z'));
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const created = await create(client, request());
      rmSync(join(cwd, '.takt', 'goals', goalId), { recursive: true, force: true });
      git(cwd, ['update-ref', `refs/heads/${created.branch}`, releaseCommit]);
      const collision = await client.callTool({ name: 'takt_create_goal', arguments: request() });
      expect(collision.isError).toBe(true);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
      expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    });
  });

  it.each(['missing', 'self-reported', 'untrusted signature', 'changed criteria', 'tool public key'] as const)(
    'rejects %s confirmation before saving or creating a branch', async (kind) => {
      const otherKeys = confirmationKeys();
      const input: Record<string, unknown> = request();
      if (kind === 'missing') delete input.confirmation;
      if (kind === 'self-reported') input.confirmation = goalRecord().confirmation;
      if (kind === 'untrusted signature' || kind === 'tool public key') {
        input.confirmation = signedConfirmation(confirmationPayload(cwd), otherKeys.privateKey);
      }
      if (kind === 'changed criteria') input.acceptanceCriteria = ['unconfirmed criterion'];
      if (kind === 'tool public key') input.goalConfirmationPublicKey = otherKeys.publicKey;
      const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
      await withServer(cwd, keys.publicKey, 'all', async (client) => {
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expectNoGoalSideEffects(branches);
      });
    },
  );

  it('rejects creation without a host public key while keeping read tools usable', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, undefined, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      const result = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toEqual({ goals: [] });
      expectNoGoalSideEffects(branches);
    });
  });

  it('exposes read tools and refuses direct creation in the read-only tool set', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'read-only', async (client) => {
      const names = (await client.listTools()).tools.map(({ name }) => name).sort();
      expect(names).toEqual(['takt_get_goal', 'takt_get_run', 'takt_list_goals', 'takt_list_tasks']);
      expect([...TAKT_MCP_READ_ONLY_TOOL_NAMES].sort()).toEqual(names);
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('does not publish a goal when the signed start branch does not exist', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const payload = { ...confirmationPayload(cwd), startBranch: 'missing' };
      const result = await client.callTool({ name: 'takt_create_goal', arguments: {
        ...request(), startBranch: 'missing', confirmation: signedConfirmation(payload, keys.privateKey),
      } });
      expect(result.isError).toBe(true);
      expectNoGoalSideEffects(branches);
    });
  });

  it('removes only the newly created branch when publication fails and allows retry', async () => {
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    const publication = vi.spyOn(GoalStore.prototype, 'create').mockRejectedValueOnce(new Error('Injected publication failure'));
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      const result = await client.callTool({ name: 'takt_create_goal', arguments: request() });
      expect(result.isError).toBe(true);
      expect(publication).toHaveBeenCalledTimes(1);
      expectNoGoalSideEffects(branches);
      await create(client, request());
      expect(await new GoalStore(cwd).get(goalId)).toMatchObject({ id: goalId });
    });
  });

  it('preserves the goal and branch when publication throws after saving the goal', async () => {
    const publish = GoalStore.prototype.create;
    vi.spyOn(GoalStore.prototype, 'create').mockImplementationOnce(async function (this: GoalStore, goal) {
      await publish.call(this, goal);
      throw new Error('Injected failure after publication');
    });
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      const goal = await new GoalStore(cwd).get(goalId);
      expect(git(cwd, ['rev-parse', `refs/heads/${goal.branch}`])).toBe(mainCommit);
    });
  });

  it('preserves a branch advanced by another writer when failed publication is compensated', async () => {
    let createdBranch: string | undefined;
    vi.spyOn(GoalStore.prototype, 'create').mockImplementationOnce(async (record) => {
      createdBranch = record.branch;
      git(cwd, ['update-ref', `refs/heads/${record.branch}`, releaseCommit]);
      throw new Error('Injected publication failure after branch advancement');
    });
    await withServer(cwd, keys.publicKey, 'all', async (client) => {
      expect((await client.callTool({ name: 'takt_create_goal', arguments: request() })).isError).toBe(true);
      expect(createdBranch).toEqual(expect.any(String));
      expect(git(cwd, ['rev-parse', `refs/heads/${createdBranch}`])).toBe(releaseCommit);
      expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    });
  });

  it('rejects all goal operations outside the allowed project root', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-outside-')));
    initializeRepository(outside);
    const outsideGoal = join(outside, '.takt', 'goals', goalId, 'goal.json');
    mkdirSync(join(outside, '.takt', 'goals', goalId), { recursive: true });
    writeFileSync(outsideGoal, JSON.stringify(goalRecord()));
    const saved = readFileSync(outsideGoal);
    const branches = git(outside, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    const newId = '550e8400-e29b-41d4-a716-446655440001';
    try {
      await withServer(cwd, keys.publicKey, 'all', async (client) => {
        for (const name of ['takt_list_goals', 'takt_get_goal']) {
          expect((await client.callTool({ name, arguments: { cwd: outside, ...(name === 'takt_get_goal' ? { goalId } : {}) } })).isError).toBe(true);
        }
        const input = {
          cwd: outside, ...goalInput(),
          confirmation: signedConfirmation({ ...confirmationPayload(outside), id: newId }, keys.privateKey),
        };
        expect((await client.callTool({ name: 'takt_create_goal', arguments: input })).isError).toBe(true);
        expect(readFileSync(outsideGoal)).toEqual(saved);
        expect(existsSync(join(outside, '.takt', 'goals', newId, 'goal.json'))).toBe(false);
        expect(git(outside, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
