import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDaemon } from '../features/daemon/runDaemon.js';

const doubles = vi.hoisted(() => ({
  projects: vi.fn(), work: vi.fn(), create: vi.fn(), ensure: vi.fn(),
  registerOwner: vi.fn(), removeOwner: vi.fn(), delay: vi.fn(),
  patrol: vi.fn(), config: vi.fn(), notify: vi.fn(), logError: vi.fn(),
}));
vi.mock('../features/daemon/projects.js', () => ({ listDaemonProjects: doubles.projects, hasDaemonProjectWork: doubles.work }));
vi.mock('../features/manager/runEventManager.js', () => ({ createRunEventManager: doubles.create }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/daemon/owner.js', () => ({
  registerDaemonOwner: doubles.registerOwner, removeDaemonOwner: doubles.removeOwner,
}));
vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: () => ({ startTime: 'test-start' }) }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: () => ({ cliPath: '/cli.js' }) }));
vi.mock('../shared/utils/debug.js', () => ({ initDebugLogger: vi.fn(), createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: doubles.logError }) }));
vi.mock('node:timers/promises', () => ({ setTimeout: doubles.delay }));
vi.mock('../features/manager/patrol.js', () => ({ enqueueDueGoalPatrols: doubles.patrol }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.notify }));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.registerOwner.mockReturnValue(true);
  doubles.projects.mockResolvedValue(['/project-a', '/project-b']);
  doubles.work.mockResolvedValue(false);
  doubles.delay.mockResolvedValue(undefined);
  doubles.config.mockReturnValue({ patrolInterval: 1800 });
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
  expect(doubles.ensure.mock.calls).toEqual([
    ['/project-a', { notifyOnFailure: false }], ['/project-b', { notifyOnFailure: false }],
  ]);
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
  expect(doubles.ensure.mock.calls).toEqual([
    ['/project-a', { notifyOnFailure: false }], ['/project-b', { notifyOnFailure: false }],
  ]);
});

it('continues other projects after a project error and inspects it again on the next poll', async () => {
  const first = { processPending: vi.fn().mockRejectedValueOnce(new Error('invalid inbox')).mockResolvedValue(false), close: vi.fn() };
  const second = { processPending: vi.fn().mockResolvedValue(false), close: vi.fn() };
  doubles.create.mockReturnValueOnce(first).mockReturnValueOnce(second);
  doubles.work.mockResolvedValueOnce(true);
  await runDaemon();
  expect(first.processPending).toHaveBeenCalledTimes(2);
  expect(second.processPending).toHaveBeenCalledTimes(2);
  expect(doubles.ensure.mock.calls).toEqual([
    ['/project-b', { notifyOnFailure: false }], ['/project-a', { notifyOnFailure: false }],
    ['/project-b', { notifyOnFailure: false }],
  ]);
  expect(doubles.work).toHaveBeenCalledTimes(4);
  expect(doubles.notify).not.toHaveBeenCalled();
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

it.each(['run', 'events', 'work', 'task-read'] as const)('reports repeated %s polling failures only at patrol intervals', async (stage) => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  const failure = new Error('polling failed');
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => {
    // Before rounds 3 and 5, only the completed patrol intervals may have notified.
    expect(doubles.notify).toHaveBeenCalledTimes(round < 3 ? 0 : round < 5 ? 1 : 2);
    round++;
  });
  if (stage === 'run') doubles.ensure.mockImplementation(async () => { if (round < 6) throw failure; });
  if (stage === 'events') manager.processPending.mockImplementation(async () => { if (round < 6) throw failure; });
  doubles.work.mockImplementation(async (_cwd: string, onReadError: (error: unknown) => void) => {
    if (round === 6) {
      return false;
    }
    if (stage === 'work') throw failure;
    if (stage === 'task-read') onReadError(failure);
    return true;
  });
  // A second healthy project supplies real work when inspection itself throws.
  if (stage === 'work') {
    doubles.projects.mockResolvedValue(['/project', '/healthy']);
    doubles.work.mockImplementation(async (cwd: string) => {
      if (round === 6) return false;
      if (cwd === '/project') throw failure;
      return true;
    });
  }

  await runDaemon();

  expect(round).toBe(6);
  expect(doubles.notify.mock.calls).toEqual([
    ['/project', undefined, failure], ['/project', undefined, failure],
  ]);
  expect(doubles.logError).toHaveBeenCalledTimes(stage === 'task-read' ? 0 : 5);
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('clears the failure start time on success before the first notification', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => {
    expect(doubles.notify).toHaveBeenCalledTimes(round < 5 ? 0 : 1);
    round++;
  });
  const failure = new Error('read failed');
  doubles.ensure.mockImplementation(async () => { if (round !== 2 && round !== 6) throw failure; });
  doubles.work.mockImplementation(async () => round < 6);

  await runDaemon();

  expect(round).toBe(6);
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
});

