import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDaemon } from '../features/daemon/runDaemon.js';
import type { TaskRunnerOptions } from '../infra/task/runner.js';

const doubles = vi.hoisted(() => ({
  projects: vi.fn(), work: vi.fn(), create: vi.fn(), ensure: vi.fn(),
  registerOwner: vi.fn(), removeOwner: vi.fn(), delay: vi.fn(),
  patrol: vi.fn(), config: vi.fn(), notify: vi.fn(), logError: vi.fn(),
  runner: vi.fn(), recover: vi.fn(), logWarn: vi.fn(),
  conversationService: vi.fn(), ipc: vi.fn(), runtime: vi.fn(),
  slack: vi.fn(),
}));
vi.mock('../features/daemon/slackPorts.js', () => ({ createDaemonSlackPorts: doubles.slack }));
vi.mock('../infra/daemon/ipcEndpoint.js', () => ({ resolveDaemonConfigDirectory: () => process.env.TAKT_CONFIG_DIR }));
vi.mock('../features/manager/conversationService.js', () => ({ createConversationService: doubles.conversationService }));
vi.mock('../features/manager/conversationRuntime.js', () => ({ createConversationRuntime: doubles.runtime }));
vi.mock('../features/daemon/conversationIpcServer.js', () => ({ createConversationIpcServer: doubles.ipc }));
vi.mock('../features/daemon/projects.js', () => ({ listDaemonProjects: doubles.projects, hasDaemonProjectWork: doubles.work }));
vi.mock('../features/manager/runEventManager.js', () => ({ createRunEventManager: doubles.create }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.ensure }));
vi.mock('../infra/daemon/owner.js', () => ({
  registerDaemonOwner: doubles.registerOwner, removeDaemonOwner: doubles.removeOwner,
}));
vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: () => ({ startTime: 'test-start' }) }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: () => ({ cliPath: '/cli.js' }) }));
vi.mock('../shared/utils/debug.js', () => ({ initDebugLogger: vi.fn(), createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: doubles.logError, warn: doubles.logWarn }) }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class {
  constructor(cwd: string, options?: TaskRunnerOptions) { doubles.runner(cwd, options); }
} }));
vi.mock('../features/tasks/execute/claimTasks.js', () => ({ failInterruptedTasksWithGoalEvents: doubles.recover }));
vi.mock('node:timers/promises', () => ({ setTimeout: doubles.delay }));
vi.mock('../features/manager/patrol.js', () => ({ enqueueDueGoalPatrols: doubles.patrol }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../features/manager/turnFailureNotification.js', () => ({ notifyManagerTurnFailure: doubles.notify }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TAKT_SLACK_APP_TOKEN', undefined);
  vi.stubEnv('TAKT_SLACK_BOT_TOKEN', undefined);
  doubles.registerOwner.mockReturnValue(true);
  doubles.projects.mockResolvedValue(['/project-a', '/project-b']);
  doubles.work.mockResolvedValue(false);
  doubles.delay.mockImplementation(async () => { await new Promise(setImmediate); });
  doubles.config.mockReturnValue({ patrolInterval: 1800 });
  doubles.recover.mockReturnValue(0);
  doubles.conversationService.mockReturnValue({ attachmentCount: 0, activeOperationCount: 0, stopAccepting: vi.fn(), close: vi.fn() });
  doubles.ipc.mockReturnValue({ initializingCount: 0, stopAccepting: vi.fn(), close: vi.fn() });
  doubles.slack.mockResolvedValue({ listening: false, pollInquiries: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
  ['IPC startup', 'SIGTERM'],
  ['project listing', 'SIGINT'],
  ['Slack startup', 'SIGTERM'],
] as const)('closes admission immediately during %s on %s and never starts later work', async (stage, signal) => {
  const before = process.rawListeners(signal);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let conversationAccepting = true;
  let ipcAccepting = true;
  const conversation = { attachmentCount: 0, activeOperationCount: 0,
    stopAccepting: vi.fn(() => { conversationAccepting = false; }), close: vi.fn() };
  const ipc = { initializingCount: 0, stopAccepting: vi.fn(() => { ipcAccepting = false; }), close: vi.fn() };
  const slack = { listening: false, pollInquiries: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.conversationService.mockReturnValue(conversation);
  doubles.ipc.mockImplementation(async () => { if (stage === 'IPC startup') await gate; return ipc; });
  doubles.projects.mockImplementation(async () => { if (stage === 'project listing') await gate; return ['/project']; });
  doubles.slack.mockImplementation(async () => { if (stage === 'Slack startup') await gate; return slack; });
  const daemon = runDaemon();
  try {
    const boundary = stage === 'IPC startup' ? doubles.ipc : stage === 'project listing' ? doubles.projects : doubles.slack;
    await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
    process.rawListeners(signal).find((listener) => !before.includes(listener))!.call(process, signal);
    expect(conversationAccepting).toBe(false);
    if (stage !== 'IPC startup') expect(ipcAccepting).toBe(false);
    if (stage === 'Slack startup') expect(doubles.slack.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(doubles.removeOwner).not.toHaveBeenCalled();
  } finally {
    process.rawListeners(signal).find((listener) => !before.includes(listener))?.call(process, signal);
    release();
    await daemon;
  }
  expect(ipcAccepting).toBe(false);
  if (stage === 'IPC startup') expect(doubles.projects).not.toHaveBeenCalled();
  if (stage !== 'Slack startup') expect(doubles.slack).not.toHaveBeenCalled();
  else {
    expect(slack.stopAccepting).toHaveBeenCalled();
    expect(conversation.close.mock.invocationCallOrder[0]).toBeLessThan(slack.close.mock.invocationCallOrder[0]!);
    expect(slack.close.mock.invocationCallOrder[0]).toBeLessThan(doubles.removeOwner.mock.invocationCallOrder[0]!);
  }
  expect(doubles.create).not.toHaveBeenCalled();
  expect(process.rawListeners(signal)).toEqual(before);
});

it('keeps the same daemon waiting for Slack after work and TUI connections end, then closes on explicit stop', async () => {
  const before = process.rawListeners('SIGTERM');
  const conversation = { attachmentCount: 1, activeOperationCount: 0, stopAccepting: vi.fn(), close: vi.fn() };
  doubles.conversationService.mockReturnValue(conversation);
  const slack = { listening: true, pollInquiries: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.slack.mockResolvedValue(slack);
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  let round = 0;
  doubles.delay.mockImplementation(async () => {
    await new Promise(setImmediate);
    round++;
    expect(doubles.removeOwner).not.toHaveBeenCalled();
    if (round === 2) { conversation.attachmentCount = 0; conversation.activeOperationCount = 1; }
    if (round === 3) conversation.activeOperationCount = 0;
    if (round === 6) process.rawListeners('SIGTERM').find((listener) => !before.includes(listener))!.call(process, 'SIGTERM');
  });
  await runDaemon();
  expect(round).toBe(6);
  expect(doubles.slack).toHaveBeenCalledOnce();
  expect(slack.stopAccepting).toHaveBeenCalled();
  expect(slack.close).toHaveBeenCalledOnce();
  expect(conversation.close.mock.invocationCallOrder[0]).toBeLessThan(slack.close.mock.invocationCallOrder[0]!);
  expect(slack.close.mock.invocationCallOrder[0]).toBeLessThan(doubles.removeOwner.mock.invocationCallOrder[0]!);
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});

it.each(['app', 'bot', 'both'] as const)('exits normally with %s Slack tokens missing', async (missing) => {
  vi.stubEnv('TAKT_SLACK_APP_TOKEN', missing === 'bot' ? 'xapp-test-1' : '');
  vi.stubEnv('TAKT_SLACK_BOT_TOKEN', missing === 'app' ? 'xoxb-test-2' : '');
  doubles.projects.mockResolvedValue([]);
  await runDaemon();
  expect(doubles.slack).toHaveBeenCalledWith(expect.objectContaining({ tokens: undefined }));
  expect(process.env).not.toHaveProperty('TAKT_SLACK_APP_TOKEN');
  expect(process.env).not.toHaveProperty('TAKT_SLACK_BOT_TOKEN');
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('polls for new Slack inquiries on later rounds of the same daemon without waiting for a conversation message', async () => {
  const before = process.rawListeners('SIGTERM');
  const slack = { listening: true, pollInquiries: vi.fn(), stopAccepting: vi.fn(), close: vi.fn() };
  doubles.slack.mockResolvedValue(slack);
  doubles.projects.mockResolvedValue([]);
  let rounds = 0;
  doubles.delay.mockImplementation(async () => {
    await new Promise(setImmediate);
    if (++rounds === 4) process.rawListeners('SIGTERM').find((listener) => !before.includes(listener))!.call(process, 'SIGTERM');
  });
  await runDaemon();
  expect(doubles.slack).toHaveBeenCalledOnce();
  expect(slack.pollInquiries.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(slack.close).toHaveBeenCalledOnce();
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});

it('takes Slack credentials out of the environment before creating the runtime and preserves the client credentials', async () => {
  vi.stubEnv('TAKT_SLACK_APP_TOKEN', 'xapp-test-1');
  vi.stubEnv('TAKT_SLACK_BOT_TOKEN', 'xoxb-test-2');
  vi.stubEnv('PROVIDER_CANARY', 'kept');
  const environments: NodeJS.ProcessEnv[] = [];
  doubles.runtime.mockImplementation(() => { environments.push({ ...process.env }); return {}; });
  doubles.conversationService.mockImplementation(() => {
    environments.push({ ...process.env });
    return { attachmentCount: 0, activeOperationCount: 0, stopAccepting: vi.fn(), close: vi.fn() };
  });
  doubles.projects.mockResolvedValue([]);
  await runDaemon();
  expect(environments).toHaveLength(2);
  for (const env of environments) {
    expect(env).not.toHaveProperty('TAKT_SLACK_APP_TOKEN');
    expect(env).not.toHaveProperty('TAKT_SLACK_BOT_TOKEN');
    expect(env.PROVIDER_CANARY).toBe('kept');
  }
  expect(doubles.slack).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' },
  }));
  expect(process.env).not.toHaveProperty('TAKT_SLACK_APP_TOKEN');
  expect(process.env).not.toHaveProperty('TAKT_SLACK_BOT_TOKEN');
});

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

it('keeps the same daemon alive through attachment changes, detached work and terminal cleanup', async () => {
  doubles.projects.mockResolvedValue([]);
  const conversation = { attachmentCount: 1, activeOperationCount: 0, stopAccepting: vi.fn(), close: vi.fn() };
  doubles.conversationService.mockReturnValue(conversation);
  let round = 0;
  doubles.delay.mockImplementation(async () => {
    await new Promise(setImmediate);
    expect(doubles.removeOwner).not.toHaveBeenCalled();
    round++;
    if (round === 2) conversation.attachmentCount = 2;
    if (round === 3) conversation.attachmentCount = 1;
    if (round === 4) { conversation.activeOperationCount = 1; conversation.attachmentCount = 0; }
    if (round === 6) conversation.activeOperationCount = 0;
  });
  await runDaemon();
  expect(round).toBe(6); expect(conversation.close).toHaveBeenCalledOnce(); expect(doubles.removeOwner).toHaveBeenCalledOnce();
  expect(conversation.close.mock.invocationCallOrder[0]).toBeLessThan(doubles.removeOwner.mock.invocationCallOrder[0]!);
});

it('processes each project with a fixed event limit, then checks its run startup and remaining work', async () => {
  const calls: string[] = [];
  doubles.recover.mockImplementation((_runner: unknown, cwd: string) => { calls.push(`recover:${cwd}`); return 0; });
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

  for (const cwd of ['/project-a', '/project-b']) {
    expect(calls.filter((call) => call.endsWith(cwd))).toEqual([
      `recover:${cwd}`, `patrol:${cwd}`, `events:${cwd}`, `run:${cwd}`, `work:${cwd}`,
    ]);
  }
  expect(doubles.create.mock.calls).toEqual([['/project-a'], ['/project-b']]);
  expect(doubles.ensure.mock.calls).toEqual([
    ['/project-a', { notifyOnFailure: false }], ['/project-b', { notifyOnFailure: false }],
  ]);
  for (const manager of managers) expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('continues patrol, events and auto run after a recovery failure and reports it before releasing ownership', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  const failure = new Error('recovery save failed');
  doubles.recover.mockImplementation(() => { throw failure; });
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);

  await runDaemon();

  expect(doubles.logError).toHaveBeenCalledWith(expect.any(String), { cwd: '/project', error: failure.message });
  expect(doubles.patrol).toHaveBeenCalledOnce();
  expect(manager.processPending).toHaveBeenCalledOnce();
  expect(doubles.ensure).toHaveBeenCalledExactlyOnceWith('/project', { notifyOnFailure: false });
  expect(doubles.work).toHaveBeenCalledOnce();
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
  expect(doubles.notify.mock.invocationCallOrder[0]).toBeLessThan(doubles.removeOwner.mock.invocationCallOrder[0]!);
});

it('logs recovery warnings without exposing credentials or treating warnings as polling failures', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  const warning = 'API_KEY=test-recovery-credential';
  doubles.runner.mockImplementation((_cwd: string, options: TaskRunnerOptions) => {
    expect(options.goalTasksOnly).not.toBe(true);
    options.onWarning!(warning);
  });

  await runDaemon();

  expect(doubles.logWarn).toHaveBeenCalledOnce();
  const [, data] = doubles.logWarn.mock.calls[0]!;
  expect(data.cwd).toBe('/project');
  expect(data.warning).toContain('API_KEY');
  expect(data.warning).not.toContain('test-recovery-credential');
  expect(manager.processPending).toHaveBeenCalledOnce();
  expect(doubles.notify).not.toHaveBeenCalled();
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

it('keeps polling other and newly discovered projects without overlapping a pending project', async () => {
  let finish!: () => void;
  const first = { processPending: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), close: vi.fn() };
  const second = { processPending: vi.fn(), close: vi.fn() };
  const third = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
  let nextPoll!: () => void;
  doubles.delay.mockImplementation(() => new Promise<void>((resolve) => { nextPoll = resolve; }));
  let stopped = false;
  const daemon = runDaemon().then(() => { stopped = true; });
  try {
    await vi.waitFor(() => expect(nextPoll).toBeTypeOf('function'));
    for (let round = 0; round < 3; round++) {
      nextPoll();
      await new Promise(setImmediate);
    }
    expect(second.processPending).toHaveBeenCalledTimes(3);
    doubles.projects.mockResolvedValue(['/project-a', '/project-b', '/project-c']);
    nextPoll();
    await new Promise(setImmediate);
    expect(third.processPending).toHaveBeenCalledOnce();
    expect(first.processPending).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
    expect(doubles.removeOwner).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
    expect(doubles.work).toHaveBeenCalledWith('/project-b', expect.any(Function));
    for (const [interval] of doubles.delay.mock.calls) expect(interval).toBe(500);
  } finally {
    finish();
    await new Promise(setImmediate);
    nextPoll();
    await daemon;
  }
  expect(first.processPending).toHaveBeenCalledOnce();
  for (const manager of [first, second, third]) expect(manager.close).toHaveBeenCalledOnce();
});

it('aborts all pending projects and waits for all turns before cleanup', async () => {
  const before = process.rawListeners('SIGTERM');
  const finishes: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const managers = ['/project-a', '/project-b'].map(() => ({
    processPending: vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => {
      signals.push(signal);
      finishes.push(resolve);
    })),
    close: vi.fn(),
  }));
  doubles.create.mockReturnValueOnce(managers[0]).mockReturnValueOnce(managers[1]);
  const daemon = runDaemon();
  try {
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const stop = process.rawListeners('SIGTERM').find((listener) => !before.includes(listener));
    stop!.call(process, 'SIGTERM');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    finishes[0]!();
    await new Promise(setImmediate);
    for (const manager of managers) expect(manager.close).not.toHaveBeenCalled();
    expect(doubles.removeOwner).not.toHaveBeenCalled();
    expect(doubles.ensure).not.toHaveBeenCalled();
  } finally {
    const stop = process.rawListeners('SIGTERM').find((listener) => !before.includes(listener));
    stop?.call(process, 'SIGTERM');
    for (const finish of finishes) finish();
    await daemon;
  }
  for (const manager of managers) expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});

it('keeps running with remaining work after a notification spans polling rounds', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  const failure = new Error('polling failed');
  doubles.ensure.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  doubles.work.mockResolvedValue(true);
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let finishNotification!: () => void;
  doubles.notify.mockReturnValueOnce(new Promise<void>((resolve) => { finishNotification = resolve; }));
  let nextPoll!: () => void;
  doubles.delay.mockImplementation(() => new Promise<void>((resolve) => { nextPoll = resolve; }));
  let stopped = false;
  const daemon = runDaemon().then(() => { stopped = true; });
  try {
    await vi.waitFor(() => expect(nextPoll).toBeTypeOf('function'));
    nextPoll();
    await new Promise(setImmediate);
    now = 1000;
    nextPoll();
    await new Promise(setImmediate);
    expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
    for (let round = 0; round < 2; round++) {
      nextPoll();
      await new Promise(setImmediate);
    }
    expect(doubles.work).toHaveBeenCalledTimes(2);
    expect(stopped).toBe(false);
    finishNotification();
    await new Promise(setImmediate);
    nextPoll();
    await new Promise(setImmediate);
    expect(stopped).toBe(false);
    expect(doubles.work).toHaveBeenCalledTimes(3);
    expect(manager.close).not.toHaveBeenCalled();
    expect(doubles.removeOwner).not.toHaveBeenCalled();
  } finally {
    doubles.work.mockResolvedValue(false);
    finishNotification();
    await new Promise(setImmediate);
    nextPoll();
    await new Promise(setImmediate);
    nextPoll();
    await daemon;
  }
  expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
});

it('ignores remaining work from a project removed from the project list', async () => {
  doubles.projects.mockResolvedValueOnce(['/project']).mockResolvedValue([]);
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  doubles.work.mockResolvedValue(true);

  await runDaemon();

  expect(doubles.work).toHaveBeenCalledOnce();
  expect(manager.close).toHaveBeenCalledOnce();
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
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

it.each(['recovery', 'run', 'events', 'work', 'task-read'] as const)('reports repeated %s polling failures only at patrol intervals', async (stage) => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  const failure = new Error('polling failed');
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => {
    await new Promise(setImmediate);
    // Before rounds 3 and 5, only the completed patrol intervals may have notified.
    expect(doubles.notify).toHaveBeenCalledTimes(round < 3 ? 0 : round < 5 ? 1 : 2);
    round++;
  });
  if (stage === 'run') doubles.ensure.mockImplementation(async () => { if (round < 6) throw failure; });
  if (stage === 'recovery') doubles.recover.mockImplementation(() => { if (round < 6) throw failure; return 0; });
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

  expect(round).toBe(7);
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
    await new Promise(setImmediate);
    expect(doubles.notify).toHaveBeenCalledTimes(round < 5 ? 0 : 1);
    round++;
  });
  const failure = new Error('read failed');
  doubles.ensure.mockImplementation(async () => { if (round !== 2 && round !== 6) throw failure; });
  doubles.work.mockImplementation(async () => round < 6);

  await runDaemon();

  expect(round).toBe(7);
  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
});

