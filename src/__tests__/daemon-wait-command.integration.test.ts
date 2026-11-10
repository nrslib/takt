import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchGoalReader } from '../features/daemon/watchers/goalReader.js';
import { DaemonWaitCommands } from '../features/daemon/waitCommands.js';
import * as waitCommandProcesses from '../features/daemon/waitCommandProcess.js';
import { runDaemon, startDaemon } from '../features/daemon/runDaemon.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import { WaitCommandInputSchema, MAX_WAIT_COMMAND_OUTPUT_BYTES } from '../core/daemon/waitCommand.js';
import type { EventInput } from '../core/daemon/events.js';
import type { DaemonIngress } from '../core/daemon/ports.js';
import { parseDaemonProcessMessage, parseTurnProcessMessage, TURN_PROTOCOL_VERSION } from '../core/daemon/processProtocol.js';
import { EventInputSchema } from '../infra/daemon/eventRecord.js';
import { conversationId } from '../infra/conversations/identity.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import type { ManagerAssignmentIdentity } from '../features/manager/assignment.js';
import { ControlledTurnRunner, deferred, input } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { forceTerminateWindowsProcess } from '../shared/utils/spawn.js';
import * as spawnUtils from '../shared/utils/spawn.js';
import * as daemonDiagnostics from '../infra/daemon/diagnostics.js';
import * as executablePaths from '../shared/utils/executable-path-async.js';
import { startWindowsWaitCommand } from '../features/daemon/windowsWaitCommand.js';
import { DaemonLogger } from '../infra/daemon/logger.js';
import { readDaemonOwner } from '../infra/daemon/owner.js';
import * as turnProcessHost from '../features/daemon/turnProcessHost.js';
import * as daemonWatchers from '../features/daemon/watchers/index.js';

vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));
vi.mock('../features/daemon/slackPorts.js', () => ({ createDaemonSlackPorts: async () => undefined }));
vi.mock('../features/daemon/conversationIpcServer.js', () => ({ createConversationIpcServer: async () => ({
  initializingCount: 0, stopAccepting() {}, async close() {},
}) }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const close of cleanups.splice(0).reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
  } finally { vi.restoreAllMocks(); }
  if (failures.length > 0) throw new AggregateError(failures, 'Wait command test cleanup failed');
});
const signal = new AbortController().signal;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string): string => process.platform === 'win32'
  ? `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}', 'base64').toString('utf8'))"`
  : `${quote(process.execPath)} -e ${quote(script)}`;
const noop = node('');
const processTimeoutSeconds = process.platform === 'win32' ? 10 : 1;

async function daemonFixture(options?: { workspaceAlias: boolean }) {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  await mkdir(join(repository, '.takt'), { recursive: true });
  await promisify(execFile)('git', ['init', '-b', 'main', repository]);
  await writeFile(join(repository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  let assignment: ManagerAssignmentIdentity = { kind: 'repository', repositoryDirectory: repository };
  let repositoryDirectory = repository;
  if (options?.workspaceAlias) {
    const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'wait workspace', repositoryDirectories: [repository] });
    repositoryDirectory = join(directory, 'saved-repository');
    await symlink(repository, repositoryDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(directory, 'workspaces', workspace.id, 'workspace.json'),
      JSON.stringify({ ...workspace, repositoryDirectories: [join(directory, 'deleted-repository'), repositoryDirectory] }));
    assignment = { kind: 'workspace', workspaceId: workspace.id };
  }
  const runner = new ControlledTurnRunner();
  const daemon = await startDaemon({ configDirectory: directory, owner: {
    pid: process.pid, identity: { startTime: 'fixture' }, version: 'test', cliPath: '/daemon.js',
  }, tokens: undefined, signal, runnerFactory(bus) { runner.bus = bus; return runner; } });
  cleanups.push(daemon.close);
  await daemon.watchers.close();
  const id = conversationId(assignment);
  await daemon.dispatcher.accept(input('wait', id));
  const active = await runner.started(1);
  const envelope = { protocolVersion: TURN_PROTOCOL_VERSION, launchId: 'wait-test' };
  const requestDaemon: NonNullable<import('../features/mcp/server.js').TaktMcpServerOptions['requestDaemon']> = async (request) => {
    const message = parseTurnProcessMessage({ ...envelope, kind: 'daemon_request', turn: active.turn, requestId: 'request', request }, envelope.launchId);
    if (message.kind !== 'daemon_request') throw new Error('Expected a request');
    const reply = await daemon.dispatcher.request(active.turn, message.request, active.signal);
    const response = parseDaemonProcessMessage({ ...envelope, kind: 'daemon_reply', turn: active.turn, requestId: 'request', reply }, envelope.launchId);
    if (response.kind !== 'daemon_reply') throw new Error('Expected a reply');
    return response.reply;
  };
  const connection = await startManagerMcpConnection(repository, assignment, undefined, undefined, requestDaemon);
  cleanups.push(connection.dispose);
  const client = new Client({ name: 'wait-test', version: 'test' });
  cleanups.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers: connection.config.headers } });
  await client.connect(transport);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'takt_wait_command', arguments: {
    cwd: repository, command: noop, description: 'CI result', ...args,
  } });
  return { ...daemon, directory, repository, repositoryDirectory, runner, id, active, requestDaemon, call, client };
}

it('registers through manager MCP and daemon IPC, preserves cwd, and delivers the result to the next manager turn once', async () => {
  const f = await daemonFixture();
  const cwd = join(f.repository, '..cache'); await mkdir(cwd);
  const goalPath = join(f.repository, '.takt', 'goals', goalRecord().id, 'goal.json');
  await mkdir(join(goalPath, '..'), { recursive: true });
  await writeFile(goalPath, JSON.stringify(goalRecord()));
  const response = await f.call({ cwd, goalId: goalRecord().id,
    command: node('setTimeout(() => { console.log(process.cwd()); console.error("CI finished"); }, 750)') });
  expect(response.isError).not.toBe(true);
  const { id } = JSON.parse(firstTextContent(response.content)) as { id: string };
  await f.runner.finish(f.active);
  const next = await f.runner.started(2);
  const event = next.input.event.event;
  expect(EventInputSchema.parse({
    eventId: next.input.event.eventId, requestId: next.input.event.requestId, conversationId: f.id,
    source: 'daemon', occurredAt: next.input.event.occurredAt, event,
  }).event).toEqual(event);
  expect(event).toMatchObject({ kind: 'wait_command_completed', id, description: 'CI result', exitCode: 0, status: 'succeeded' });
  if (event.kind !== 'wait_command_completed') throw new Error('Missing completion');
  expect(event.outputTail).toContain(cwd); expect(event.outputTail).toContain('CI finished');
  expect(event.durationMs).toBeGreaterThanOrEqual(0);
  await writeFile(goalPath, JSON.stringify({ ...goalRecord(), executionStatus: 'paused' }));
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>().mockResolvedValue({
    message: 'received', summary: null, assignment: undefined, sessionId: undefined,
  });
  const service = createConversationTurnService(f.directory, { async resolve() {
    return { provider: 'mock', model: null, language: 'en', contextKey: 'wait', executor: { execute } };
  }, async close() {} });
  const request = (request: import('../core/daemon/processProtocol.js').DaemonStateRequest) => f.dispatcher.request(next.turn, request, next.signal);
  const outcome = await service.execute(next.input, { signal: next.signal, progress() {}, request });
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(execute).toHaveBeenCalledOnce();
  const prompt = execute.mock.calls[0]![0].prompt;
  const body = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as { event: unknown };
  expect(body.event).toEqual(event);
  expect(execute.mock.calls[0]![0].requestDaemon).toBe(request);
  await f.runner.finish(next, outcome);
  await f.dispatcher.drain();
  expect(f.runner.calls).toHaveLength(2);
});

it('skips deleted workspace candidates in MCP and daemon matching and retains the saved repository path in completion', async () => {
  const f = await daemonFixture({ workspaceAlias: true });
  const cwd = join(f.repository, 'subdirectory'); await mkdir(cwd);
  expect(await realpath(f.repositoryDirectory)).toBe(f.repository);
  expect(f.repositoryDirectory).not.toBe(f.repository);
  const outside = join(f.directory, 'other-repository'); await mkdir(outside);
  await promisify(execFile)('git', ['init', '-b', 'main', outside]);
  expect((await f.call({ cwd: outside })).isError).toBe(true);
  expect(await f.requestDaemon({ kind: 'wait_command', cwd: outside, command: noop,
    description: 'unassigned', timeoutSeconds: 10 })).toMatchObject({ kind: 'error', code: 'forbidden' });

  const goalPath = join(f.repository, '.takt', 'goals', goalRecord().id, 'goal.json');
  await mkdir(join(goalPath, '..'), { recursive: true });
  await writeFile(goalPath, JSON.stringify(goalRecord()));
  const response = await f.call({ cwd, goalId: goalRecord().id, command: node('console.log(process.cwd())') });
  expect(response.isError).not.toBe(true);
  const { id } = JSON.parse(firstTextContent(response.content)) as { id: string };
  await f.runner.finish(f.active);
  const next = await f.runner.started(2);
  expect(next.turn.conversationId).toBe(f.id);
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>().mockResolvedValue({
    message: 'received', summary: null, assignment: undefined, sessionId: undefined,
  });
  const service = createConversationTurnService(f.directory, { async resolve() {
    return { provider: 'mock', model: null, language: 'en', contextKey: 'workspace-wait', executor: { execute } };
  }, async close() {} });
  const outcome = await service.execute(next.input, { signal: next.signal, progress() {},
    request: (request) => f.dispatcher.request(next.turn, request, next.signal) });
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'reply' } });
  expect(next.input.event.event).toMatchObject({ kind: 'wait_command_completed', id,
    repositoryDirectory: f.repositoryDirectory, goalId: goalRecord().id, status: 'succeeded', exitCode: 0,
    outputTail: `${cwd}\n` });
  expect(execute).toHaveBeenCalledOnce();
  const prompt = execute.mock.calls[0]![0].prompt;
  const body = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as { event: unknown };
  expect(body.event).toEqual(next.input.event.event);
  await f.runner.finish(next, outcome);
  await f.dispatcher.drain();
  expect(f.runner.calls).toHaveLength(2);
});

