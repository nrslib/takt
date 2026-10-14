import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDaemon } from '../features/daemon/runDaemon.js';

const doubles = vi.hoisted(() => ({
  projects: vi.fn(), work: vi.fn(), create: vi.fn(), ensure: vi.fn(),
  registerOwner: vi.fn(), removeOwner: vi.fn(), delay: vi.fn(),
  patrol: vi.fn(),
}));
vi.mock('../features/daemon/projects.js', () => ({ listDaemonProjects: doubles.projects, hasDaemonProjectWork: doubles.work }));
vi.mock('../features/manager/runEventManager.js', () => ({ createRunEventManager: doubles.create }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/daemon/owner.js', () => ({
  registerDaemonOwner: doubles.registerOwner, removeDaemonOwner: doubles.removeOwner,
}));
vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: () => ({ startTime: 'test-start' }) }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: () => ({ cliPath: '/cli.js' }) }));
vi.mock('../shared/utils/debug.js', () => ({ initDebugLogger: vi.fn(), createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('node:timers/promises', () => ({ setTimeout: doubles.delay }));
vi.mock('../features/manager/patrol.js', () => ({ enqueueDueGoalPatrols: doubles.patrol }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: () => ({ patrolInterval: 1800 }) }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.registerOwner.mockReturnValue(true);
  doubles.projects.mockResolvedValue(['/project-a', '/project-b']);
  doubles.work.mockResolvedValue(false);
  doubles.delay.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

it('exits without polling or removing ownership when another daemon is registered', async () => {
  doubles.registerOwner.mockReturnValue(false);
  const before = process.rawListeners('SIGTERM');
  await runDaemon();
  expect(doubles.registerOwner).toHaveBeenCalledExactlyOnceWith(process.env.TAKT_CONFIG_DIR, {
    pid: process.pid, identity: { startTime: 'test-start' }, version: expect.any(String), cliPath: '/cli.js',
  });
  expect(doubles.delay).not.toHaveBeenCalled();
  expect(doubles.projects).not.toHaveBeenCalled();
  expect(doubles.removeOwner).not.toHaveBeenCalled();
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});

it('processes projects sequentially with a fixed event limit, then checks run startup and remaining work', async () => {
  const calls: string[] = [];
  const managers = ['/project-a', '/project-b'].map((cwd) => ({
    processPending: vi.fn(async (signal: AbortSignal, limit: number) => {
      expect(signal.aborted).toBe(false);
      expect(limit).toBe(10);
      calls.push(`events:${cwd}`);
      return true;
    }),
    close: vi.fn(async () => {}),
  }));
  doubles.create.mockReturnValueOnce(managers[0]).mockReturnValueOnce(managers[1]);
  doubles.ensure.mockImplementation(async (cwd: string) => { calls.push(`run:${cwd}`); });
  doubles.patrol.mockImplementation(async (cwd: string, interval: number) => {
    expect(interval).toBe(1800); calls.push(`patrol:${cwd}`);
  });
  doubles.work.mockImplementation(async (cwd: string) => { calls.push(`work:${cwd}`); return false; });

  await runDaemon();

  expect(calls).toEqual([
    'patrol:/project-a', 'events:/project-a', 'run:/project-a', 'work:/project-a',
    'patrol:/project-b', 'events:/project-b', 'run:/project-b', 'work:/project-b',
  ]);
  expect(doubles.create.mock.calls).toEqual([['/project-a'], ['/project-b']]);
  for (const manager of managers) expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('keeps each project manager across polling rounds so failed events stay excluded', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.work.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const manager = { processPending: vi.fn(async () => false), close: vi.fn(async () => {}) };
  doubles.create.mockReturnValue(manager);
  await runDaemon();
  expect(doubles.create).toHaveBeenCalledExactlyOnceWith('/project');
  expect(manager.processPending).toHaveBeenCalledTimes(2);
  expect(doubles.patrol).toHaveBeenCalledTimes(2);
  expect(doubles.ensure).toHaveBeenCalledTimes(2);
  expect(manager.close).toHaveBeenCalledOnce();
});

it('waits for one project turn to finish before processing the next project', async () => {
  let finish!: () => void;
  const first = { processPending: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), close: vi.fn() };
  const second = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const daemon = runDaemon();
  await vi.waitFor(() => expect(first.processPending).toHaveBeenCalledOnce());
  expect(second.processPending).not.toHaveBeenCalled();
  expect(doubles.ensure).not.toHaveBeenCalled();
  finish();
  await daemon;
  expect(second.processPending).toHaveBeenCalledOnce();
  expect(doubles.ensure.mock.calls).toEqual([['/project-a'], ['/project-b']]);
});

it('continues other projects after a project error and inspects it again on the next poll', async () => {
  const first = { processPending: vi.fn().mockRejectedValueOnce(new Error('invalid inbox')).mockResolvedValue(false), close: vi.fn() };
  const second = { processPending: vi.fn().mockResolvedValue(false), close: vi.fn() };
  doubles.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await runDaemon();
  expect(first.processPending).toHaveBeenCalledTimes(2);
  expect(second.processPending).toHaveBeenCalledTimes(2);
  expect(doubles.ensure.mock.calls).toEqual([['/project-b'], ['/project-a'], ['/project-b']]);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

it('aborts an in-flight turn on stop, closes all sessions and removes signal handlers', async () => {
  const before = process.rawListeners('SIGTERM');
  const manager = {
    processPending: vi.fn(async (signal: AbortSignal) => {
      const stop = process.rawListeners('SIGTERM').find((listener) => !before.includes(listener));
      stop!.call(process, 'SIGTERM');
      expect(signal.aborted).toBe(true);
      return false;
    }),
    close: vi.fn(async () => {}),
  };
  doubles.create.mockReturnValue(manager);
  await runDaemon();
  expect(doubles.ensure).not.toHaveBeenCalled();
  expect(doubles.create).toHaveBeenCalledOnce();
  expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});

it('removes ownership and closes other sessions even when one session fails to close', async () => {
  const first = { processPending: vi.fn(), close: vi.fn().mockRejectedValue(new Error('close failed')) };
  const second = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await runDaemon();
  expect(second.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});
