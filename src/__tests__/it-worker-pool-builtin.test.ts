import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { packageVersion } from '../shared/package-info.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { WorkerRegistry } from '../infra/worker-pool/workerRegistry.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';

function workerCliFixture() {
  const directory = getGlobalConfigDir();
  const home = mkdtempSync(join(directory, 'worker-cli-home-'));
  const cwd = mkdtempSync(join(directory, 'worker-cli-cwd-'));
  const configDirectory = join(home, '.takt');
  return {
    configDirectory,
    run(args: readonly string[]) {
      return new AsyncCommand().run({
        executable: process.execPath,
        args: [join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier', 'worker', ...args],
        cwd, env: { ...process.env, HOME: home, USERPROFILE: home, TAKT_CONFIG_DIR: configDirectory, NODE_OPTIONS: '' },
        maxOutputBytes: 64 * 1024,
      }, { signal: new AbortController().signal, timeoutMs: 10_000 });
    },
  };
}

it('persists worker registration for list and remove in separate CLI processes', async () => {
  const f = workerCliFixture();
  const registered = await f.run(['add', 'w1', '--concurrency', '2']);
  expect(registered.code, Buffer.from(registered.stderr).toString()).toBe(0);
  const token = Buffer.from(registered.stdout).toString().trim();
  expect(token.split('\n')).toHaveLength(1);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const listed = await f.run(['list']);
  expect(listed.code, Buffer.from(listed.stderr).toString()).toBe(0);
  const output = Buffer.from(listed.stdout).toString();
  expect(output).toMatch(/\bw1\b/);
  expect(output).toMatch(/\b2\b/);
  expect(output).not.toContain(token);

  const removed = await f.run(['remove', 'w1']);
  expect(removed.code, Buffer.from(removed.stderr).toString()).toBe(0);
  const afterRemoval = await f.run(['list']);
  expect(afterRemoval.code, Buffer.from(afterRemoval.stderr).toString()).toBe(0);
  expect(Buffer.from(afterRemoval.stdout).toString()).not.toMatch(/\bw1\b/);
});

it('rejects a non-localhost HTTP URL before opening a connection or initializing worker configuration', async () => {
  const f = workerCliFixture();
  const connections = vi.fn();
  const server = createServer((_request, response) => { response.writeHead(403).end('Unexpected worker connection'); });
  server.on('connection', connections);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Test listener has no TCP address');
    expect(existsSync(f.configDirectory)).toBe(false);

    const result = await f.run(['--url', `http://0.0.0.0:${address.port}`, '--token', 'rejected-worker-test-token']);

    expect(result.code).not.toBeNull();
    expect(result.code).not.toBe(0);
    expect(Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString()).toMatch(/https/i);
    expect(connections).not.toHaveBeenCalled();
    expect(existsSync(f.configDirectory)).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  }
});