it('rejects invalid arguments and unassigned cwd without sending a registration', async () => {
  const f = await daemonFixture();
  const outside = join(f.directory, 'outside'); await mkdir(outside);
  for (const args of [
    { cwd: '.' }, { cwd: f.directory }, { cwd: outside }, { command: ' ' }, { command: 'true\nfalse' },
    { description: '' }, { timeoutSeconds: 0 }, { timeoutSeconds: 86401 }, { goalId: 'invalid' },
  ]) expect((await f.call(args)).isError).toBe(true);
  for (const cwd of [f.directory, outside]) {
    const denied = await f.requestDaemon({ kind: 'wait_command', command: 'true', description: 'outside', cwd, timeoutSeconds: 1 });
    expect(denied).toMatchObject({ kind: 'error', code: 'forbidden' });
  }
  expect((await f.client.listTools()).tools.some((tool) => tool.name === 'takt_wait_command')).toBe(true);
  expect(f.runner.calls).toHaveLength(1);
});

it('omits wait commands from manager MCP without a daemon request route, as used by the stdio entrypoint', async () => {
  const server = createTaktMcpServer({}, { toolSet: 'manager' });
  cleanups.push(() => server.close());
  const client = new Client({ name: 'standalone-manager-test', version: 'test' });
  cleanups.push(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain('takt_list_tasks');
  expect(names).not.toContain('takt_wait_command');
});

async function registryFixture(maxRegistrations = 32) {
  const directory = getGlobalConfigDir();
  const events: EventInput[] = [];
  const errors = vi.fn();
  const goals = { read: vi.fn<WatchGoalReader['read']>(async () => ({ ...goalRecord(), blockedNotifications: [] })) };
  const ingress = { accept: vi.fn<DaemonIngress['accept']>(async (event: EventInput) => {
    events.push(EventInputSchema.parse(event));
    return { kind: 'accepted' as const, eventId: event.eventId, operationId: 'event', acceptedSequence: 1 };
  }) };
  const registry = new DaemonWaitCommands({ maxRegistrations, ingress, goals, onError: errors });
  cleanups.push(() => registry.close());
  const register = (command: string, extra: Record<string, unknown> = {}) => registry.register('manager', directory,
    WaitCommandInputSchema.parse({ cwd: directory, command, description: 'waiting', ...extra }), signal);
  return { registry, register, directory, events, errors, goals, ingress };
}

it('limits running and pending registrations together and recovers capacity only after completion delivery', async () => {
  const f = await registryFixture();
  const accept = f.ingress.accept.getMockImplementation()!;
  f.ingress.accept.mockResolvedValue({ kind: 'rejected', reason: 'capacity' });
  const release = join(f.directory, 'capacity-release');
  const marker = join(f.directory, 'rejected-command');
  const waiting = node(`const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20)`);
  const rejected = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  const ids = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    f.register(index === 0 ? waiting : noop, { goalId: goalRecord().id })));
  await expect(f.register(rejected)).rejects.toThrow(/capacity/i);

  await expect.poll(() => f.ingress.accept.mock.calls.length).toBe(31);
  await expect(f.register(rejected)).rejects.toThrow(/capacity/i);
  await writeFile(release, 'done');
  await expect.poll(() => f.ingress.accept.mock.calls.length).toBe(32);
  await expect(f.register(rejected)).rejects.toThrow(/capacity/i);
  expect(f.events).toHaveLength(0);

  f.ingress.accept.mockImplementationOnce(accept);
  await f.registry.check();
  expect(f.events).toHaveLength(1);
  const recoveredId = await f.register(noop);
  await expect.poll(() => f.ingress.accept.mock.calls.some(([event]) =>
    event.event.kind === 'wait_command_completed' && event.event.id === recoveredId)).toBe(true);
  await expect(f.register(rejected)).rejects.toThrow(/capacity/i);

  f.ingress.accept.mockImplementation(accept);
  await f.registry.check();
  await expect.poll(() => f.registry.hasWork).toBe(false);
  await f.registry.check(); await f.registry.close();
  const delivered = f.events.map(({ event }) => event.kind === 'wait_command_completed' ? event.id : undefined);
  expect(delivered).toHaveLength(33);
  expect(new Set(delivered)).toEqual(new Set([...ids, recoveredId]));
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retries a rejected completion with the same event id and stops retrying after admission', async () => {
  const f = await registryFixture();
  f.ingress.accept.mockResolvedValueOnce({ kind: 'rejected', reason: 'capacity' });
  await f.register(noop);
  await expect.poll(() => f.ingress.accept.mock.calls.length).toBe(1);
  await f.registry.check();
  expect(f.events).toHaveLength(1);
  expect(f.ingress.accept.mock.calls[0]![0]).toEqual(f.ingress.accept.mock.calls[1]![0]);
  await f.registry.check();
  expect(f.ingress.accept).toHaveBeenCalledTimes(2);
  expect(f.registry.hasWork).toBe(false);
});

it('rejects paused and missing goals without starting the command', async () => {
  const f = await registryFixture();
  f.goals.read.mockResolvedValueOnce({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
  await expect(f.register(noop, { goalId: goalRecord().id })).rejects.toThrow();
  f.goals.read.mockRejectedValueOnce(new Error('Goal not found'));
  await expect(f.register(noop, { goalId: goalRecord().id })).rejects.toThrow();
  expect(f.registry.hasWork).toBe(false);
  expect(f.events).toEqual([]);
});

it.each([0, 7])('reports shell exit %i once with a bounded output tail', async (exitCode) => {
  const f = await registryFixture();
  await f.register(node(`process.stdout.write('x'.repeat(100000) + '末尾'); process.exitCode = ${exitCode}`));
  await expect.poll(() => f.events.length).toBe(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', exitCode,
    status: exitCode === 0 ? 'succeeded' : 'failed' });
  const event = f.events[0]!.event;
  if (event.kind !== 'wait_command_completed') throw new Error('Missing completion');
  expect(event.outputTail.endsWith('末尾')).toBe(true);
  expect(Buffer.byteLength(event.outputTail)).toBeLessThanOrEqual(MAX_WAIT_COMMAND_OUTPUT_BYTES);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it('reports an actual spawn failure once with unavailable exit code and signal', async () => {
  const f = await registryFixture();
  const spawn = spawnUtils.spawnManagedProcess;
  const spawnError = vi.fn();
  vi.spyOn(spawnUtils, 'spawnManagedProcess').mockImplementation((...args) => {
    const managed = spawn(...args);
    managed.child.once('error', spawnError);
    return managed;
  });
  const id = await f.register(noop, { cwd: join(f.directory, 'missing-cwd') });
  await expect.poll(() => f.events.length).toBe(1);
  expect(spawnError).toHaveBeenCalledOnce();
  expect(spawnError.mock.calls[0]![0]).toMatchObject({ code: 'ENOENT' });
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, status: 'failed', exitCode: null, signal: null });
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1);
  expect(f.registry.hasWork).toBe(false);
});

it('delivers pending completions during close and keeps a rejected close retryable', async () => {
  const f = await registryFixture();
  const accept = f.ingress.accept.getMockImplementation()!;
  f.ingress.accept.mockResolvedValue({ kind: 'rejected', reason: 'capacity' });
  await f.register(noop);
  await expect.poll(() => f.ingress.accept.mock.calls.length).toBe(1);
  await expect(f.registry.close()).rejects.toThrow(AggregateError);
  expect(f.registry.hasWork).toBe(true);
  f.ingress.accept.mockImplementation(accept);
  await Promise.all([f.registry.close(), f.registry.close()]);
  await f.registry.close();
  expect(f.registry.hasWork).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(new Set(f.ingress.accept.mock.calls.map(([event]) => event.eventId)).size).toBe(1);
});

it('delivers cancellation once when closed before the registered command starts', async () => {
  const f = await registryFixture();
  const spawn = vi.spyOn(spawnUtils, 'spawnManagedProcess');
  const registration = f.register(noop);
  const closing = f.registry.close();
  const id = await registration;
  await closing;
  await f.registry.close();
  expect(spawn).not.toHaveBeenCalled();
  expect(f.events).toHaveLength(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, status: 'cancelled', exitCode: null, signal: null });
  expect(f.registry.hasWork).toBe(false);
});

function waitingTree(marker: string): string {
  return node(`const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000)`);
}
async function readPids(marker: string, events: EventInput[]): Promise<number[]> {
  await expect.poll(async () => {
    try { return { pids: JSON.parse(await readFile(marker, 'utf8')) as number[], events }; }
    catch { return { pids: [], events }; }
  }, { timeout: 15_000 }).toMatchObject({ pids: [expect.any(Number), expect.any(Number)], events: [] });
  return JSON.parse(await readFile(marker, 'utf8')) as number[];
}
function expectStopped(pids: number[]): void {
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}

