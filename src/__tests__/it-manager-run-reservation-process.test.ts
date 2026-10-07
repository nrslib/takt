import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { TaskRunner } from '../infra/task/runner.js';
import { isProcessAlive } from '../infra/task/process.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { readManagerRunState } from '../infra/task/manager-run-state.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { TaskStore } from '../infra/task/store.js';
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import { captureOwnedChild, ownedProcessMarkerScript, readOwnedProcessMarker, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

it.each([
  { format: 'content', available: true }, { format: 'content', available: false },
  { format: 'task_dir', available: true }, { format: 'task_dir', available: false },
  { format: 'content_file', available: true }, { format: 'content_file', available: false },
] as const)('judges runnable pending work from real $format (available: $available)', async ({ format, available }) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-pending-content-'));
  let lock: ReturnType<typeof acquireProjectExecutionLock> | undefined;
  try {
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\n');
    new TaskRunner(cwd).addTask('work', { worktree: false });
    if (format === 'task_dir' && available) {
      mkdirSync(join(cwd, '.takt/tasks/spec-fixture'), { recursive: true });
      writeFileSync(join(cwd, '.takt/tasks/spec-fixture/order.md'), 'work');
    }
    if (format === 'content_file' && available) writeFileSync(join(cwd, 'task.md'), 'work');
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => ({
      ...task, content: format === 'content' ? task.content : undefined,
      ...(format === 'task_dir' ? { task_dir: '.takt/tasks/spec-fixture' } : {}),
      ...(format === 'content_file' ? { content_file: 'task.md' } : {}),
      ...(format === 'content' && !available ? {
        status: 'completed' as const, started_at: task.created_at, completed_at: task.created_at,
      } : {}),
    })) }));
    lock = acquireProjectExecutionLock(cwd, 'watch');
    await ensureManagerRun(cwd, 'turn-ended');
    expect(readManagerRunState(cwd).requested).toBe(available);
    expect(readManagerRunState(cwd).reservation).toBeUndefined();
  } finally { lock?.release(); rmSync(cwd, { recursive: true, force: true }); }
});

it('preserves a launch request for readable pending work mixed with an unreadable spec', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-mixed-pending-'));
  let lock: ReturnType<typeof acquireProjectExecutionLock> | undefined;
  try {
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\n');
    const runner = new TaskRunner(cwd);
    runner.addTask('unreadable spec', { worktree: false });
    const good = runner.addTask('readable work', { worktree: false });
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === good.name ? task : { ...task, content: undefined, task_dir: '.takt/tasks/missing-spec' }) }));
    lock = acquireProjectExecutionLock(cwd, 'watch');
    await ensureManagerRun(cwd, 'turn-ended');
    expect(readManagerRunState(cwd).requested).toBe(true);
    expect(readManagerRunState(cwd).reservation).toBeUndefined();
  } finally { lock?.release(); rmSync(cwd, { recursive: true, force: true }); }
});

