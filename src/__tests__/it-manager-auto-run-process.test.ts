import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { TaskRunner } from '../infra/task/runner.js';
import { isProcessAlive } from '../infra/task/process.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import { MANAGER_GOAL_TASKS_ENV } from '../shared/constants.js';
import { readManagerRunFailures } from '../infra/task/manager-run-state.js';
import { captureOwnedChild, ownedProcessMarkerScript, readOwnedProcessMarker, signalOwnedProcess, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';
import { GoalStore } from '../infra/goals/store.js';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { MockProvider } from '../infra/providers/mock.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { processGoalCompletions } from '../features/manager/completionTurn.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import type { ProviderAgent } from '../infra/providers/types.js';

it.each(['automatic run', 'direct run', 'direct watch'] as const)('interrupts only the aborted goal in the surviving parallel process through %s', async (entry) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-abort-process-'));
  const moduleUrl = (path: string): string => pathToFileURL(join(process.cwd(), 'dist', path)).href;
  let child: ChildProcess | undefined;
  let owned: OwnedProcess | undefined;
  let captured: Promise<OwnedProcess | undefined> | undefined;
  let stderr = '';
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Goal Abort Test'], { cwd });
    execFileSync('git', ['config', 'user.email', 'goal-abort@example.com'], { cwd });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'goal abort fixture'], { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd });
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    const automatic = entry === 'automatic run';
    writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nlanguage: en\nconcurrency: 3\ntask_poll_interval_ms: 100\nmanager:\n  auto_run: ${automatic}\nauto_requeue_max_attempts: 0\n`);
    writeFileSync(join(cwd, '.takt', 'workflows', 'abort-run.yaml'), 'name: abort-run\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const goal = await registerFixtureGoal(cwd);
    const other = await registerFixtureGoal(cwd, { id: '650e8400-e29b-41d4-a716-446655440001' });
    const store = new GoalStore(cwd);
    const runner = new TaskRunner(cwd);
    const options = { workflow: 'abort-run', worktree: false };
    const target = runner.addTask('abort-target', { ...options, goal_id: goal.id });
    const unrelated = runner.addTask('abort-sibling', { ...options, goal_id: other.id });
    const ordinary = runner.addTask('abort-ordinary', options);
    const goalSha = execFileSync('git', ['rev-parse', goal.branch], { cwd, encoding: 'utf8' }).trim();
    const hook = join(cwd, 'abort-provider-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider } from ${JSON.stringify(moduleUrl('infra/providers/mock.js'))};
const root = ${JSON.stringify(cwd)};
MockProvider.prototype.setup = config => ({ call: async (prompt, options) => {
  if (config.name === 'manager') {
    writeFileSync(join(root, 'manager-called'), 'unexpected turn');
    return { persona: 'manager', status: 'done', timestamp: new Date(), content: '', structuredOutput: { message: 'unexpected turn', summary: null } };
  }
  const label = ['abort-target', 'abort-sibling', 'abort-ordinary'].find(value => prompt.includes(value));
  if (label === undefined) throw new Error('Unknown test task prompt');
  writeProcessMarker(join(root, 'started-' + label));
  const outcome = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 25000;
    const timer = setInterval(() => {
      if (options.abortSignal?.aborted) { clearInterval(timer); resolve('aborted'); }
      else if (existsSync(join(root, 'release-' + label))) { clearInterval(timer); resolve('completed'); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('Test did not finish task ' + label)); }
    }, 20);
  });
  writeFileSync(join(root, outcome + '-' + label), 'observed');
  return { persona: config.name, status: outcome === 'aborted' ? 'blocked' : 'done', timestamp: new Date(),
    content: outcome === 'aborted' ? '' : 'completed', ...(outcome === 'aborted' ? { error: 'mock task signal aborted' } : {}) };
} });
`);
    const env = { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: undefined };
    if (automatic) {
      const launcher = spawnSync(process.execPath, ['--input-type=module', '-e', `import { ensureManagerRun } from ${JSON.stringify(moduleUrl('features/manager/autoRun.js'))}; await ensureManagerRun(${JSON.stringify(cwd)});`], { cwd, env, encoding: 'utf8', timeout: 15000 });
      expect(launcher.error).toBeUndefined();
      expect(launcher.status, launcher.stdout + launcher.stderr).toBe(0);
    } else {
      child = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), entry === 'direct watch' ? 'watch' : 'run'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
      captured = captureOwnedChild(child);
      void captured.catch(() => {});
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    }
    const runningLabels = automatic ? ['abort-target', 'abort-sibling'] : ['abort-target', 'abort-sibling', 'abort-ordinary'];
    await vi.waitFor(() => {
      for (const label of runningLabels) expect(existsSync(join(cwd, `started-${label}`)), stderr).toBe(true);
    }, { timeout: 15000 });
    owned = readOwnedProcessMarker(readFileSync(join(cwd, 'started-abort-target'), 'utf8'));
    for (const label of runningLabels) expect(readOwnedProcessMarker(readFileSync(join(cwd, `started-${label}`), 'utf8')).pid).toBe(owned.pid);
    expect(owned.pid).not.toBe(process.pid);
    if (automatic) expect(runner.listTaskStateItems().find(({ name }) => name === ordinary.name)?.status).toBe('pending');
    await store.update(other.id, (saved) => transitionGoalExecution(saved, 'paused'));
    const request = spawnSync(process.execPath, ['--input-type=module', '-e', `import { setGoalExecutionStatus } from ${JSON.stringify(moduleUrl('infra/goals/execution.js'))}; await setGoalExecutionStatus(${JSON.stringify(cwd)}, ${JSON.stringify(goal.id)}, 'aborted', new AbortController().signal);`], { cwd, env: { ...env, NODE_OPTIONS: undefined }, encoding: 'utf8', timeout: 15000 });
    expect(request.error).toBeUndefined();
    expect(request.status, request.stdout + request.stderr).toBe(0);
    expect((await store.get(goal.id)).executionStatus).toBe('aborted');
    await vi.waitFor(() => expect(existsSync(join(cwd, 'aborted-abort-target'))).toBe(true), { timeout: 7000 });
    await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === target.name)?.status).toBe('failed'), { timeout: 7000 });
    const targetState = runner.listTaskStateItems().find(({ name }) => name === target.name)!;
    expect(targetState).toMatchObject({ runSlug: expect.any(String), completion: { success: false, interrupted: true, workflowResult: 'aborted', failureReason: expect.stringMatching(/goal.*abort|ゴール.*中止/iu) } });
    expect(targetState.failure?.error).toMatch(/goal.*abort|ゴール.*中止/iu);
    expect(isProcessAlive(owned.pid)).toBe(true);
    expect(runner.listTaskStateItems().find(({ name }) => name === unrelated.name)?.status).toBe('running');
    for (const label of runningLabels.filter((value) => value !== 'abort-target')) {
      expect(existsSync(join(cwd, `aborted-${label}`))).toBe(false);
      writeFileSync(join(cwd, `release-${label}`), 'complete unrelated work');
    }
    await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === unrelated.name)?.status).toBe('completed'), { timeout: 10000 });
    if (!automatic) await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === ordinary.name)?.status).toBe('completed'), { timeout: 10000 });
    else expect(runner.listTaskStateItems().find(({ name }) => name === ordinary.name)?.status).toBe('pending');
    await vi.waitFor(async () => expect((await store.get(goal.id)).events).toContainEqual(expect.objectContaining({ kind: 'completion', taskName: target.name, runSlug: targetState.runSlug, result: targetState.completion, processed: false })), { timeout: 7000 });
    expect(existsSync(join(cwd, 'manager-called'))).toBe(false);
    expect(execFileSync('git', ['rev-parse', goal.branch], { cwd, encoding: 'utf8' }).trim()).toBe(goalSha);
    if (entry === 'direct watch') {
      expect(child!.exitCode).toBeNull();
      expect(signalOwnedProcess(owned, 'SIGINT', () => child!.exitCode !== null || child!.signalCode !== null)).toBe(true);
      await vi.waitFor(() => expect(child!.exitCode, stderr).toBe(0), { timeout: 10000 });
    } else if (automatic) await vi.waitFor(() => expect(isProcessAlive(owned!.pid)).toBe(false), { timeout: 10000 });
    else await vi.waitFor(() => expect(child!.exitCode, stderr).toBe(0), { timeout: 10000 });
  } finally {
    for (const label of ['abort-target', 'abort-sibling', 'abort-ordinary']) writeFileSync(join(cwd, `release-${label}`), 'cleanup');
    try {
      if (owned === undefined && captured !== undefined) owned = await captured;
      if (owned === undefined && existsSync(join(cwd, 'started-abort-target'))) owned = readOwnedProcessMarker(readFileSync(join(cwd, 'started-abort-target'), 'utf8'));
      if (owned !== undefined) await terminateOwnedProcess(owned, () => child !== undefined && (child.exitCode !== null || child.signalCode !== null));
    } finally {
      invalidateResolvedConfigCache(cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

it.each([false, true])('rejects claim after abort in the same TaskRunner even before pending invalidation (goalTasksOnly=%s)', async (goalTasksOnly) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-claim-abort-'));
  try {
    const store = new GoalStore(cwd);
    const goal = await store.create(goalRecord());
    const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
    const runner = new TaskRunner(cwd, { goalTasksOnly });
    const running = runner.addTask('already running', { goal_id: goal.id });
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([running.name]);
    const pending = runner.addTask('aborted candidate', { goal_id: goal.id });
    const ordinary = runner.addTask('ordinary candidate');
    const active = runner.addTask('active candidate', { goal_id: other.id });
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'aborted'));
    expect(runner.claimNextTasks(2).map(({ name }) => name)).toEqual(goalTasksOnly ? [active.name] : [ordinary.name, active.name]);
    expect(runner.claimNextTasks(1)).toEqual([]);
    expect(runner.listTaskStateItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: running.name, status: 'running' }),
      expect.objectContaining({ name: pending.name, status: 'pending' }),
    ]));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it.each([
  { kind: 'run', automatic: false, exitCode: 1 },
  { kind: 'watch', automatic: false, exitCode: 1 },
  { kind: 'run', automatic: true, exitCode: 0 },
])('preserves CLI lock conflict behavior for $kind with automatic=$automatic', ({ kind, automatic, exitCode }) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'cli-lock-conflict-'));
  const runner = new TaskRunner(cwd);
  runner.addTask('ordinary pending work');
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
  const tasksFile = join(cwd, '.takt', 'tasks.yaml');
  const saved = readFileSync(tasksFile);
  const lock = acquireProjectExecutionLock(cwd, 'watch');
  try {
    const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), kind], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, [MANAGER_GOAL_TASKS_ENV]: automatic ? '1' : undefined },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exitCode);
    const output = child.stdout + child.stderr;
    if (!automatic) expect(output).toContain(`TAKT watch is already running for this project (PID ${process.pid})`);
    else expect(output).not.toContain('already running');
    expect(readFileSync(tasksFile)).toEqual(saved);
  } finally {
    lock.release();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each([false, true])('rechecks pause and resume in the same TaskRunner and preserves claim order and capacity (goalTasksOnly=%s)', async (goalTasksOnly) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-claim-pause-'));
  try {
    const store = new GoalStore(cwd);
    const goal = await store.create(goalRecord());
    const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
    const runner = new TaskRunner(cwd, { goalTasksOnly });
    const started = runner.addTask('already running', { goal_id: goal.id });
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([started.name]);
    const paused = runner.addTask('paused candidate', { goal_id: goal.id });
    const ordinary = runner.addTask('ordinary candidate');
    const active = runner.addTask('active candidate', { goal_id: other.id });
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'paused'));
    expect(runner.claimNextTasks(0)).toEqual([]);
    expect(runner.claimNextTasks(2).map(({ name }) => name)).toEqual(goalTasksOnly ? [active.name] : [ordinary.name, active.name]);
    expect(runner.listTaskStateItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: started.name, status: 'running' }),
      expect.objectContaining({ name: paused.name, status: 'pending' }),
    ]));
    expect(runner.claimNextTasks(1)).toEqual([]);
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'active'));
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([paused.name]);
    if (goalTasksOnly) expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: ordinary.name, status: 'pending' }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('lets an in-flight mock run finish while paused, saves one event and processes its original identity on human resume', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-run-pause-'));
  let child: ChildProcess | undefined;
  let owned: Promise<OwnedProcess | undefined> | undefined;
  let session: ReturnType<typeof createManagerConversationSession> | undefined;
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Goal Pause Test'], { cwd });
    execFileSync('git', ['config', 'user.email', 'goal-pause@example.com'], { cwd });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'goal pause fixture'], { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd });
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\nauto_requeue_max_attempts: 0\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'pause-run.yaml'), 'name: pause-run\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const goal = await registerFixtureGoal(cwd);
    const runner = new TaskRunner(cwd);
    const task = runner.addTask('in-flight goal task', { workflow: 'pause-run', worktree: false, goal_id: goal.id });
    const hook = join(cwd, 'pause-provider-hook.mjs');
    const mockUrl = pathToFileURL(join(process.cwd(), 'dist/infra/providers/mock.js')).href;
    writeFileSync(hook, `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider } from ${JSON.stringify(mockUrl)};
MockProvider.prototype.setup = config => ({ call: async () => {
  const manager = config.name === 'manager';
  writeFileSync(join(process.cwd(), manager ? 'manager-called' : 'worker-entered'), 'entered');
  if (!manager) {
    const deadline = Date.now() + 20000;
    while (!existsSync(join(process.cwd(), 'release-worker'))) {
      if (Date.now() > deadline) throw new Error('Test did not release the worker');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { persona: config.name, status: 'done', timestamp: new Date(),
    content: manager ? JSON.stringify({ message: 'completion processed', summary: null }) : 'completed' };
} });
`);
    child = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: '1' },
    });
    owned = captureOwnedChild(child);
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const done = new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `Run exit: ${code}`)));
    });
    void done.catch(() => {});
    await vi.waitFor(() => expect(existsSync(join(cwd, 'worker-entered'))).toBe(true), { timeout: 15000 });
    const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date(),
      content: '', structuredOutput: { message: 'completion processed', summary: null } });
    vi.spyOn(MockProvider.prototype, 'setup').mockReturnValue({ call });
    vi.spyOn(managerMcp, 'prepareManagerMcp').mockResolvedValue({ command: process.execPath, args: [], env: {}, servers: {}, dispose: async () => {} });
    session = createManagerConversationSession({ cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
      plan: { ctx: { providerType: 'mock', model: undefined, lang: 'en', provider: new MockProvider() },
        strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
    });
    expect((await session.pauseGoal({ goalId: goal.id })).kind).toBe('reply');
    expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: task.name, status: 'running' }));
    writeFileSync(join(cwd, 'release-worker'), 'finish the in-flight task');
    await done;
    expect(child.exitCode).toBe(0);
    expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: task.name, status: 'completed' }));
    const store = new GoalStore(cwd);
    const paused = await store.get(goal.id);
    expect(paused.executionStatus).toBe('paused');
    expect(paused.events).toEqual([expect.objectContaining({ kind: 'completion', taskName: task.name, processed: false, result: expect.objectContaining({ success: true, interrupted: false }) })]);
    expect(existsSync(join(cwd, 'manager-called'))).toBe(false);
    expect(call).not.toHaveBeenCalled();
    const event = paused.events![0]!;
    if (event.kind !== 'completion') throw new Error('Expected completion evidence');
    await processGoalCompletions(cwd, goal.id, {}, { taskName: event.taskName, runSlug: event.runSlug, result: event.result });
    expect((await store.get(goal.id)).events).toEqual([event]);
    expect(call).not.toHaveBeenCalled();
    expect((await session.resumeGoal({ goalId: goal.id })).kind).toBe('reply');
    const resumed = await store.get(goal.id);
    expect(resumed.executionStatus).toBe('active');
    expect(resumed.events).toEqual([{ ...event, processed: true, summary: 'completion processed' }]);
    expect(call).toHaveBeenCalledOnce();
    expect(JSON.parse(call.mock.calls[0]![0]).event.id).toBe(event.id);
  } finally {
    writeFileSync(join(cwd, 'release-worker'), 'cleanup');
    try {
      if (child !== undefined && owned !== undefined) {
        const captured = await owned;
        if (captured !== undefined) await terminateOwnedProcess(captured, () => child!.exitCode !== null || child!.signalCode !== null);
      }
      await session?.close();
    } finally {
      vi.restoreAllMocks();
      invalidateResolvedConfigCache(cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

it('executes only goal work in detached automatic runs and lets a direct run execute ordinary work', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-auto-run-'));
  const children: Array<{ child: ChildProcess; owned: Promise<OwnedProcess | undefined> }> = [];
  let worker: OwnedProcess | undefined;
  const errors: unknown[] = [];
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'auto-run fixture'], {
      cwd, encoding: 'utf8', env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Auto Run Test', GIT_AUTHOR_EMAIL: 'auto-run@example.com',
        GIT_COMMITTER_NAME: 'Auto Run Test', GIT_COMMITTER_EMAIL: 'auto-run@example.com',
      },
    }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd });
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_requeue_max_attempts: 0\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'auto-run.yaml'), 'name: auto-run\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const configDirectory = process.env.TAKT_CONFIG_DIR!;
    writeFileSync(join(configDirectory, 'config.yaml'), 'provider: mock\n');
    const goal = await registerFixtureGoal(cwd);
    mkdirSync(join(cwd, '.takt', 'goals', 'invalid-entry'));
    const runner = new TaskRunner(cwd);
    const ordinary = runner.addTask('one ordinary task', { workflow: 'auto-run', worktree: false });
    const task = runner.addTask('one goal task', { workflow: 'auto-run', worktree: false, goal_id: goal.id });
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'provider-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { MockProvider } from ${JSON.stringify(moduleUrl('infra/providers/mock.js'))};
const root = process.env.TAKT_TEST_AUTO_RUN_ROOT;
if (process.argv.includes('run')) {
  writeProcessMarker(join(root, 'run-started-' + process.pid));
  const deadline = Date.now() + 20000;
  while (!existsSync(join(root, 'release-runs'))) {
    if (Date.now() > deadline) throw new Error('Test did not release run startup');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args.includes('run')) writeFileSync(join(root, 'launch-' + process.pid), JSON.stringify(args));
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
MockProvider.prototype.setup = config => ({ call: async () => {
  const manager = config.name === 'manager';
  writeProcessMarker(join(root, manager ? 'ready-' + process.pid : 'worker-entered-' + process.pid));
  const release = join(root, manager ? 'release-turns' : 'release-worker');
  const deadline = Date.now() + 20000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Test did not release provider');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (process.argv.includes('watch')) setImmediate(() => process.emit('SIGINT'));
  return { persona: config.name, status: 'done', timestamp: new Date(), content: manager ? JSON.stringify({ message: 'ready work saved', summary: null }) : 'completed exactly once', sessionId: 'fixture-session' };
} });
`);
    const source = `
import { createManagerConversationPlan } from ${JSON.stringify(moduleUrl('features/manager/conversationPlan.js'))};
import { createManagerConversationSession } from ${JSON.stringify(moduleUrl('features/manager/conversationSession.js'))};
import { createGoalConfirmation } from ${JSON.stringify(moduleUrl('features/manager/goalConfirmation.js'))};
const cwd = process.cwd();
const session = createManagerConversationSession({ cwd, plan: createManagerConversationPlan(cwd, {}), confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: async () => { throw new Error('unused'); } } });
try {
  const result = await session.handleUserMessage({ text: 'Execute saved work' });
  if (result.kind !== 'reply') throw new Error(JSON.stringify(result));
} finally { await session.close(); }
`;
    const done = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        cwd, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
      });
      const owned = captureOwnedChild(child);
      void owned.catch(() => {});
      children.push({ child, owned });
      let errors = '';
      child.stderr!.on('data', (chunk) => { errors += String(chunk); });
      const exit = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `Parent exit: ${code}`)));
      });
      void exit.catch(() => {});
      return exit;
    });
    await Promise.race([
      vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('ready-'))).toHaveLength(2), { timeout: 15000 }),
      Promise.all(done).then(() => { throw new Error('Conversation parents exited before entering their turns'); }),
    ]);
    writeFileSync(join(cwd, 'release-turns'), 'release both turns');
    await Promise.all(done);
    await vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('run-started-'))).toHaveLength(2), { timeout: 15000 });
    const launches = readdirSync(cwd).filter((file) => file.startsWith('launch-'));
    expect(launches).toHaveLength(2);
    for (const file of launches) expect(JSON.parse(readFileSync(join(cwd, file), 'utf8'))).toEqual([expect.stringMatching(/dist\/app\/cli\/index\.js$/), 'run']);
    writeFileSync(join(cwd, 'release-runs'), 'compete for execution lock');
    await vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(1), { timeout: 15000 });
    const workerMarker = readdirSync(cwd).find((file) => file.startsWith('worker-entered-'))!;
    worker = readOwnedProcessMarker(readFileSync(join(cwd, workerMarker), 'utf8'));
    const runs = readdirSync(cwd).filter((file) => file.startsWith('run-started-')).map((file) => readOwnedProcessMarker(readFileSync(join(cwd, file), 'utf8')));
    const loser = runs.find(({ pid }) => pid !== worker!.pid)!;
    await vi.waitFor(() => expect(isProcessAlive(loser.pid)).toBe(false), { timeout: 15000 });
    expect(children.every(({ child }) => child.exitCode === 0)).toBe(true);
    expect(isProcessAlive(worker.pid)).toBe(true);
    writeFileSync(join(cwd, 'release-worker'), 'continue after both parents exit');
    await vi.waitFor(() => expect(new TaskRunner(cwd).listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: ordinary.name, kind: 'pending' }, { name: task.name, kind: 'completed' },
    ]), { timeout: 15000 });
    await vi.waitFor(() => expect(isProcessAlive(worker!.pid)).toBe(false), { timeout: 15000 });
    expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(1);
    const direct = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
    });
    const owned = captureOwnedChild(direct);
    void owned.catch(() => {});
    children.push({ child: direct, owned });
    let directErrors = '';
    direct.stderr!.on('data', (chunk) => { directErrors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      direct.once('error', reject);
      direct.once('exit', (code) => code === 0 ? resolve() : reject(new Error(directErrors || `Direct run exit: ${code}`)));
    });
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: ordinary.name, kind: 'completed' }, { name: task.name, kind: 'completed' },
    ]);
    expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(2);
    const watched = runner.addTask('ordinary task for watch', { workflow: 'auto-run', worktree: false });
    const watch = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'watch'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
    });
    const watchOwned = captureOwnedChild(watch);
    void watchOwned.catch(() => {});
    children.push({ child: watch, owned: watchOwned });
    let watchErrors = '';
    watch.stderr!.on('data', (chunk) => { watchErrors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      watch.once('error', reject);
      watch.once('exit', (code) => code === 0 ? resolve() : reject(new Error(watchErrors || `Watch exit: ${code}`)));
    });
    expect(runner.listAllTaskItems().find(({ name }) => name === watched.name)?.kind).toBe('completed');
    expect(readManagerRunFailures(cwd).length).toBeGreaterThan(0);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      writeFileSync(join(cwd, 'release-turns'), 'cleanup');
      writeFileSync(join(cwd, 'release-worker'), 'cleanup');
      writeFileSync(join(cwd, 'release-runs'), 'cleanup');
      const runs = readdirSync(cwd).filter((file) => file.startsWith('run-started-')).map((file) => readOwnedProcessMarker(readFileSync(join(cwd, file), 'utf8')));
      const ended = await Promise.allSettled([
        ...children.map(async ({ child, owned }) => {
          const captured = await owned;
          if (captured !== undefined) await terminateOwnedProcess(captured, () => child.exitCode !== null || child.signalCode !== null);
        }),
        ...runs.map((owned) => terminateOwnedProcess(owned, () => false)),
      ]);
      const cleanupErrors = ended.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      errors.push(...cleanupErrors);
      if (cleanupErrors.length === 0) rmSync(cwd, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Test or cleanup failed; fixture: ${cwd}`);
});