function leaderExitsFirst(marker: string, release: string, exitCode: number, childLifetimeMs = 15_000, childExitCode = 0): string {
  const childScript = `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { process.exitCode = ${childExitCode}; clearInterval(timer); } }, 20); setTimeout(() => process.exit(0), ${childLifetimeMs}).unref()`;
  cleanups.push(async () => {
    try {
      const pids = JSON.parse(await readFile(marker, 'utf8')) as number[];
      if (process.platform === 'win32') {
        for (const pid of pids.slice(1)) {
          try { process.kill(pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
          await forceTerminateWindowsProcess(pid);
        }
        return;
      }
      const [leader] = pids;
      process.kill(-leader!, 'SIGKILL');
      await expect.poll(() => {
        try { process.kill(-leader!, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
      }).toBe(false);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
  });
  // Windows は libuv の leader 固有 Job による子の自動終了を避け、専用 Job の所有を検証する。
  // POSIX は exec で記録する PID をグループ leader にそろえる。子孫は stdio を継承しない。
  const command = node(`const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore', detached: ${process.platform === 'win32'}}); child.unref(); require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])); console.log('leader finished'); process.exitCode = ${exitCode}`);
  return process.platform === 'win32' ? command : `exec ${command}`;
}

async function readSurvivingChild(marker: string, events: EventInput[]): Promise<number[]> {
  const pids = await readPids(marker, events);
  await expect.poll(() => {
    try { process.kill(pids[0]!, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }).toBe(false);
  process.kill(pids[1]!, 0);
  return pids;
}

it.each([0, 7])('preserves natural exit %i when goal cancellation races completion', async (exitCode) => {
  const f = await registryFixture();
  const start = waitCommandProcesses.startWaitCommand;
  const stop = vi.fn<waitCommandProcesses.WaitCommandProcess['stop']>();
  vi.spyOn(waitCommandProcesses, 'startWaitCommand').mockImplementation((...args) => {
    const managed = start(...args);
    stop.mockImplementation((reason) => managed.stop(reason));
    return {
      stop,
      async wait() {
        const exit = await managed.wait();
        f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
        // 自然終了の取得と登録の後片付けの間へ、停止要求を割り込ませる。
        queueMicrotask(() => { void f.registry.check(); });
        return exit;
      },
    };
  });
  await f.register(node(`process.exitCode = ${exitCode}`), { goalId: goalRecord().id });
  await expect.poll(() => f.events.length).toBe(1);
  expect(stop).toHaveBeenCalledWith('cancelled');
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', exitCode, signal: null,
    status: exitCode === 0 ? 'succeeded' : 'failed' });
  await expect.poll(() => f.registry.hasWork).toBe(false);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

function rejectGroupStop(leader: number) {
  const error = Object.assign(new Error('Injected process group stop failure'), { code: 'EPERM' });
  const kill = process.kill;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -leader && (signal === 'SIGTERM' || signal === 'SIGKILL')) throw error;
    return kill(pid, signal);
  });
  cleanups.push(async () => { spy.mockRestore(); });
  return { error, kill: spy, restore: () => spy.mockRestore() };
}

function interceptWindowsInput(transform: (input: string) => string): spawnUtils.ManagedProcess[] {
  const spawn = spawnUtils.spawnManagedProcess;
  const supervisors: spawnUtils.ManagedProcess[] = [];
  vi.spyOn(spawnUtils, 'spawnManagedProcess').mockImplementation((...args) => {
    const managed = spawn(...args);
    supervisors.push(managed);
    const stdin = managed.child.stdin!;
    const write = stdin.write;
    vi.spyOn(stdin, 'write').mockImplementation((chunk: Uint8Array | string,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const complete = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      const input = transform(Buffer.from(chunk).toString('utf8'));
      return write.call(stdin, input, 'utf8', complete);
    });
    return managed;
  });
  return supervisors;
}

it('retains registrations and pending delivery across unconfirmed Windows supervisor reports and stop retries', async () => {
  const f = await registryFixture(2);
  const accept = f.ingress.accept.getMockImplementation()!;
  f.ingress.accept.mockResolvedValue({ kind: 'rejected', reason: 'capacity' });
  const pendingId = await f.register(noop);
  await expect.poll(() => f.ingress.accept.mock.calls.length, { timeout: 15_000 }).toBe(1);
  cleanups.push(async () => { f.ingress.accept.mockImplementation(accept); });

  vi.spyOn(executablePaths, 'resolveWindowsPowerShellExecutablePathAsync').mockResolvedValue(process.execPath);
  vi.spyOn(executablePaths, 'resolveSystem32ExecutablePathAsync').mockResolvedValue('cmd.exe');
  vi.spyOn(waitCommandProcesses, 'startWaitCommand').mockImplementation(startWindowsWaitCommand);
  const spawn = spawnUtils.spawnManagedProcess;
  const supervisors: spawnUtils.ManagedProcess[] = [];
  vi.spyOn(spawnUtils, 'spawnManagedProcess').mockImplementation((_command, _args, options, abort, lifecycle) => {
    // このケースは C# と Win32 を実行せず、実子プロセスとの報告プロトコルを検証する。
    const supervisor = spawn(process.execPath, ['-e', `
      let lines = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
        if (++lines > 3) console.log(JSON.stringify({ stopError: 'unconfirmed_exit' }));
      });
    `], options, abort, lifecycle);
    supervisors.push(supervisor);
    return supervisor;
  });
  cleanups.push(async () => { for (const supervisor of supervisors) await supervisor.terminate(); });
  await f.register(noop, { goalId: goalRecord().id });
  await expect.poll(() => supervisors.length).toBe(1);
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
  await f.registry.check();
  const unconfirmedErrors = () => f.errors.mock.calls.filter(([error]) => error?.code === 'WAIT_COMMAND_EXIT_UNCONFIRMED').length;
  await expect.poll(unconfirmedErrors).toBe(1);
  expect(f.registry.hasWork).toBe(true);
  await expect(f.register(noop)).rejects.toThrow(/capacity/i);
  await f.registry.check();
  await expect.poll(unconfirmedErrors).toBe(2);
  expect(f.events).toHaveLength(0); expect(f.registry.hasWork).toBe(true);
  expect(supervisors[0]!.child.exitCode).toBeNull();
  expect(f.ingress.accept.mock.calls.every(([input]) => input.event.kind === 'wait_command_completed' && input.event.id === pendingId)).toBe(true);
});

function disposeUnconfirmedSupervisors(supervisors: spawnUtils.ManagedProcess[]): void {
  // 原因不明の本番経路には完了手段がない。未配送を検証した後のテスト後片付けだけで所有者を終了する。
  cleanups.push(async () => {
    for (const supervisor of supervisors) {
      if (supervisor.child.exitCode === null && supervisor.child.signalCode === null) await forceTerminateWindowsProcess(supervisor.child.pid);
      await supervisor.waitForExit();
    }
  });
}

function injectWindowsTerminateProcess(body: string, failJob = false): spawnUtils.ManagedProcess[] {
  return interceptWindowsInput((input) => {
    if (input === 'cancelled\n' || input === 'timed_out\n') return input;
    const lines = input.split('\n');
    const source = Buffer.from(lines[0]!, 'base64').toString('utf8');
    const declaration = '[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);';
    expect(source).toContain(declaration);
    // Win32 呼び出しの境界だけへ失敗・競合を注入し、Job と子プロセスは実物を使う。
    let injected = source.replace(declaration, `
      [DllImport("kernel32.dll", EntryPoint = "TerminateProcess", SetLastError = true)] static extern bool NativeTerminateProcess(IntPtr process, uint code);
      [DllImport("kernel32.dll", SetLastError = true)] static extern void SetLastError(uint code);
      [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
      static bool TerminateProcess(IntPtr process, uint code) {
        ${body}
        return NativeTerminateProcess(process, code);
      }
    `);
    if (failJob) injected = injected.replace(
      '[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);',
      'static bool TerminateJobObject(IntPtr job, uint code) { SetLastError(5); return false; }',
    );
    lines[0] = Buffer.from(injected).toString('base64');
    return lines.join('\n');
  });
}

function injectWindowsJobStopRace(target: string, entered: string, resume: string, observed: string, boundary: 'job' | 'close'): spawnUtils.ManagedProcess[] {
  const csPath = (path: string): string => `@"${path.replaceAll('"', '""')}"`;
  return interceptWindowsInput((input) => {
    if (input === 'cancelled\n' || input === 'timed_out\n') return input;
    const lines = input.split('\n');
    let source = Buffer.from(lines[0]!, 'base64').toString('utf8');
    const processStop = '[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);';
    const jobStop = '[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);';
    const close = '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);';
    for (const declaration of [processStop, jobStop, close]) expect(source).toContain(declaration);
    source = source.replace(processStop, `
      [DllImport("kernel32.dll", SetLastError = true)] static extern void SetLastError(uint code);
      static bool TerminateProcess(IntPtr process, uint code) { SetLastError(5); return false; }
    `);
    const race = `
        uint id = uint.Parse(File.ReadAllText(${csPath(target)}));
        IntPtr member = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, id);
        Check(member != IntPtr.Zero, "Open race member");
        try {
          Check(WaitForSingleObject(member, 0) == WAIT_TIMEOUT, "Race member must be alive");
          File.WriteAllText(${csPath(entered)}, "entered");
          while (!File.Exists(${csPath(resume)})) Thread.Sleep(10);
          Check(WaitForSingleObject(member, 10000) == 0, "Race member must exit naturally");
          uint exited;
          Check(GetExitCodeProcess(member, out exited), "Read race member exit");
          uint active = ActiveProcesses(job);
          bool success = ${boundary === 'job' ? 'NativeTerminateJobObject(job, code)' : 'NativeCloseHandle(job)'};
          File.WriteAllText(${csPath(observed)}, exited + ":" + active + ":" + success);
          return success;
        } finally { CloseHandle(member); }
    `;
    source = source.replace(jobStop, boundary === 'job' ? `
      [DllImport("kernel32.dll", EntryPoint = "TerminateJobObject", SetLastError = true)] static extern bool NativeTerminateJobObject(IntPtr job, uint code);
      static bool TerminateJobObject(IntPtr job, uint code) { ${race} }
    ` : `
      static IntPtr closeTarget;
      static bool TerminateJobObject(IntPtr job, uint code) {
        closeTarget = job; SetLastError(5); return false;
      }
    `);
    if (boundary === 'close') source = source.replace(close, `
      [DllImport("kernel32.dll", EntryPoint = "CloseHandle")] static extern bool NativeCloseHandle(IntPtr handle);
      static bool CloseHandle(IntPtr handle) {
        if (handle != closeTarget || handle == IntPtr.Zero) return NativeCloseHandle(handle);
        closeTarget = IntPtr.Zero;
        IntPtr job = handle;
        ${race}
      }
    `);
    lines[0] = Buffer.from(source).toString('base64');
    return lines.join('\n');
  });
}

it.skipIf(process.platform !== 'win32').each([
  { exitCode: 0, mode: 'timed_out' }, { exitCode: 7, mode: 'timed_out' },
  { exitCode: 0, mode: 'goal' }, { exitCode: 7, mode: 'goal' },
  { exitCode: 0, mode: 'close' }, { exitCode: 7, mode: 'close' },
] as const)('preserves Windows natural exit $exitCode immediately before Job fallback during $mode', async ({ exitCode, mode }) => {
  const f = await registryFixture(1);
  const marker = join(f.directory, 'job-race-pids'); const release = join(f.directory, 'job-race-release');
  const target = join(f.directory, 'job-race-target'); const entered = join(f.directory, 'job-race-entered');
  const resume = join(f.directory, 'job-race-resume'); const observed = join(f.directory, 'job-race-observed');
  injectWindowsJobStopRace(target, entered, resume, observed, 'job');
  const id = await f.register(leaderExitsFirst(marker, release, exitCode, 60_000),
    mode === 'timed_out' ? { timeoutSeconds: processTimeoutSeconds } : { goalId: goalRecord().id });
  cleanups.push(async () => { await writeFile(release, 'release'); await writeFile(resume, 'resume'); });
  const pids = await readSurvivingChild(marker, f.events);
  await writeFile(target, String(pids[1]!));
  if (mode === 'goal') {
    f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
    await f.registry.check();
  }
  const closing = mode === 'close' ? Promise.all([f.registry.close(), f.registry.close()]) : undefined;
  await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 15_000 }).toBe('entered');
  await writeFile(release, 'release');
  await writeFile(resume, 'resume');
  await closing;
  await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
  const [naturalCode, active, success] = (await readFile(observed, 'utf8')).split(':');
  expect(naturalCode).toBe('0'); expect(Number(active)).toBeGreaterThan(0); expect(success).toBe('True');
  expectStopped(pids);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, exitCode, signal: null,
    status: exitCode === 0 ? 'succeeded' : 'failed' });
  await expect.poll(() => f.registry.hasWork).toBe(false);
  await f.registry.check(); await f.registry.close(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.ingress.accept).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== 'win32').each([0, 7])(
  'delivers Windows natural exit %i once when the last descendant exits before Job fallback on daemon close', async (exitCode) => {
    const errors = vi.spyOn(daemonDiagnostics, 'reportDaemonError').mockImplementation(() => {});
    const f = await daemonFixture();
    const marker = join(f.directory, 'daemon-job-race-pids'); const release = join(f.directory, 'daemon-job-race-release');
    const target = join(f.directory, 'daemon-job-race-target'); const entered = join(f.directory, 'daemon-job-race-entered');
    const resume = join(f.directory, 'daemon-job-race-resume'); const observed = join(f.directory, 'daemon-job-race-observed');
    injectWindowsJobStopRace(target, entered, resume, observed, 'job');
    expect((await f.call({ command: leaderExitsFirst(marker, release, exitCode, 60_000) })).isError).not.toBe(true);
    cleanups.push(async () => { await writeFile(release, 'release'); await writeFile(resume, 'resume'); });
    const pids = await readSurvivingChild(marker, []);
    await writeFile(target, String(pids[1]!));
    await f.runner.finish(f.active);
    const closing = Promise.all([f.close(), f.close()]);
    await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('entered');
    await writeFile(release, 'release'); await writeFile(resume, 'resume');
    await closing; await f.close();
    expect(await readFile(observed, 'utf8')).toMatch(/^0:[1-9]\d*:True$/);
    expectStopped(pids);
    expect(f.runner.calls).toHaveLength(2);
    expect(f.runner.calls[1]!.input.event.event).toMatchObject({ kind: 'wait_command_completed', exitCode,
      status: exitCode === 0 ? 'succeeded' : 'failed' });
    expect(f.runner.closed).toBe(true);
    expect(errors).toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== 'win32').each([
  { exitCode: 0, mode: 'timed_out' }, { exitCode: 7, mode: 'timed_out' },
  { exitCode: 0, mode: 'goal' }, { exitCode: 7, mode: 'goal' },
  { exitCode: 0, mode: 'close' }, { exitCode: 7, mode: 'close' },
] as const)('withholds Windows completion when natural exit $exitCode races close fallback during $mode', async ({ exitCode, mode }) => {
  const f = await registryFixture(1);
  const marker = join(f.directory, 'close-race-pids'); const release = join(f.directory, 'close-race-release');
  const target = join(f.directory, 'close-race-target'); const entered = join(f.directory, 'close-race-entered');
  const resume = join(f.directory, 'close-race-resume'); const observed = join(f.directory, 'close-race-observed');
  const supervisors = injectWindowsJobStopRace(target, entered, resume, observed, 'close');
  await f.register(leaderExitsFirst(marker, release, exitCode, 60_000),
    mode === 'timed_out' ? { timeoutSeconds: processTimeoutSeconds } : { goalId: goalRecord().id });
  disposeUnconfirmedSupervisors(supervisors);
  cleanups.push(async () => { await writeFile(release, 'release'); await writeFile(resume, 'resume'); });
  const pids = await readSurvivingChild(marker, f.events);
  await writeFile(target, String(pids[1]!));
  if (mode === 'goal') {
    f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
    await f.registry.check();
  }
  const closing = mode === 'close' ? Promise.allSettled([f.registry.close(), f.registry.close()]) : undefined;
  await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 15_000 }).toBe('entered');
  await writeFile(release, 'release'); await writeFile(resume, 'resume');
  await expect.poll(async () => {
    if (mode !== 'close') await f.registry.check();
    return f.errors.mock.calls.some(([error]) => error?.code === 'WAIT_COMMAND_EXIT_UNCONFIRMED');
  }, { timeout: 10_000 }).toBe(true);
  expect(await readFile(observed, 'utf8')).toMatch(/^0:[1-9]\d*:True$/);
  expectStopped(pids);
  expect(f.registry.hasWork).toBe(true); expect(f.ingress.accept).not.toHaveBeenCalled();
  if (closing !== undefined) {
    expect((await closing).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(f.registry.close()).rejects.toBeInstanceOf(AggregateError);
  } else {
    await expect(f.register(noop)).rejects.toThrow(/capacity/i);
    const failures = f.errors.mock.calls.length;
    await f.registry.check();
    await expect.poll(() => f.errors.mock.calls.length).toBeGreaterThan(failures);
  }
  expect(f.registry.hasWork).toBe(true); expect(f.events).toHaveLength(0);
  expect(f.ingress.accept).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32').each([0, 7])(
  'keeps Windows daemon completion pending when natural exit %i races close fallback', async (exitCode) => {
    const errors = vi.spyOn(daemonDiagnostics, 'reportDaemonError').mockImplementation(() => {});
    const f = await daemonFixture();
    const marker = join(f.directory, 'daemon-close-race-pids'); const release = join(f.directory, 'daemon-close-race-release');
    const target = join(f.directory, 'daemon-close-race-target'); const entered = join(f.directory, 'daemon-close-race-entered');
    const resume = join(f.directory, 'daemon-close-race-resume'); const observed = join(f.directory, 'daemon-close-race-observed');
    const supervisors = injectWindowsJobStopRace(target, entered, resume, observed, 'close');
    expect((await f.call({ command: leaderExitsFirst(marker, release, exitCode, 60_000) })).isError).not.toBe(true);
    disposeUnconfirmedSupervisors(supervisors);
    cleanups.push(async () => { await writeFile(release, 'release'); await writeFile(resume, 'resume'); });
    const pids = await readSurvivingChild(marker, []);
    await writeFile(target, String(pids[1]!));
    await f.runner.finish(f.active);
    const closing = Promise.allSettled([f.close(), f.close()]);
    await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('entered');
    await writeFile(release, 'release'); await writeFile(resume, 'resume');
    expect((await closing).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(f.close()).rejects.toBeInstanceOf(AggregateError);
    expect(await readFile(observed, 'utf8')).toMatch(/^0:[1-9]\d*:True$/);
    expectStopped(pids);
    expect(f.runner.calls).toHaveLength(1); expect(f.runner.closed).toBe(false);
    expect(errors).toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== 'win32')('keeps a natural exit matching the Windows Job stop code unconfirmed', async () => {
  const f = await registryFixture(1);
  const marker = join(f.directory, 'collision-pids'); const release = join(f.directory, 'collision-release');
  const target = join(f.directory, 'collision-target'); const entered = join(f.directory, 'collision-entered');
  const resume = join(f.directory, 'collision-resume'); const observed = join(f.directory, 'collision-observed');
  const supervisors = injectWindowsJobStopRace(target, entered, resume, observed, 'job');
  // DWORD 0xe0000001 と同じ値で、子孫自身を自然終了させる。
  await f.register(leaderExitsFirst(marker, release, 7, 60_000, -536870911), { goalId: goalRecord().id });
  disposeUnconfirmedSupervisors(supervisors);
  cleanups.push(async () => { await writeFile(release, 'release'); await writeFile(resume, 'resume'); });
  const pids = await readSurvivingChild(marker, f.events);
  await writeFile(target, String(pids[1]!));
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
  await f.registry.check();
  await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('entered');
  await writeFile(release, 'release'); await writeFile(resume, 'resume');
  await expect.poll(async () => {
    await f.registry.check();
    return f.errors.mock.calls.some(([error]) => error?.code === 'WAIT_COMMAND_EXIT_UNCONFIRMED');
  }).toBe(true);
  expect(await readFile(observed, 'utf8')).toMatch(/^3758096385:[1-9]\d*:True$/);
  expectStopped(pids);
  const failures = f.errors.mock.calls.length;
  await f.registry.check();
  await expect.poll(() => f.errors.mock.calls.length).toBeGreaterThan(failures);
  expect(f.registry.hasWork).toBe(true); expect(f.events).toHaveLength(0);
  expect(f.ingress.accept).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32').each(['natural', 'close retry'] as const)(
  'withholds Windows completion after ActiveProcesses == 0 until the descendant handle signals during %s', async (mode) => {
    const f = await registryFixture(1);
    const marker = join(f.directory, 'signal-pids'); const release = join(f.directory, 'signal-release');
    const target = join(f.directory, 'signal-target'); const reportEmpty = join(f.directory, 'report-empty');
    const empty = join(f.directory, 'empty-observed'); const retained = join(f.directory, 'member-retained');
    const waited = join(f.directory, 'member-wait');
    const signalled = join(f.directory, 'member-signalled'); const closed = join(f.directory, 'member-closed');
    const csPath = (path: string): string => `@"${path.replaceAll('"', '""')}"`;
    interceptWindowsInput((input) => {
      if (input === 'cancelled\n' || input === 'timed_out\n') return input;
      const lines = input.split('\n');
      let source = Buffer.from(lines[0]!, 'base64').toString('utf8');
      const accounting = '[DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr length);';
      const ids = '[DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] static extern bool QueryProcessIds(IntPtr job, int infoClass, IntPtr info, int size, IntPtr length);';
      const wait = '[DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);';
      const close = '[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);';
      for (const declaration of [accounting, ids, wait, close]) expect(source).toContain(declaration);
      // Job の集計が先行する順序だけを Win32 境界へ注入する。
      // 子孫とその handle は実物で、WaitForSingleObject の返り値は変更しない。
      source = source.replace(accounting, `
        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] static extern bool NativeQueryAccounting(IntPtr job, int infoClass, out Accounting info, int size, IntPtr length);
        static bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr length) {
          bool success = NativeQueryAccounting(job, infoClass, out info, size, length);
          if (success && File.Exists(${csPath(reportEmpty)})) {
            info.ActiveProcesses = 0;
            File.WriteAllText(${csPath(empty)}, info.ActiveProcesses.ToString());
          }
          return success;
        }
      `).replace(ids, `
        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] static extern bool NativeQueryProcessIds(IntPtr job, int infoClass, IntPtr info, int size, IntPtr length);
        static bool QueryProcessIds(IntPtr job, int infoClass, IntPtr info, int size, IntPtr length) {
          bool success = NativeQueryProcessIds(job, infoClass, info, size, length);
          if (success && File.Exists(${csPath(reportEmpty)})) {
            Marshal.WriteInt32(info, 0);
            Marshal.WriteInt32(info, 4, 0);
          }
          return success;
        }
      `).replace(wait, `
        [DllImport("kernel32.dll", EntryPoint = "WaitForSingleObject", SetLastError = true)] static extern uint NativeWaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
        static IntPtr observedMember = IntPtr.Zero;
        static uint WaitForSingleObject(IntPtr handle, uint milliseconds) {
          uint state = NativeWaitForSingleObject(handle, milliseconds);
          if (File.Exists(${csPath(target)}) && GetProcessId(handle).ToString() == File.ReadAllText(${csPath(target)})) {
            observedMember = handle;
            if (state == WAIT_TIMEOUT) File.WriteAllText(${csPath(retained)}, state.ToString());
            if (state == WAIT_TIMEOUT && File.Exists(${csPath(empty)})) File.WriteAllText(${csPath(waited)}, state.ToString());
            if (state == 0) File.WriteAllText(${csPath(signalled)}, state.ToString());
          }
          return state;
        }
      `).replace(close, `
        [DllImport("kernel32.dll", EntryPoint = "CloseHandle")] static extern bool NativeCloseHandle(IntPtr handle);
        static bool CloseHandle(IntPtr handle) {
          if (handle == observedMember) {
            File.WriteAllText(${csPath(closed)}, NativeWaitForSingleObject(handle, 0).ToString());
            observedMember = IntPtr.Zero;
          }
          return NativeCloseHandle(handle);
        }
      `);
      lines[0] = Buffer.from(source).toString('base64');
      return lines.join('\n');
    });
    const id = await f.register(leaderExitsFirst(marker, release, 7, 60_000), { timeoutSeconds: 120 });
    // 失敗時にも実子孫を解放してから supervisor / registry を回収する。
    cleanups.push(async () => { await writeFile(release, 'release'); });
    const pids = await readSurvivingChild(marker, f.events);
    await writeFile(target, String(pids[1]!));
    await expect.poll(async () => readFile(retained, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('258');
    await writeFile(reportEmpty, 'empty');
    await expect.poll(async () => readFile(empty, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('0');
    await expect.poll(async () => readFile(waited, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('258');
    process.kill(pids[1]!, 0);
    expect(f.registry.hasWork).toBe(true);
    expect(f.ingress.accept).not.toHaveBeenCalled();
    await expect(readFile(closed)).rejects.toMatchObject({ code: 'ENOENT' });
    if (mode === 'close retry') {
      const first = f.registry.close();
      expect(f.registry.close()).toBe(first);
      await expect(first).rejects.toThrow(AggregateError);
      process.kill(pids[1]!, 0);
      expect(f.registry.hasWork).toBe(true);
      expect(f.ingress.accept).not.toHaveBeenCalled();
      await expect(readFile(closed)).rejects.toMatchObject({ code: 'ENOENT' });
    } else await expect(f.register(noop)).rejects.toThrow(/capacity/i);

    await writeFile(release, 'release');
    if (mode === 'close retry') await Promise.all([f.registry.close(), f.registry.close()]);
    await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
    expect(await readFile(signalled, 'utf8')).toBe('0');
    expect(await readFile(closed, 'utf8')).toBe('0');
    expectStopped(pids);
    expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, exitCode: 7, status: 'failed' });
    await expect.poll(() => f.registry.hasWork).toBe(false);
    await f.registry.check(); await f.registry.close(); await f.registry.close();
    expect(f.ingress.accept).toHaveBeenCalledOnce();
    expect(f.events).toHaveLength(1);
  },
);

it.skipIf(process.platform !== 'win32')('retains Windows ownership after a supervisor stop deadline and retries on check', async () => {
  const f = await registryFixture(1);
  let discardStop = true;
  interceptWindowsInput((input) => discardStop && input === 'cancelled\n' ? '' : input);
  // 失敗時の cleanup でも停止要求を再び通せるようにする。
  cleanups.push(async () => { discardStop = false; });
  const marker = join(f.directory, 'windows-deadline-pids');
  const id = await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0), { goalId: goalRecord().id });
  const pids = await readSurvivingChild(marker, f.events);
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
  await f.registry.check();
  await expect.poll(() => f.errors.mock.calls.length, { timeout: 8000 }).toBe(1);
  process.kill(pids[1]!, 0);
  expect(f.registry.hasWork).toBe(true);
  expect(f.ingress.accept).not.toHaveBeenCalled();
  await expect(f.register(noop)).rejects.toThrow(/capacity/i);

  discardStop = false;
  await f.registry.check();
  await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
  expectStopped(pids);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, status: 'cancelled', exitCode: 0, signal: null });
  await expect.poll(() => f.registry.hasWork).toBe(false);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform !== 'win32').each(['timed_out', 'close'] as const)(
  'retains Windows ownership after native stop failure during %s and retries', async (mode) => {
    const f = await registryFixture(1);
    const failure = join(f.directory, 'native-stop-failure');
    injectWindowsTerminateProcess(`if (File.Exists(@"${failure.replaceAll('"', '""')}")) { SetLastError(5); return false; }`);
    cleanups.push(() => rm(failure, { force: true }));
    const marker = join(f.directory, 'windows-native-failure-pids');
    const id = await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0),
      mode === 'timed_out' ? { timeoutSeconds: processTimeoutSeconds } : {});
    const pids = await readSurvivingChild(marker, f.events);
    await writeFile(failure, 'fail');
    const settled = vi.fn();
    const closing = mode === 'close' ? f.registry.close() : undefined;
    void closing?.then(settled, settled);
    await expect.poll(() => f.errors.mock.calls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(settled).not.toHaveBeenCalled();
    process.kill(pids[1]!, 0);
    expect(f.registry.hasWork).toBe(true);
    expect(f.ingress.accept).not.toHaveBeenCalled();
    if (mode !== 'close') await expect(f.register(noop)).rejects.toThrow(/capacity/i);

    await rm(failure);
    if (mode === 'close') await Promise.all([closing, f.registry.close()]);
    else {
      await f.registry.check();
      await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
      expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, status: 'timed_out', exitCode: 0, signal: null });
      await expect.poll(() => f.registry.hasWork).toBe(false);
      await f.registry.check(); await f.registry.close();
    }
    expectStopped(pids);
    expect(f.registry.hasWork).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.errors).toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== 'win32').each([
  { mode: 'timed_out', failJob: false }, { mode: 'cancelled', failJob: false }, { mode: 'close', failJob: false },
  { mode: 'timed_out', failJob: true }, { mode: 'cancelled', failJob: true }, { mode: 'close', failJob: true },
] as const)('withholds Windows completion after unconfirmed fallback during $mode (Job termination failure: $failJob)', async ({ mode, failJob }) => {
  const f = await registryFixture(1);
  const supervisors = injectWindowsTerminateProcess('if (code == 1) { SetLastError(5); return false; }', failJob);
  const marker = join(f.directory, 'windows-permanent-pids');
  await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0),
    mode === 'timed_out' ? { timeoutSeconds: processTimeoutSeconds } : { goalId: goalRecord().id });
  disposeUnconfirmedSupervisors(supervisors);
  const pids = await readSurvivingChild(marker, f.events);
  if (mode === 'cancelled') {
    f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'aborted', blockedNotifications: [] });
    await f.registry.check();
  }
  const closing = mode === 'close' ? Promise.allSettled([f.registry.close(), f.registry.close()]) : undefined;
  await expect.poll(async () => {
    if (mode !== 'close') await f.registry.check();
    return f.errors.mock.calls.some(([error]) => error?.code === 'WAIT_COMMAND_EXIT_UNCONFIRMED');
  }, { timeout: 15_000 }).toBe(true);
  expectStopped(pids);
  expect(f.registry.hasWork).toBe(true);
  expect(f.events).toHaveLength(0); expect(f.ingress.accept).not.toHaveBeenCalled();
  if (closing !== undefined) {
    expect((await closing).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    await expect(f.registry.close()).rejects.toBeInstanceOf(AggregateError);
  } else {
    await expect(f.register(noop)).rejects.toThrow(/capacity/i);
    const failures = f.errors.mock.calls.length;
    await f.registry.check();
    await expect.poll(() => f.errors.mock.calls.length).toBeGreaterThan(failures);
  }
  expect(f.registry.hasWork).toBe(true); expect(f.events).toHaveLength(0);
  expect(f.ingress.accept).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32')('closes the runner even when Windows daemon close rejects without delivering completion after unconfirmed close fallback', async () => {
  const errors = vi.spyOn(daemonDiagnostics, 'reportDaemonError').mockImplementation(() => {});
  const f = await daemonFixture();
  const supervisors = injectWindowsTerminateProcess('if (code == 1) { SetLastError(5); return false; }', true);
  const marker = join(f.directory, 'windows-daemon-permanent-pids');
  expect((await f.call({ command: leaderExitsFirst(marker, join(f.directory, 'release'), 0) })).isError).not.toBe(true);
  disposeUnconfirmedSupervisors(supervisors);
  const pids = await readSurvivingChild(marker, []);
  await f.runner.finish(f.active);
  expect((await Promise.allSettled([f.close(), f.close()])).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  await expect(f.close()).rejects.toBeInstanceOf(AggregateError);
  expectStopped(pids);
  expect(f.runner.calls).toHaveLength(1);
  expect(f.runner.closed).toBe(true);
  expect(errors).toHaveBeenCalled();
});

it.skipIf(process.platform !== 'win32')('rejects Windows overlapping close within a bounded time while retaining unconfirmed descendants for another close', async () => {
  const f = await registryFixture(1);
  let discardStop = true;
  interceptWindowsInput((input) => discardStop && input === 'cancelled\n' ? '' : input);
  cleanups.push(async () => { discardStop = false; });
  const marker = join(f.directory, 'windows-close-deadline-pids');
  await f.register(waitingTree(marker));
  const pids = await readPids(marker, f.events);
  const closing = Promise.allSettled([f.registry.close(), f.registry.close()]);
  const deadline = new AbortController();
  let outcomes: Awaited<typeof closing> | undefined;
  try { outcomes = await Promise.race([closing, delay(20_000, undefined, { signal: deadline.signal })]); }
  finally { deadline.abort(); }
  expect(outcomes?.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
  expect(f.registry.hasWork).toBe(true);
  process.kill(pids[1]!, 0);
  expect(f.events).toHaveLength(0);
  discardStop = false;
  await f.registry.close();
  expectStopped(pids);
  expect(f.registry.hasWork).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled' });
});

it.skipIf(process.platform !== 'win32').each([
  { exitCode: 0, reason: 'cancelled' }, { exitCode: 7, reason: 'cancelled' },
  { exitCode: 0, reason: 'timed_out' }, { exitCode: 7, reason: 'timed_out' },
] as const)('preserves Windows natural exit $exitCode when the last descendant exits immediately before $reason termination', async ({ exitCode, reason }) => {
  const f = await registryFixture(1);
  const marker = join(f.directory, 'windows-race-pids'); const release = join(f.directory, 'release');
  const target = join(f.directory, 'race-target'); const entered = join(f.directory, 'race-entered');
  const resume = join(f.directory, 'race-resume');
  injectWindowsTerminateProcess(`
    if (File.Exists(@"${target}") && GetProcessId(process).ToString() == File.ReadAllText(@"${target}")) {
      File.WriteAllText(@"${entered}", "entered");
      while (!File.Exists(@"${resume}")) Thread.Sleep(10);
    }
  `);
  cleanups.push(async () => { await writeFile(resume, 'resume'); });
  await f.register(leaderExitsFirst(marker, release, exitCode),
    reason === 'cancelled' ? { goalId: goalRecord().id } : { timeoutSeconds: processTimeoutSeconds });
  const pids = await readSurvivingChild(marker, f.events);
  await writeFile(target, String(pids[1]!));
  if (reason === 'cancelled') {
    f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
    await f.registry.check();
  }
  await expect.poll(async () => readFile(entered, 'utf8').catch(() => ''), { timeout: 15_000 }).toBe('entered');
  // ネイティブ側が生存確認して handle を保持した後、最後の子孫を自然終了させる。
  await writeFile(release, 'done');
  await expect.poll(() => {
    try { process.kill(pids[1]!, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }).toBe(false);
  expect(f.registry.hasWork).toBe(true); expect(f.ingress.accept).not.toHaveBeenCalled();
  await writeFile(resume, 'resume');
  await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
  expectStopped(pids);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', exitCode, signal: null,
    status: exitCode === 0 ? 'succeeded' : 'failed' });
  await expect.poll(() => f.registry.hasWork).toBe(false);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32').each(['cancelled', 'timed_out'] as const)(
  'retains descendants and capacity after a failed %s stop and retries on check', async (status) => {
    const f = await registryFixture(1);
    const marker = join(f.directory, 'retry-stop-pids');
    const extra = status === 'cancelled' ? { goalId: goalRecord().id } : { timeoutSeconds: 1 };
    const id = await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0), extra);
    const pids = await readSurvivingChild(marker, f.events);
    const failure = rejectGroupStop(pids[0]!);
    if (status === 'cancelled') {
      f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
      await f.registry.check();
    }
    await expect.poll(() => f.errors.mock.calls.length, { timeout: 5000 }).toBe(1);
    expect(f.errors).toHaveBeenCalledWith(failure.error);
    process.kill(pids[1]!, 0);
    expect(f.registry.hasWork).toBe(true);
    expect(f.ingress.accept).not.toHaveBeenCalled();
    await expect(f.register(noop)).rejects.toThrow(/capacity/i);

    failure.restore();
    await f.registry.check();
    await expect.poll(() => f.events.length).toBe(1);
    expectStopped(pids);
    expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, status, exitCode: 0, signal: null });
    await expect.poll(() => f.registry.hasWork).toBe(false);
    await f.register(noop);
    await expect.poll(() => f.events.length).toBe(2);
    await f.registry.check(); await f.registry.close();
    expect(f.events).toHaveLength(2); expect(f.errors).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(process.platform === 'win32').each(['close', 'natural'] as const)(
  'retains ownership on process group monitoring errors until %s confirms termination', async (mode) => {
    const f = await registryFixture(1);
    const marker = join(f.directory, 'monitor-failure-pids'); const release = join(f.directory, 'release');
    const id = await f.register(leaderExitsFirst(marker, release, 7));
    const pids = await readSurvivingChild(marker, f.events);
    const kill = process.kill;
    const error = Object.assign(new Error('Injected monitoring failure'), { code: 'EIO' });
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid, requested) => {
      if (pid === -pids[0]!) throw error;
      return kill(pid, requested);
    });
    cleanups.push(async () => { spy.mockRestore(); });
    await expect.poll(() => spy.mock.calls.some(([pid, requested]) => pid === -pids[0]! && requested === 'SIGTERM')).toBe(true);
    expect(f.registry.hasWork).toBe(true);
    expect(f.events).toHaveLength(0);
    process.kill(pids[1]!, 0);
    await expect(f.register(noop)).rejects.toThrow(/capacity/i);
    let closing: Promise<void> | undefined;
    if (mode === 'close') {
      closing = f.registry.close();
      await expect.poll(() => f.errors.mock.calls.length).toBeGreaterThan(0);
    } else {
      await writeFile(release, 'done');
      await expect.poll(() => {
        try { kill(pids[1]!, 0); return false; }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') return true; throw failure; }
      }).toBe(true);
      expect(f.events).toHaveLength(0);
    }
    spy.mockRestore();
    if (closing !== undefined) await Promise.all([closing, f.registry.close()]);
    await expect.poll(() => f.events.length).toBe(1);
    expectStopped(pids);
    expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id, exitCode: 7, signal: null,
      status: mode === 'close' ? 'cancelled' : 'failed' });
    await f.registry.check(); await f.registry.close();
    expect(f.registry.hasWork).toBe(false);
    expect(f.events).toHaveLength(1);
  },
);