it.each([false, true])('keeps mergeTask=%s pending and exposes its waiting reason through the real daemon', async (mergeTask) => {
  const directory = getGlobalConfigDir();
  const project = mkdtempSync(join(directory, 'worker-pool-project-'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const controller = new AbortController();
  try {
    writeFileSync(join(directory, 'config.yaml'), 'provider: mock\ndaemon:\n  builtin_worker:\n    concurrency: 0\n');
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nconcurrency: 3\n');
    const record = goalRecord();
    const prUrl = 'https://github.com/example/project/pull/42';
    const headSha = 'a'.repeat(40);
    const goal = await new GoalStore(project).create(mergeTask ? {
      ...record, status: 'awaiting_merge', pullRequest: { number: 42, url: prUrl },
      completion: { goalBranch: record.branch, goalSha: headSha, targetBranch: record.integrationBranch,
        summary: 'Ready for merge', instructions: [], changeSummary: {
          filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false,
        } },
    } : record);
    const runner = new TaskRunner(project);
    const task = mergeTask ? runner.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl,
      headBranch: goal.branch, baseBranch: goal.integrationBranch, headSha,
      headRepositoryUrl: project, headRepositoryPushUrls: [project],
      method: 'squash', workflow: 'merge-review-fix-simple',
      worktreePath: join(project, 'merge-clone'), threatCheckMaxDiffBytes: 1024,
    }) : runner.addTask('pending goal work', { goal_id: goal.id, worktree: false });
    const command = new AsyncCommand();
    const executeCommand = command.run.bind(command);
    vi.spyOn(AsyncCommand.prototype, 'run').mockImplementation(async (request, options) => {
      if (request.executable !== 'gh') return executeCommand(request, options);
      options.signal.throwIfAborted();
      return { code: 0, signal: null, truncated: false, stderr: Buffer.alloc(0),
        stdout: Buffer.from(JSON.stringify({ number: 42, url: prUrl, state: 'OPEN',
          headRefName: goal.branch, baseRefName: goal.integrationBranch, mergeable: 'MERGEABLE' })),
      };
    });
    await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
    const identity = getSelfProcessIdentity();
    if (identity === undefined) throw new Error('Test process identity is unavailable');
    const owner = { pid: process.pid, identity, version: packageVersion, cliPath: daemonEntryPath() };
    await writeDaemonOwner(directory, owner);
    const turns = new ControlledTurnRunner();
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { turns.bus = bus; return turns; },
    });

    await vi.waitFor(async () => {
      const response = await listTaktTasks({ cwd: project });
      expect(response.isError).toBeUndefined();
      const output = JSON.parse(firstTextContent(response.content)) as { tasks: Record<string, unknown>[] };
      expect(output.tasks).toEqual([expect.objectContaining({ name: task.name, status: 'pending',
        waitingReason: expect.stringMatching(/no executable worker.*available/i),
      })]);
    }, { timeout: 10_000 });
    const saved = new TaskStore(project).read().tasks[0]!;
    expect(saved).toMatchObject({ status: 'pending', started_at: null, completed_at: null });
    expect(saved.owner_pid == null).toBe(true);
    expect(saved).not.toHaveProperty('execution_id');
    expect(saved).not.toHaveProperty('worker_name');
  } finally {
    controller.abort();
    await daemon?.close();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'darwin')('executes originless work on the builtin worker while an isolated remote worker has an available slot', async () => {
  const directory = getGlobalConfigDir();
  const project = mkdtempSync(join(directory, 'originless-project-'));
  const home = mkdtempSync(join(tmpdir(), 'originless-remote-worker-'));
  const controller = new AbortController();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    writeFileSync(join(directory, 'config.yaml'), 'provider: mock\ndaemon:\n  builtin_worker:\n    concurrency: 1\n  remote_worker:\n    host: 127.0.0.1\n    port: 0\n');
    invalidateGlobalConfigCache();
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.test'],
      ['commit', '--allow-empty', '-m', 'fixture']]) {
      expect(spawnSync('git', ['-C', project, ...args]).status).toBe(0);
    }
    mkdirSync(join(project, '.takt/workflows'), { recursive: true });
    writeFileSync(join(project, '.takt/config.yaml'), 'provider: mock\nconcurrency: 1\n');
    writeFileSync(join(project, '.takt/workflows/originless.yaml'), 'name: originless\nsteps:\n  - name: work\n    instruction: Complete originless work\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const builtinHook = join(home, 'builtin-hook.mjs');
    writeFileSync(builtinHook, `
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MockProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/infra/providers/mock.ts')).href)};
MockProvider.prototype.setup = config => ({ call: async (_prompt, options) => {
  writeFileSync(${JSON.stringify(join(home, 'builtin.json'))}, JSON.stringify({ pid: process.pid, cwd: options.cwd }));
  return { persona: config.name, status: 'done', content: 'Originless work completed', timestamp: new Date(), sessionId: randomUUID() };
} });
`);
    const tsx = createRequire(import.meta.url).resolve('tsx/esm');
    vi.stubEnv('NODE_OPTIONS', `--import ${JSON.stringify(tsx)} --import ${JSON.stringify(pathToFileURL(builtinHook).href)}`);
    const goal = await new GoalStore(project).create(goalRecord());
    expect(spawnSync('git', ['-C', project, 'branch', goal.branch]).status).toBe(0);
    await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
    const identity = getSelfProcessIdentity();
    if (identity === undefined) throw new Error('Test process identity is unavailable');
    const owner = { pid: process.pid, identity, version: packageVersion, cliPath: daemonEntryPath() };
    await writeDaemonOwner(directory, owner);
    const registered = await new WorkerRegistry(directory).add('w1', 1);
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { const turns = new ControlledTurnRunner(); turns.bus = bus; return turns; } });
    const probe = join(home, 'probe.mjs');
    writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
let denied; try { readFileSync(${JSON.stringify(join(project, '.takt/config.yaml'))}); } catch (error) { denied = error.code; }
writeFileSync(${JSON.stringify(join(home, 'probe.json'))}, JSON.stringify({ denied }));`);
    worker = spawn('/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(directory)}))`,
      process.execPath, join(process.cwd(), 'dist/app/cli/index.js'), '--no-update-notifier', 'worker',
      '--url', `http://127.0.0.1:${daemon.workerPort}`, '--token', registered.token], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, TAKT_CONFIG_DIR: join(home, '.takt'),
        NODE_OPTIONS: `--import ${JSON.stringify(pathToFileURL(probe).href)}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    worker.stdout?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
    worker.stderr?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
    closed = new Promise<void>((resolve) => worker!.once('close', () => resolve()));
    await vi.waitFor(() => expect(output).toContain('w1 connected'), { timeout: 20_000 });
    expect(JSON.parse(readFileSync(join(home, 'probe.json'), 'utf8'))).toEqual({ denied: 'EPERM' });
    const runner = new TaskRunner(project);
    const task = runner.addTask('originless work', { goal_id: goal.id, base_branch: goal.branch, workflow: 'originless', worktree: false });
    await vi.waitFor(() => expect(runner.listTaskStateItems().find((item) => item.name === task.name)).toMatchObject({
      status: 'completed', workerName: 'builtin', completion: { success: true } }), { timeout: 30_000 });
    const observed = JSON.parse(readFileSync(join(home, 'builtin.json'), 'utf8'));
    expect(observed).toMatchObject({ cwd: project });
    expect(observed.pid).not.toBe(worker.pid);
    expect(observed.pid).not.toBe(process.pid);
    expect(new TaskStore(project).read().tasks[0]!.remote_assignment).toBeUndefined();
    expect(existsSync(join(home, '.takt/worker-executions'))).toBe(false);
    expect(worker.exitCode).toBeNull();
  } finally {
    if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
    const timer = setTimeout(() => worker?.kill('SIGKILL'), 5000);
    await closed; clearTimeout(timer);
    controller.abort(); await daemon?.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
