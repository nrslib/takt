vi.mock('../infra/goals/events.js', async (original) => ({ ...await original<typeof import('../infra/goals/events.js')>(), saveManagerEvent: vi.fn() }));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { connectManagerMcp } from '../features/manager/managerMcp.js';
import { createTaktMcpServer,type TaktMcpToolSet } from '../features/mcp/server.js';
import { attemptAutoRequeueTask,requeueExistingFailedTasks } from '../features/tasks/execute/parallelExecution.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { loadWorkflowByIdentifier,resolveWorkflowCallTarget } from '../infra/config/index.js';
import { getWorkflowSourcePath } from '../infra/config/loaders/workflowSourceMetadata.js';
import { getRepertoireDir } from '../infra/config/paths.js';
import { GoalStore } from '../infra/goals/store.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { TaskRunner } from '../infra/task/index.js';
import { goalId } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';

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

  function savedGoalWork(): Array<{ taskName: string; purpose: string }> {
    return new TaskRunner(cwd).listTaskStateItems().filter((task) => task.goalId === goalId).map((task) => ({ taskName: task.name, purpose: task.goalPurpose! }));
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
      expect(savedGoalWork()).toEqual([expect.objectContaining({ taskName, purpose })]);
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
      expect(savedGoalWork()).toEqual(created.map((unit) => expect.objectContaining(unit)));
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
    writeFileSync(file, JSON.stringify({ ...saved, }));

    await withServer(cwd, 'manager', async (client) => {
      expect((await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } })).isError).toBeUndefined();
      await vi.waitFor(() => expect(savedGoalWork()).toEqual(units.map((unit) => expect.objectContaining(unit))));
    });

    expect(savedGoalWork()).toEqual(units.map((unit) => expect.objectContaining(unit)));
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
      expect(savedGoalWork()).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskName: names[0], purpose: '先行作業' }),
        expect.objectContaining({ taskName: names[1], purpose: '後続作業' }),
      ]));
      expect(pendingTasks()).toHaveLength(2);
    }));
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
      expect(savedGoalWork()).toEqual(expect.arrayContaining(names.map((taskName, index) =>
        expect.objectContaining({ taskName, purpose: purposes[index] }))));
      expect(savedGoalWork()).toHaveLength(2);
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
  const reopenTool = 'takt_reopen_goal';

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

  async function saveLargeGoalHistory() {
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal,
      workLog: Array.from({ length: 100 }, (_, index) => ({ id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, summary: '作業'.repeat(20000), recordedAt: '2026-10-14T00:00:00Z' })),
      questions: Array.from({ length: 100 }, (_, index) => ({ id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '質問'.repeat(20000), recipient: 'human', status: 'pending' })),
      notifications: Array.from({ length: 100 }, (_, index) => ({ id: `750e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '通知'.repeat(20000), kind: 'custom', recordedAt: '2026-10-14T00:00:00Z' })),
    }));
  }

  it('uses the same response bound and artifact selectors in manager and read-only servers', async () => {
    await saveLargeGoalHistory();
    const runSlug = 'bounded';
    const runDir = join(cwd, '.takt', 'runs', runSlug);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    mkdirSync(join(runDir, 'reports'), { recursive: true });
    const task = 'A'.repeat(4096) + 'B'.repeat(65904);
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ task, workflow: 'safe', runSlug,
      runRoot: `.takt/runs/${runSlug}`, reportDirectory: `.takt/runs/${runSlug}/reports`, logsDirectory: `.takt/runs/${runSlug}/logs`,
      contextDirectory: `.takt/runs/${runSlug}/context`, status: 'completed', startTime: '2026-10-14T00:00:00Z' }));
    writeFileSync(join(runDir, 'reports', 'large.md'), '日本語'.repeat(100000));
    const responses: unknown[] = [];
    for (const toolSet of ['manager', 'read-only'] as const) await withServer(cwd, toolSet, async (client) => {
      for (const name of ['takt_get_goal', 'takt_list_goals', 'takt_get_run']) {
        const result = await client.callTool({ name, arguments: { cwd, ...(name === 'takt_get_goal' ? { goalId } : name === 'takt_get_run' ? { runSlug } : {}) } });
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
        responses.push(JSON.parse(firstTextContent(result.content)));
      }
      const report = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, view: 'report', report: 'large.md', maxBytes: 12 } });
      expect(report.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(report.content))).toMatchObject({ report: { content: '日本語日', truncated: true, nextOffset: 12 } });
      for (const offset of [0, 4096]) {
        const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, view: 'task', offset } });
        expect(result.isError).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
        const payload = JSON.parse(firstTextContent(result.content));
        expect(payload).not.toHaveProperty('taskOmission');
        expect(payload.task).toEqual({ content: (offset === 0 ? 'A' : 'B').repeat(4096),
          offset, returnedBytes: 4096, totalBytes: 70000, direction: 'forward', truncated: true, nextOffset: offset + 4096 });
        responses.push(payload);
      }
      const entry = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId, path: 'workLog.0.summary', textOffset: 12, maxBytes: 12 } });
      expect(entry.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(entry.content))).toMatchObject({ content: '作業作業', offset: 12, truncated: true });
      if (toolSet === 'manager') {
        const tools = (await client.listTools()).tools;
        expect(tools.find((tool) => tool.name === 'takt_list_goal_work_log')!.inputSchema.properties).toHaveProperty('limit');
        const logs = await client.callTool({ name: 'takt_list_goal_work_log', arguments: { cwd, goalId, limit: 1, offset: 1 } });
        expect(logs.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(logs.content))).toMatchObject({ returnedCount: 1, offset: 1, nextOffset: 2 });
        const workflow = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd, limit: 1 } });
        expect(workflow.isError).toBeUndefined();
        const first = JSON.parse(firstTextContent(workflow.content));
        expect(first.returnedCount).toBe(1);
        const next = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd, limit: 1, offset: first.nextOffset } });
        expect(next.isError).toBeUndefined();
        expect(JSON.parse(firstTextContent(next.content)).workflows[0].name).not.toBe(first.workflows[0].name);
      }
    });
    expect(responses.slice(0, 5)).toEqual(responses.slice(5));
  });

  it('continues individual saved-record errors through manager and read-only MCP inputs', async () => {
    const saved = await new GoalStore(cwd).get(goalId);
    const ids = Array.from({ length: 51 }, (_, index) => `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`);
    const corruptRecords = ['{', '{}', 'null', JSON.stringify(saved)];
    for (const [index, id] of ids.entries()) {
      const directory = join(cwd, '.takt', 'goals', id);
      mkdirSync(directory);
      writeFileSync(join(directory, 'goal.json'), corruptRecords[index % corruptRecords.length]!);
    }
    const responses: unknown[] = [];
    for (const toolSet of ['manager', 'read-only'] as const) await withServer(cwd, toolSet, async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.find(({ name }) => name === 'takt_list_goals')!.inputSchema.properties).toHaveProperty('errorOffset');
      const first = await client.callTool({ name: 'takt_list_goals', arguments: { cwd, limit: 50, errorOffset: 0 } });
      const page = JSON.parse(firstTextContent(first.content));
      expect(first.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      expect(page).toMatchObject({ totalCount: 1, returnedCount: 1, nextOffset: null,
        goals: [{ id: goalId }], errorPage: { collection: 'errors', totalCount: 51, returnedCount: 50,
          omittedCount: 1, offset: 0, nextOffset: 50, truncated: true } });
      expect(page.errors.map((error: { goalId: string }) => error.goalId)).toEqual(ids.slice(0, 50));
      expect(page.errorPage.retrieval).toContain('errorPage.nextOffset');
      expect(page.errorPage.retrieval).toContain('errorOffset');
      const next = await client.callTool({ name: 'takt_list_goals', arguments: { cwd, limit: 50, errorOffset: page.errorPage.nextOffset } });
      const last = JSON.parse(firstTextContent(next.content));
      expect(next.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      expect(last.goals).toEqual(page.goals);
      expect(last.errors.map((error: { goalId: string }) => error.goalId)).toEqual(ids.slice(50));
      expect(last.errorPage).toMatchObject({ totalCount: 51, returnedCount: 1, omittedCount: 50, offset: 50, nextOffset: null, truncated: true });
      for (const error of [...page.errors, ...last.errors] as { error: string }[]) {
        expect(error.error).toContain('Invalid goal file');
        expect(error.error).not.toContain(cwd);
      }
      responses.push([page, last]);
      if (toolSet === 'manager') {
        expect(tools.find(({ name }) => name === 'takt_list_workflows')!.inputSchema.properties).not.toHaveProperty('errorOffset');
        const workflow = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd, offset: 0, limit: 1 } });
        expect(workflow.isError).toBeUndefined();
        const rejected = await client.callTool({ name: 'takt_list_workflows', arguments: { cwd, offset: 0, limit: 1, errorOffset: 0 } });
        expect(rejected.isError).toBe(true);
      }
    });
    expect(responses[0]).toEqual(responses[1]);
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
    const added = runner.addTask('fixture result', { workflow: 'safe', worktree: false, ...(owner === null ? {} : { goal_id: owner, goal_purpose: 'fixture result' }), branch: source });
    const claimed = runner.claimNextTasks(1)[0]!;
    const task = runner.updateRunningTaskExecution(claimed.name, { runSlug: `run-${sha}`, branch: source });
    const result = { task, success, branch: source, completion: { success, interrupted: false, branch: source, sha },
      response: 'fixture result', executionLog: [], startedAt: '2026-10-07T00:00:00Z', completedAt: '2026-10-07T00:01:00Z' };
    if (success) runner.completeTask(result); else runner.failTask(result);
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
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'merged', sha: targetSha, goal: { id: saved.id, status: saved.status, completion: saved.completion }, completion: { goalBranch: branch, goalSha: sha, targetBranch: 'main', summary } });
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
        goal: { id: saved.id, status: saved.status, completion: saved.completion }, completion: { changeSummary },
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

  it('reopens the same goal, enqueues corrective work and submits a new approval notification on the same connection', async () => {
    const sha = commitFiles(branch, { 'result.txt': 'approved\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    const store = new GoalStore(cwd);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      const before = await store.get(goalId);
      const firstNotification = before.notifications!.find(({ kind }) => kind === 'awaiting_merge')!;
      expect(firstNotification.body).toBe(summary);
      const reason = '  取り込み前に入力検証を修正する  ';
      const reopened = await call(client, reopenTool, { reason });
      expect(reopened.isError, firstTextContent(reopened.content)).toBeUndefined();
      const output = JSON.parse(firstTextContent(reopened.content));
      const saved = GoalSchema.parse(JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')));
      expect(saved.status).toBe('created');
      expect(output.goal.status).toBe('created');
      expect(saved.completion).toEqual(before.completion);
      expect(saved.workLog.at(-1)).toMatchObject({ id: output.workLogEntryId, summary: reason });
      expect(saved.notifications).toEqual(before.notifications);

      const enqueued = await call(client, 'takt_enqueue_goal_task', { task: '入力を検証する', purpose: '入力検証の修正', workflow: 'safe' });
      expect(enqueued.isError, firstTextContent(enqueued.content)).toBeUndefined();
      const { taskName } = JSON.parse(firstTextContent(enqueued.content));
      const runner = new TaskRunner(cwd);
      expect(runner.listPendingTaskItems()).toEqual([expect.objectContaining({ name: taskName, data: expect.objectContaining({ goal_id: goalId, base_branch: branch }) })]);
      const claimed = runner.claimNextTasks(1)[0]!;
      expect(claimed.name).toBe(taskName);
      const correctedSha = commitFiles(branch, { 'result.txt': 'corrected and validated\n' });
      const source = 'takt/corrective-result';
      git(cwd, ['update-ref', `refs/heads/${source}`, correctedSha]);
      const task = runner.updateRunningTaskExecution(taskName, { runSlug: 'corrective-run', branch: source });
      runner.completeTask({ task, success: true, branch: source,
        completion: { success: true, interrupted: false, branch: source, sha: correctedSha },
        response: '入力検証を修正した', executionLog: [], startedAt: '2026-10-15T00:00:00Z', completedAt: '2026-10-15T00:01:00Z' });
      expect((await call(client, mergeTool, { taskName, expectedSha: correctedSha })).isError).toBeUndefined();
      expectIncluded(correctedSha, branch);
      expect((await store.get(goalId)).completion).toEqual(before.completion);
      const newSha = git(cwd, ['rev-parse', branch]);
      expect(newSha).not.toBe(sha);
      const newSummary = '入力検証の修正と追加テストを確認した';
      expect((await call(client, completeTool, { expectedSha: newSha, summary: newSummary })).isError).toBeUndefined();
      const resubmitted = await store.get(goalId);
      expect(resubmitted).toMatchObject({ status: 'awaiting_merge', completion: { goalSha: newSha, summary: newSummary } });
      const notifications = resubmitted.notifications!.filter(({ kind }) => kind === 'awaiting_merge');
      expect(notifications).toEqual([firstNotification, expect.objectContaining({ kind: 'awaiting_merge', body: newSummary })]);
      expect(notifications[1]!.id).not.toBe(firstNotification.id);
    });
  });

  it('bounds reopening a goal with large saved histories and preserves its complete evidence and maximum-length reason', async () => {
    await saveLargeGoalHistory();
    const sha = commitFiles(branch, { 'result.txt': 'ready\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, { expectedSha: sha, summary: '完成根拠'.repeat(20000) })).isError).toBeUndefined();
      const before = await new GoalStore(cwd).get(goalId);
      const reason = '理'.repeat(128 * 1024);
      const result = await call(client, reopenTool, { reason });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      const payload = JSON.parse(firstTextContent(result.content));
      expect(payload.goal).toMatchObject({ id: goalId, status: 'created', completion: {
        goalSha: sha, targetBranch: 'main', instructions: before.completion!.instructions,
        reason: before.completion!.reason, truncated: true,
        omissions: [{ path: 'completion.summary', totalBytes: Buffer.byteLength(before.completion!.summary) }],
      } });
      for (const field of ['workLog', 'questions', 'notifications']) expect(payload.goal).not.toHaveProperty(field);
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.completion).toEqual(before.completion);
      expect(saved.workLog.at(-1)).toMatchObject({ id: payload.workLogEntryId, summary: reason });
      const detail = await call(client, 'takt_get_goal', { path: 'workLog.summary', recordId: payload.workLogEntryId, textOffset: 0, maxBytes: 12 });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toMatchObject({ content: '理理理理', totalBytes: Buffer.byteLength(reason), nextOffset: 12 });
    });
  });

  it.each(['paused', 'aborted'] as const)('rejects reopening a %s goal and leaves saved state unchanged', async (executionStatus) => {
    const sha = commitFiles(branch, { 'result.txt': 'ready\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, executionStatus }));
      const file = join(cwd, '.takt', 'goals', goalId, 'goal.json');
      const before = readFileSync(file, 'utf8');
      const result = await call(client, reopenTool, { reason: '追加の修正' });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toContain(executionStatus);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });
  });

  it('rejects reopening when the approved SHA is merged even if the goal tip has advanced', async () => {
    const sha = commitFiles(branch, { 'result.txt': 'approved\n' });
    git(cwd, ['update-ref', `refs/heads/${branch}`, sha]);
    await withServer(cwd, 'manager', async (client) => {
      expect((await call(client, completeTool, { expectedSha: sha, summary })).isError).toBeUndefined();
      const later = commitFiles(branch, { 'later.txt': 'not reviewed\n' });
      git(cwd, ['update-ref', `refs/heads/${branch}`, later]);
      git(cwd, ['update-ref', 'refs/heads/main', sha]);
      const before = await new GoalStore(cwd).get(goalId);
      const result = await call(client, reopenTool, { reason: '追加の修正' });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toContain('takt_check_goal_completion');
      expect(await new GoalStore(cwd).get(goalId)).toEqual(before);
      expect(git(cwd, ['rev-parse', branch])).toBe(later);
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
): Promise<T> {
  const options = { allowedProjectRoot: cwd, toolSet: toolSet as TaktMcpToolSet };
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