it.skipIf(process.platform === 'win32').each([0, 7])(
  'uses natural exit %i when descendants exit after a failed stop', async (exitCode) => {
    const f = await registryFixture(1);
    const marker = join(f.directory, 'failed-stop-natural-pids'); const release = join(f.directory, 'release');
    await f.register(leaderExitsFirst(marker, release, exitCode), { goalId: goalRecord().id });
    const pids = await readSurvivingChild(marker, f.events);
    const failure = rejectGroupStop(pids[0]!);
    f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
    await f.registry.check();
    await expect.poll(() => f.errors.mock.calls.length, { timeout: 5000 }).toBe(1);
    expect(f.errors).toHaveBeenCalledWith(failure.error);
    expect(f.ingress.accept).not.toHaveBeenCalled();
    await expect(f.register(noop)).rejects.toThrow(/capacity/i);

    await writeFile(release, 'done');
    await expect.poll(() => f.events.length).toBe(1);
    expectStopped(pids);
    expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', exitCode, signal: null,
      status: exitCode === 0 ? 'succeeded' : 'failed' });
    await expect.poll(() => f.registry.hasWork).toBe(false);
    failure.restore();
    await f.registry.check(); await f.registry.close();
    expect(f.events).toHaveLength(1); expect(f.errors).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(process.platform === 'win32')('keeps overlapping close calls pending after a failed stop and retries cleanup', async () => {
  const f = await registryFixture(1);
  const marker = join(f.directory, 'failed-close-pids');
  await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0));
  const pids = await readSurvivingChild(marker, f.events);
  const failure = rejectGroupStop(pids[0]!);

  const settled = vi.fn();
  const first = f.registry.close();
  const second = f.registry.close();
  void first.then(settled, settled); void second.then(settled, settled);
  await expect.poll(() => f.errors.mock.calls.some(([error]) => error === failure.error), { timeout: 5000 }).toBe(true);
  expect(f.errors).toHaveBeenCalledWith(failure.error);
  expect(settled).not.toHaveBeenCalled();
  process.kill(pids[1]!, 0);
  expect(f.registry.hasWork).toBe(true);
  expect(f.ingress.accept).not.toHaveBeenCalled();

  failure.restore();
  await Promise.all([first, second]);
  await f.registry.close();
  expect(settled).toHaveBeenCalledTimes(2);
  expectStopped(pids);
  expect(f.registry.hasWork).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled' });
  expect(f.errors.mock.calls.every(([error]) => error === failure.error)).toBe(true);
});

