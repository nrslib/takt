import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import * as lifecycle from '../features/daemon/lifecycle.js';
import * as readiness from '../features/daemon/conversationReadiness.js';
import * as watchLoop from '../features/daemon/watchers/loop.js';
import * as daemonProcess from '../infra/daemon/process.js';
import * as owners from '../infra/daemon/owner.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { packageVersion } from '../shared/package-info.js';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { Client } from './helpers/conversation-ipc-client.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';
import { deferred } from './helpers/daemon-turn.js';

const doubles = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:net', async (original) => ({ ...await original<typeof import('node:net')>() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: doubles.spawn }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function fixture(existing = true) {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(daemonProcess, 'readProcessOwner').mockImplementation(async (pid) => ({ pid, startTime: 'fixture' }));
  vi.spyOn(owners, 'isDaemonOwnerRunning').mockResolvedValue(true);
  const startLoop = watchLoop.startWatchLoop;
  let checkIdle!: () => Promise<void>;
  vi.spyOn(watchLoop, 'startWatchLoop').mockImplementation((interval, check, onError) => {
    if (interval !== 500) return startLoop(interval, check, onError);
    checkIdle = () => check(new AbortController().signal);
    return { wake() {}, async drain() {}, async close() {} };
  });
  const directory = getGlobalConfigDir();
  const owner = { pid: process.pid, identity: { startTime: 'fixture' }, version: packageVersion, cliPath: lifecycle.daemonEntryPath() };
  const runner = new ControlledTurnRunner();
  const start = async () => {
    await owners.writeDaemonOwner(directory, owner);
    const daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined,
      signal: new AbortController().signal, runnerFactory(bus) { runner.bus = bus; return runner; } });
    cleanups.push(daemon.close);
    await daemon.watchers.drain();
    return daemon;
  };
  let starting: ReturnType<typeof start> | undefined;
  doubles.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid + 1, exitCode: null, signalCode: null, unref() {} });
    starting ??= start();
    void starting.then(() => child.emit('spawn'), (error: unknown) => child.emit('error', error));
    return child;
  });
  if (existing) starting = start();
  if (starting !== undefined) await starting;
  return { directory, owner, runner,
    async daemon() { return starting!; },
    async idleAfter(ms: number) { now += ms; await checkIdle(); },
    async stopWhenIdle() {
      const daemon = await starting!;
      await checkIdle();
      await daemon.stopped;
      await daemon.close();
      expect(runner.closed).toBe(true);
      expect(await readDaemonIpcState(directory)).toBeUndefined();
    },
  };
}

it.each(['new', 'existing'] as const)('keeps the %s daemon alive between authenticated readiness and the first open on the same socket', async (kind) => {
  const f = await fixture(kind === 'existing');
  const reached = deferred<net.Socket>();
  const resume = deferred<void>();
  const connect = readiness.connectConversationIpc;
  const connections = vi.spyOn(net, 'createConnection');
  vi.spyOn(readiness, 'connectConversationIpc').mockImplementation(async (...args) => {
    const socket = await connect(...args);
    if (socket === undefined) throw new Error('Readiness failed');
    reached.resolve(socket);
    await resume.promise;
    return socket;
  });
  cleanups.push(async () => { resume.resolve(); });
  const client = new ConversationIpcClient({ kind: 'daemon' }, undefined, {
    port: createTuiConversationPort(f.directory, { async deliver() { return { kind: 'delivered' }; } }), reconnect: false,
  });
  cleanups.push(async () => { client.close(); });
  const connecting = client.connect();
  try {
    const socket = await reached.promise;
    const daemon = await f.daemon();
    expect(daemon.input.attachmentCount).toBe(0);
    await f.idleAfter(10_000);
    expect(f.runner.closed).toBe(false);
    expect(socket.destroyed).toBe(false);
    resume.resolve();
    await connecting;
    await vi.waitFor(() => expect(client.getSnapshot().readStatus).toBe('complete'));
    expect(client.getSnapshot().state?.assignment).toEqual({ kind: 'daemon' });
    expect(daemon.input.attachmentCount).toBe(1);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(doubles.spawn).toHaveBeenCalledTimes(kind === 'new' ? 1 : 0);
    client.close();
    await vi.waitFor(() => expect(daemon.input.attachmentCount).toBe(0));
    await f.stopWhenIdle();
  } finally { resume.resolve(); await connecting.catch(() => {}); }
});

it('keeps independent handoffs alive for multiple starters until each opens or disconnects', async () => {
  const f = await fixture(false);
  const sockets = await Promise.all([lifecycle.ensureDaemon({ retainConnection: true }), lifecycle.ensureDaemon({ retainConnection: true })]);
  for (const socket of sockets) cleanups.push(async () => { socket.destroy(); });
  expect(sockets[0]).not.toBe(sockets[1]);
  const daemon = await f.daemon();
  const selected = await createTuiConversationPort(f.directory, { async deliver() { return { kind: 'delivered' }; } }).resolve({ kind: 'daemon' });
  const first = new Client(sockets[0]!);
  const opened = (await first.request('open', selected)).result!;
  await first.items(opened.read.transferId);
  await first.request('detach', { attachmentId: opened.attachmentId });
  await f.idleAfter(10_000);
  expect(f.runner.closed).toBe(false);
  expect(daemon.input.attachmentCount).toBe(0);
  const second = new Client(sockets[1]!);
  const next = (await second.request('open', selected)).result!;
  expect(await second.items(next.read.transferId)).toContainEqual(expect.objectContaining({ kind: 'state' }));
  await second.request('detach', { attachmentId: next.attachmentId });
  // open 済み接続自体は idle 終了を妨げない。
  await f.stopWhenIdle();
});

it('releases a handoff abandoned before open and resumes normal idle shutdown', async () => {
  const f = await fixture();
  const socket = await lifecycle.ensureDaemon({ retainConnection: true });
  cleanups.push(async () => { socket.destroy(); });
  await f.idleAfter(1000);
  expect(f.runner.closed).toBe(false);
  socket.destroy();
  // サーバー側の close 通知まで待つ。
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.waitFor(async () => { await f.idleAfter(500); expect(f.runner.closed).toBe(true); });
  await f.stopWhenIdle();
});

it('preserves idle shutdown after an ordinary ensure without retaining an attachment', async () => {
  const f = await fixture();
  await lifecycle.ensureDaemon();
  await vi.waitFor(async () => { await f.idleAfter(500); expect(f.runner.closed).toBe(true); });
  await f.stopWhenIdle();
});