it('persists a real child loading failure before adoption for display and later recovery', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-loading-failure-'));
  try {
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\n');
    const task = new TaskRunner(cwd).addTask('pending work', { worktree: false });
    const marker = join(cwd, 'loading-started');
    const hook = join(cwd, 'loading-failure.mjs');
    writeFileSync(hook, `import { writeFileSync } from 'node:fs';\nif (process.argv.includes('run')) {\n  writeFileSync(${JSON.stringify(marker)}, 'started');\n  throw new Error('injected module loading failure');\n}\n`);
    vi.stubEnv('NODE_OPTIONS', `--import ${pathToFileURL(hook).href}`);
    await ensureManagerRun(cwd, 'turn-ended');
    expect(existsSync(marker)).toBe(true);
    const state = readManagerRunState(cwd);
    expect(state.reservation).toBeUndefined();
    expect(state.failures).toHaveLength(1);
    expect(new TaskRunner(cwd).listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    expect(await readManagerDisplayEvents(cwd)).toEqual({ events: [{ id: state.failures[0]!.id, message: state.failures[0]!.message }], diagnostics: [] });
    const log = readdirSync(join(cwd, '.takt', 'manager-logs'))[0]!;
    expect(readFileSync(join(cwd, '.takt', 'manager-logs', log), 'utf8')).toContain('injected module loading failure');
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('atomically reserves one built CLI run when independent conversation processes finish together', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-reservation-'));
  const children: Array<{ child: ChildProcess; owned: Promise<OwnedProcess | undefined> }> = [];
  let worker: OwnedProcess | undefined;
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'reservation fixture'], { cwd, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd });
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_requeue_max_attempts: 0\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'reservation.yaml'), 'name: reservation\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const configDirectory = process.env.TAKT_CONFIG_DIR!;
    writeFileSync(join(configDirectory, 'config.yaml'), 'provider: mock\n');
    const task = new TaskRunner(cwd).addTask('one ordinary task', { workflow: 'reservation', worktree: false });
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'provider-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { MockProvider } from ${JSON.stringify(moduleUrl('infra/providers/mock.js'))};
const root = process.env.TAKT_TEST_RESERVATION_ROOT;
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args.includes('run')) writeFileSync(join(root, 'launch-' + process.pid), JSON.stringify(args));
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
MockProvider.prototype.setup = config => ({ call: async () => {
  const manager = config.name === 'manager';
  writeProcessMarker(join(root, manager ? 'ready-' + process.pid : 'worker-entered'));
  const release = join(root, manager ? 'release-turns' : 'release-worker');
  const deadline = Date.now() + 20000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Test did not release provider');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
        env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_RESERVATION_ROOT: cwd },
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
    await vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('ready-'))).toHaveLength(2), { timeout: 15000 });
    writeFileSync(join(cwd, 'release-turns'), 'release both turns');
    await Promise.all(done);
    await vi.waitFor(() => expect(existsSync(join(cwd, 'worker-entered'))).toBe(true), { timeout: 15000 });
    worker = readOwnedProcessMarker(readFileSync(join(cwd, 'worker-entered'), 'utf8'));
    const launches = readdirSync(cwd).filter((file) => file.startsWith('launch-'));
    expect(launches).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(cwd, launches[0]!), 'utf8'))).toEqual([expect.stringMatching(/dist\/app\/cli\/index\.js$/), 'run']);
    expect(children.every(({ child }) => child.exitCode === 0)).toBe(true);
    expect(isProcessAlive(worker.pid)).toBe(true);
    writeFileSync(join(cwd, 'release-worker'), 'continue after both parents exit');
    await vi.waitFor(() => expect(new TaskRunner(cwd).listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: task.name, kind: 'completed' }]), { timeout: 15000 });
    await vi.waitFor(() => expect(isProcessAlive(worker!.pid)).toBe(false), { timeout: 15000 });
  } finally {
    writeFileSync(join(cwd, 'release-turns'), 'cleanup');
    writeFileSync(join(cwd, 'release-worker'), 'cleanup');
    const errors: unknown[] = [];
    if (worker === undefined && existsSync(join(cwd, 'worker-entered'))) {
      try { worker = readOwnedProcessMarker(readFileSync(join(cwd, 'worker-entered'), 'utf8')); }
      catch (error) { errors.push(error); }
    }
    try {
      const reserved = readManagerRunState(cwd).reservation?.child;
      if (reserved !== undefined) {
        const reservation = readOwnedProcessMarker(JSON.stringify(reserved));
        await terminateOwnedProcess(reservation, () => false);
      }
    } catch (error) { errors.push(error); }
    const ended = await Promise.allSettled([
      ...children.map(async ({ child, owned }) => {
        const captured = await owned;
        if (captured !== undefined) await terminateOwnedProcess(captured, () => child.exitCode !== null || child.signalCode !== null);
      }),
      ...(worker === undefined ? [] : [terminateOwnedProcess(worker, () => false)]),
    ]);
    errors.push(...ended.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, `Cleanup failed; retaining ${cwd}`);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60000);