it.skipIf(process.platform === 'win32').each(['stop', 'completion', 'delivery'] as const)(
  'bounds POSIX close during %s failure and delivers once after recovery beyond the deadline', async (phase) => {
    const f = await registryFixture(1);
    const released = deferred<void>();
    cleanups.push(async () => { released.resolve(); });
    if (phase === 'completion') {
      const spawn = spawnUtils.spawnManagedProcess;
      vi.spyOn(spawnUtils, 'spawnManagedProcess').mockImplementation((...args) => {
        const managed = spawn(...args);
        return { ...managed, async wait() {
          const exit = await managed.wait();
          await released.promise;
          return exit;
        } };
      });
    }
    if (phase === 'delivery') {
      const accept = f.ingress.accept.getMockImplementation()!;
      f.ingress.accept.mockImplementation(async (event) => {
        await released.promise;
        return accept(event);
      });
    }
    const marker = join(f.directory, 'close-deadline-pids');
    const id = await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 7, 60_000));
    const pids = await readSurvivingChild(marker, f.events);
    const failure = phase === 'stop' ? rejectGroupStop(pids[0]!) : undefined;
    const closing = Promise.allSettled([f.registry.close(), f.registry.close()]);
    const deadline = new AbortController();
    let outcomes: Awaited<typeof closing> | undefined;
    try { outcomes = await Promise.race([closing, delay(20_000, undefined, { signal: deadline.signal })]); }
    finally { deadline.abort(); }
    expect(outcomes?.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes!) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(AggregateError);
    }
    expect(f.registry.hasWork).toBe(true);
    expect(f.events).toHaveLength(0);
    if (phase === 'stop') process.kill(pids[1]!, 0);
    else expectStopped(pids);
    if (phase === 'delivery') expect(f.ingress.accept).toHaveBeenCalledOnce();

    failure?.restore();
    released.resolve();
    await Promise.all([f.registry.close(), f.registry.close()]);
    await f.registry.check();
    await f.registry.close();
    expectStopped(pids);
    expect(f.registry.hasWork).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.ingress.accept).toHaveBeenCalledOnce();
    expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', id,
      status: 'cancelled', exitCode: 7, signal: null });
  },
);