it('skips launch for goal work enqueued under ownership and launches once after release rechecks the queue', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-empty-queue-'));
  try {
    await new GoalStore(cwd).create({ ...goalRecord(), id: '00000000-0000-4000-8000-000000000001' });
    const runner = new TaskRunner(cwd);
    runner.ensureDirs();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'empty-queue-hook.mjs');
    const launchMarker = join(cwd, 'relaunch.json');
    writeFileSync(hook, `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { TaskRunner } from ${JSON.stringify(moduleUrl('infra/task/runner.js'))};
import { getProjectExecutionOwner } from ${JSON.stringify(moduleUrl('infra/task/project-execution-lock.js'))};
import { ensureManagerRun } from ${JSON.stringify(moduleUrl('features/manager/autoRun.js'))};
const cwd = ${JSON.stringify(cwd)};
const events = [];
let launches = 0;
let emptyReads = 0;
const claim = TaskRunner.prototype.claimNextTasks;
TaskRunner.prototype.claimNextTasks = function (count) {
  const tasks = claim.call(this, count);
  // Wait for the read after manager recovery so the pool cannot consume the injected task.
  if (tasks.length !== 0 || ++emptyReads !== 2) return tasks;
  events.push('read-empty');
  assert.equal(getProjectExecutionOwner(cwd)?.pid, process.pid);
  this.addTask('late goal task', {
    goal_id: '00000000-0000-4000-8000-000000000001', worktree: false,
  });
  events.push('saved-with-owner');
  void ensureManagerRun(cwd);
  assert.equal(launches, 0, 'enqueue must skip launch while owner is alive');
  assert.equal(getProjectExecutionOwner(cwd)?.pid, process.pid);
  events.push('enqueue-start-skipped');
  return tasks;
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args.includes('run')) return spawn(command, args, options);
  assert.equal(getProjectExecutionOwner(cwd), undefined);
  events.push('spawn-without-owner');
  launches++;
  writeFileSync(${JSON.stringify(launchMarker)}, JSON.stringify({
    events, launches, args, detached: options.detached,
    automatic: options.env[${JSON.stringify(MANAGER_GOAL_TASKS_ENV)}],
  }));
  const child = Object.assign(new EventEmitter(), { unref() {} });
  queueMicrotask(() => child.emit('spawn'));
  return child;
};
syncBuiltinESMExports();
`);
    const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: '1' },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchMarker, 'utf8'))).toEqual({
      events: ['read-empty', 'saved-with-owner', 'enqueue-start-skipped', 'spawn-without-owner'],
      launches: 1, args: [join(process.cwd(), 'dist/app/cli/index.js'), 'run'],
      detached: true, automatic: '1',
    });
    expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ kind: 'pending', goalId: '00000000-0000-4000-8000-000000000001' })]);
    const lock = acquireProjectExecutionLock(cwd, 'run');
    lock.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('does not spawn another automatic run when initial task processing fails with goal work still pending', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-startup-failure-'));
  try {
    await new GoalStore(cwd).create({ ...goalRecord(), id: '00000000-0000-4000-8000-000000000001' });
    const runner = new TaskRunner(cwd);
    const task = runner.addTask('saved goal task', {
      goal_id: '00000000-0000-4000-8000-000000000001', worktree: false,
    });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'startup-failure-hook.mjs');
    const launchMarker = join(cwd, 'unexpected-relaunch');
    writeFileSync(hook, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { TaskRunner } from ${JSON.stringify(moduleUrl('infra/task/runner.js'))};
TaskRunner.prototype.failInterruptedRunningTasks = () => { throw new Error('injected initial processing failure'); };
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('run')) {
    writeFileSync(${JSON.stringify(launchMarker)}, 'attempted relaunch');
    throw new Error('Test prevents an unbounded relaunch');
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
    const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: '1' },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain('injected initial processing failure');
    expect(existsSync(launchMarker)).toBe(false);
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: task.name, kind: 'pending' },
    ]);
    const lock = acquireProjectExecutionLock(cwd, 'run');
    lock.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