it('clears the last notification time on recovery and uses the latest error after a new failure', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => {
    expect(doubles.notify).toHaveBeenCalledTimes(round < 3 ? 0 : round < 7 ? 1 : 2);
    round++;
  });
  const failures = Array.from({ length: 8 }, (_, i) => new Error(`failure ${i + 1}`));
  doubles.ensure.mockImplementation(async () => { if (round !== 4 && round !== 8) throw failures[round - 1]; });
  doubles.work.mockImplementation(async () => round < 8);

  await runDaemon();

  expect(round).toBe(8);
  expect(doubles.notify.mock.calls).toEqual([
    ['/project', undefined, failures[2]], ['/project', undefined, failures[6]],
  ]);
});

it('uses each project patrol interval independently', async () => {
  doubles.config.mockImplementation((cwd: string) => ({ patrolInterval: cwd === '/project-a' ? 1 : 2 }));
  doubles.create.mockImplementation(() => ({ processPending: vi.fn(), close: vi.fn() }));
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => { round++; });
  const failure = new Error('failed');
  doubles.ensure.mockImplementation(async () => { if (round < 6) throw failure; });
  doubles.work.mockImplementation(async () => round < 6);
  const notifications: Array<{ cwd: string; round: number }> = [];
  doubles.notify.mockImplementation(async (cwd: string) => { notifications.push({ cwd, round }); });

  await runDaemon();

  expect(notifications).toEqual([
    { cwd: '/project-a', round: 3 }, { cwd: '/project-a', round: 5 }, { cwd: '/project-b', round: 5 },
  ]);
});

it.each(['run', 'work', 'task-read'] as const)('exits when only %s errors remain and notifies once before releasing ownership', async (stage) => {
  doubles.projects.mockResolvedValue(['/project']);
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  const failure = new Error('invalid tasks.yaml');
  if (stage === 'run') doubles.ensure.mockRejectedValue(failure);
  if (stage === 'work') doubles.work.mockRejectedValue(failure);
  if (stage === 'task-read') doubles.work.mockImplementation(async (_cwd: string, onReadError: (error: unknown) => void) => {
    onReadError(failure);
    return false;
  });

  await runDaemon();

  expect(doubles.delay).toHaveBeenCalledOnce();
  expect(doubles.work).toHaveBeenCalledOnce();
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
  expect(doubles.notify.mock.invocationCallOrder[0]).toBeLessThan(doubles.removeOwner.mock.invocationCallOrder[0]!);
  expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('does not repeat an already delivered notification when exiting with a continuing failure', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => { round++; });
  const failure = new Error('failed');
  doubles.ensure.mockRejectedValue(failure);
  doubles.work.mockImplementation(async () => round < 4);

  await runDaemon();

  expect(round).toBe(4);
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
});

it('notifies an unreported polling failure when stopped before the patrol interval', async () => {
  const before = process.rawListeners('SIGTERM');
  doubles.projects.mockResolvedValue(['/project']);
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  const failure = new Error('failed');
  doubles.ensure.mockRejectedValue(failure);
  doubles.work.mockResolvedValue(true);
  doubles.delay.mockResolvedValueOnce(undefined).mockImplementation(async () => {
    expect(doubles.notify).not.toHaveBeenCalled();
    const stop = process.rawListeners('SIGTERM').find((listener) => !before.includes(listener));
    stop!.call(process, 'SIGTERM');
    throw new Error('aborted delay');
  });

  await runDaemon();

  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});