it.each([0, 7])('waits for descendants after leader exit %i and delivers the natural result once', async (exitCode) => {
  const f = await registryFixture();
  const marker = join(f.directory, 'natural-pids'); const release = join(f.directory, 'release');
  const timeoutSeconds = processTimeoutSeconds * 2;
  await f.register(leaderExitsFirst(marker, release, exitCode), { timeoutSeconds, goalId: goalRecord().id });
  const pids = await readSurvivingChild(marker, f.events);
  expect(f.registry.hasWork).toBe(true); expect(f.events).toHaveLength(0);

  await writeFile(release, 'done');
  await expect.poll(() => f.events.length, { timeout: 15_000 }).toBe(1);
  expectStopped(pids);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', exitCode, signal: null,
    status: exitCode === 0 ? 'succeeded' : 'failed', outputTail: 'leader finished\n' });
  await expect.poll(() => f.registry.hasWork).toBe(false);
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused', blockedNotifications: [] });
  await f.registry.check();
  // 元の期限を越えて保持し、遅れて時間切れイベントが届かないことを確認する。
  await delay(timeoutSeconds * 1000 + 100);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it('times out descendants after the leader has already exited', async () => {
  const f = await registryFixture(); const marker = join(f.directory, 'orphan-timeout-pids');
  await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0), { timeoutSeconds: processTimeoutSeconds });
  const pids = await readSurvivingChild(marker, f.events);
  expect(f.registry.hasWork).toBe(true);
  await expect.poll(() => f.events.length, { timeout: processTimeoutSeconds * 1000 + 5000 }).toBe(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'timed_out', exitCode: 0, signal: null });
  expectStopped(pids);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted'] as const)('stops surviving descendants when the goal becomes %s', async (executionStatus) => {
  const f = await registryFixture(); const marker = join(f.directory, 'orphan-goal-pids');
  await f.register(leaderExitsFirst(marker, join(f.directory, 'release'), 0), { goalId: goalRecord().id });
  const pids = await readSurvivingChild(marker, f.events);
  expect(f.registry.hasWork).toBe(true);
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus, blockedNotifications: [] });
  await f.registry.check();
  await expect.poll(() => f.events.length, { timeout: 10_000 }).toBe(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled', exitCode: 0, signal: null });
  expectStopped(pids);
  await f.registry.check(); await f.registry.close();
  expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it('stops surviving descendants after leader exit when the daemon closes', async () => {
  const f = await daemonFixture(); const marker = join(f.directory, 'orphan-shutdown-pids');
  expect((await f.call({ command: leaderExitsFirst(marker, join(f.directory, 'release'), 0) })).isError).not.toBe(true);
  const pids = await readSurvivingChild(marker, []);
  await f.runner.finish(f.active);
  await f.close();
  expectStopped(pids);
  expect(f.runner.calls).toHaveLength(2);
  expect(f.runner.calls[1]!.input.event.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled' });
});

it.skipIf(process.platform === 'win32')('serializes daemon shutdown and overlapping close calls until failed descendant cleanup recovers', async () => {
  const errors = vi.spyOn(daemonDiagnostics, 'reportDaemonError').mockImplementation(() => {});
  const f = await daemonFixture(); const marker = join(f.directory, 'retry-shutdown-pids');
  expect((await f.call({ command: leaderExitsFirst(marker, join(f.directory, 'release'), 0) })).isError).not.toBe(true);
  const pids = await readSurvivingChild(marker, []);
  const failure = rejectGroupStop(pids[0]!);
  const settled = vi.fn();
  const first = f.close();
  const second = f.close();
  void first.then(settled, settled); void second.then(settled, settled);

  await expect.poll(() => errors.mock.calls.some(([error]) => error === failure.error), { timeout: 5000 }).toBe(true);
  // close を呼び直さずに再試行する間も、daemon は子孫を所有している。
  await expect.poll(() => failure.kill.mock.calls.filter(([pid, signal]) => pid === -pids[0]! && signal === 'SIGTERM').length)
    .toBeGreaterThanOrEqual(2);
  process.kill(pids[1]!, 0);
  expect(settled).not.toHaveBeenCalled();
  expect(f.runner.closed).toBe(false);
  expect(f.runner.calls).toHaveLength(1);

  f.runner.beforeClose = async () => { expectStopped(pids); };
  failure.restore();
  await Promise.all([first, second]);
  await f.close();
  expectStopped(pids);
  expect(settled).toHaveBeenCalledTimes(2);
  expect(f.runner.closed).toBe(true);
  expect(f.runner.calls).toHaveLength(1);
});

it('terminates the process tree on timeout and delivers one timed_out result', async () => {
  const f = await registryFixture(); const marker = join(f.directory, 'timeout-pids');
  await f.register(waitingTree(marker), { timeoutSeconds: processTimeoutSeconds });
  const pids = await readPids(marker, f.events);
  await expect.poll(() => f.events.length, { timeout: processTimeoutSeconds * 1000 + 5000 }).toBe(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'timed_out',
    ...(process.platform === 'win32' ? { exitCode: 1, signal: null } : { exitCode: null, signal: 'SIGTERM' }) });
  expectStopped(pids);
  await f.registry.check(); expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted'] as const)('stops the process tree when its goal becomes %s', async (executionStatus) => {
  const f = await registryFixture(); const marker = join(f.directory, 'goal-pids');
  await f.register(waitingTree(marker), { goalId: goalRecord().id });
  const pids = await readPids(marker, f.events);
  f.goals.read.mockResolvedValue({ ...goalRecord(), executionStatus, blockedNotifications: [] });
  await f.registry.check();
  await expect.poll(() => f.events.length).toBe(1);
  expect(f.events[0]!.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled', goalId: goalRecord().id });
  expectStopped(pids);
  await f.registry.check(); expect(f.events).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
});

it('stops children and discards registrations when the daemon closes', async () => {
  const f = await daemonFixture(); const marker = join(f.directory, 'shutdown-pids');
  expect((await f.call({ command: waitingTree(marker) })).isError).not.toBe(true);
  const pids = await readPids(marker, []);
  await f.runner.finish(f.active);
  await Promise.all([f.close(), f.close()]);
  await f.close();
  expectStopped(pids);
  expect(f.runner.calls).toHaveLength(2);
  expect(f.runner.calls[1]!.input.event.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled' });
});

function shutdownCauses(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(shutdownCauses) : [error];
}

it.each(['combined', 'resources'] as const)('continues shutdown after %s failures and retries only incomplete cleanup', async (phase) => {
  const f = await daemonFixture();
  await f.runner.finish(f.active);
  const waitFailure = new Error('Injected wait close failure');
  const runnerFailure = new Error('Injected runner close failure');
  const resourceFailure = new Error('Injected resource close failure');
  const closeWait = vi.spyOn(DaemonWaitCommands.prototype, 'close');
  const closeRunner = vi.spyOn(f.runner, 'close');
  if (phase === 'combined') {
    closeWait.mockRejectedValueOnce(waitFailure);
    closeRunner.mockRejectedValueOnce(runnerFailure);
  }
  const closeResource = vi.spyOn(WatchGoalReader.prototype, 'close').mockRejectedValueOnce(resourceFailure);
  const closeConversations = vi.spyOn(f.conversations, 'close');
  const stop = vi.spyOn(f.dispatcher, 'control');

  const outcomes = await Promise.allSettled([f.close(), f.close()]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toBeInstanceOf(AggregateError);
      expect(shutdownCauses(outcome.reason)).toEqual(expect.arrayContaining(
        phase === 'combined' ? [waitFailure, runnerFailure, resourceFailure] : [resourceFailure]));
    }
  }
  expect(stop).toHaveBeenCalledExactlyOnceWith({ kind: 'stop' });
  expect(closeRunner).toHaveBeenCalledOnce();
  expect(closeResource).toHaveBeenCalledOnce();
  expect(closeConversations).toHaveBeenCalledOnce();
  expect(await f.dispatcher.accept(input('after-stop', f.id))).toEqual({ kind: 'rejected', reason: 'stopping' });

  await Promise.all([f.close(), f.close()]);
  await f.close();
  expect(closeWait).toHaveBeenCalledTimes(2);
  expect(closeRunner).toHaveBeenCalledTimes(phase === 'combined' ? 2 : 1);
  expect(closeResource).toHaveBeenCalledTimes(2);
  expect(closeConversations).toHaveBeenCalledOnce();
  expect(f.runner.closed).toBe(true);
});

it.each(['stop', 'delivery'] as const)('retains wait ownership after %s failure without admitting events after dispatcher stop', async (phase) => {
  vi.spyOn(daemonDiagnostics, 'reportDaemonError').mockImplementation(() => {});
  const f = await daemonFixture();
  const closeWait = vi.spyOn(DaemonWaitCommands.prototype, 'close');
  if (phase === 'stop') closeWait.mockRejectedValueOnce(new Error('Injected wait stop failure'));
  const accept = f.dispatcher.accept.bind(f.dispatcher);
  const admission = vi.spyOn(f.dispatcher, 'accept').mockImplementation((event) => phase === 'delivery' && event.event.kind === 'wait_command_completed'
    ? Promise.resolve({ kind: 'rejected', reason: 'capacity' }) : accept(event));
  const marker = join(f.directory, 'undelivered-shutdown-pids');
  expect((await f.call({ command: waitingTree(marker) })).isError).not.toBe(true);
  const pids = await readPids(marker, []);
  await f.runner.finish(f.active);
  const closeConversations = vi.spyOn(f.conversations, 'close');
  // 停止済み dispatcher へは再配送できないため、cleanup 後も配送失敗を確認する。
  cleanups[cleanups.indexOf(f.close)] = async () => { await expect(f.close()).rejects.toBeInstanceOf(AggregateError); };

  await expect(f.close()).rejects.toBeInstanceOf(AggregateError);
  if (phase === 'delivery') expectStopped(pids);
  else for (const pid of pids) process.kill(pid, 0);
  expect(f.runner.closed).toBe(true);
  expect(closeConversations).toHaveBeenCalledOnce();
  const registry = closeWait.mock.contexts[0] as DaemonWaitCommands;
  expect(registry.hasWork).toBe(true);
  expect(await f.dispatcher.accept(input('after-stop', f.id))).toEqual({ kind: 'rejected', reason: 'stopping' });
  admission.mockImplementation(accept);
  await expect(f.close()).rejects.toBeInstanceOf(AggregateError);
  expectStopped(pids);
  expect(registry.hasWork).toBe(true);
  const events = admission.mock.calls.map(([event]) => event).filter((event) => event.event.kind === 'wait_command_completed');
  expect(events.length).toBeGreaterThan(0);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(1);
  expect(f.runner.calls).toHaveLength(1);
});

it.each(['success', 'failure', 'startup-stop'] as const)('reports daemon cleanup %s and removes the owner only after successful cleanup', async (outcome) => {
  const failure = new Error('Injected wait shutdown failure');
  if (outcome === 'failure') vi.spyOn(DaemonWaitCommands.prototype, 'close').mockRejectedValueOnce(failure);
  const runner = new ControlledTurnRunner();
  vi.spyOn(turnProcessHost, 'createTurnProcessHost').mockImplementation(({ bus }) => { runner.bus = bus; return runner; });
  if (outcome === 'startup-stop') {
    const startWatchers = daemonWatchers.startDaemonWatchers;
    vi.spyOn(daemonWatchers, 'startDaemonWatchers').mockImplementation((options) => {
      const watchers = startWatchers(options);
      process.emit('SIGTERM');
      return watchers;
    });
  }
  const write = DaemonLogger.prototype.write;
  const logs = vi.spyOn(DaemonLogger.prototype, 'write').mockImplementation(async function (this: DaemonLogger, level, message) {
    await write.call(this, level, message);
    if (level === 'info' && message.startsWith('Daemon started')) process.emit('SIGTERM');
  });
  const directory = getGlobalConfigDir();
  if (outcome === 'failure') {
    await expect(runDaemon()).rejects.toSatisfy((error: unknown) => shutdownCauses(error).includes(failure));
    expect(await readDaemonOwner(directory)).toMatchObject({ pid: process.pid });
    const diagnostics = logs.mock.calls.filter(([level]) => level === 'error').map(([, message]) => message).join('\n');
    expect(diagnostics).toContain(failure.message);
    expect(diagnostics).toContain('owner retained');
    expect(diagnostics).toContain('child processes may remain');
  } else {
    await runDaemon();
    expect(await readDaemonOwner(directory)).toBeUndefined();
  }
  expect(runner.closed).toBe(true);
});

it('observes a saved goal abort after the registering turn ends and delivers cancellation through the daemon', async () => {
  const f = await daemonFixture(); const marker = join(f.directory, 'aborted-pids');
  const goalPath = join(f.repository, '.takt', 'goals', goalRecord().id, 'goal.json');
  await mkdir(join(goalPath, '..'), { recursive: true });
  await writeFile(goalPath, JSON.stringify(goalRecord()));
  expect((await f.call({ command: waitingTree(marker), goalId: goalRecord().id })).isError).not.toBe(true);
  const pids = await readPids(marker, []);
  await f.runner.finish(f.active);
  await writeFile(goalPath, JSON.stringify({ ...goalRecord(), executionStatus: 'aborted' }));
  await expect.poll(() => f.runner.calls.length, { timeout: 12_000 }).toBe(2);
  const completed = await f.runner.started(2);
  expect(completed.input.event.event).toMatchObject({ kind: 'wait_command_completed', status: 'cancelled', goalId: goalRecord().id });
  expectStopped(pids);
  await f.runner.finish(completed);
  await f.dispatcher.drain();
  expect(f.runner.calls).toHaveLength(2);
});