it('clears the last notification time on recovery and uses the latest error after a new failure', async () => {
  doubles.projects.mockResolvedValue(['/project']);
  doubles.config.mockReturnValue({ patrolInterval: 1 });
  doubles.create.mockReturnValue({ processPending: vi.fn(), close: vi.fn() });
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => {
    await new Promise(setImmediate);
    expect(doubles.notify).toHaveBeenCalledTimes(round < 3 ? 0 : round < 7 ? 1 : 2);
    round++;
  });
  const failures = Array.from({ length: 8 }, (_, i) => new Error(`failure ${i + 1}`));
  doubles.ensure.mockImplementation(async () => { if (round !== 4 && round !== 8) throw failures[round - 1]; });
  doubles.work.mockImplementation(async () => round < 8);

  await runDaemon();

  expect(round).toBe(9);
  expect(doubles.notify.mock.calls).toEqual([
    ['/project', undefined, failures[2]], ['/project', undefined, failures[6]],
  ]);
});

it('uses each project patrol interval independently', async () => {
  doubles.config.mockImplementation((cwd: string) => ({ patrolInterval: cwd === '/project-a' ? 1 : 2 }));
  doubles.create.mockImplementation(() => ({ processPending: vi.fn(), close: vi.fn() }));
  let round = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => round * 500);
  doubles.delay.mockImplementation(async () => { await new Promise(setImmediate); round++; });
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

it.each(['recovery', 'run', 'work', 'task-read'] as const)('exits when only %s errors remain and notifies once before releasing ownership', async (stage) => {
  doubles.projects.mockResolvedValue(['/project']);
  const manager = { processPending: vi.fn(), close: vi.fn() };
  doubles.create.mockReturnValue(manager);
  const failure = new Error('invalid tasks.yaml');
  if (stage === 'run') doubles.ensure.mockRejectedValue(failure);
  if (stage === 'recovery') doubles.recover.mockImplementation(() => { throw failure; });
  if (stage === 'work') doubles.work.mockRejectedValue(failure);
  if (stage === 'task-read') doubles.work.mockImplementation(async (_cwd: string, onReadError: (error: unknown) => void) => {
    onReadError(failure);
    return false;
  });

  await runDaemon();

  expect(doubles.delay).toHaveBeenCalledTimes(2);
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
  doubles.delay.mockImplementation(async () => { await new Promise(setImmediate); round++; });
  const failure = new Error('failed');
  doubles.ensure.mockRejectedValue(failure);
  doubles.work.mockImplementation(async () => round < 4);

  await runDaemon();

  expect(round).toBe(5);
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
    await new Promise(setImmediate);
    expect(doubles.notify).not.toHaveBeenCalled();
    const stop = process.rawListeners('SIGTERM').find((listener) => !before.includes(listener));
    stop!.call(process, 'SIGTERM');
    throw new Error('aborted delay');
  });

  await runDaemon();

  expect(doubles.notify).toHaveBeenCalledExactlyOnceWith('/project', undefined, failure);
  expect(process.rawListeners('SIGTERM')).toEqual(before);
});
