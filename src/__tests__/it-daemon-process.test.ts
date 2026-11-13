import { Client } from './helpers/conversation-ipc-client.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonOwner, isDaemonOwnerRunning, writeDaemonOwner } from '../infra/daemon/owner.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { packageVersion } from '../shared/package-info.js';
import { expectDaemonSurvivesIdle, managerDaemonFixture, submitManagerText, waitForManager } from './helpers/manager-daemon-tui.js';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');
const io = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });
afterEach(async () => { await lifecycle.stopDaemon(); });

it('prints a description of --resident in the real daemon CLI help', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const result = await fixture.runCli(['daemon', '--help']);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/--resident\s+\S[^\n]*(?:running|alive|idle|常駐|自動終了)/iu);
  } finally { await fixture.cleanup(); }
});

it.each(['stop command', 'SIGTERM'] as const)('keeps an idle resident daemon alive and shuts it down with %s', async (instruction) => {
  const fixture = managerDaemonFixture('en');
  try {
    const owner = await fixture.startDaemon(true);
    expect(owner).toMatchObject({ resident: true });
    await expectDaemonSurvivesIdle(fixture.directory, owner);
    if (instruction === 'stop command') {
      expect((await fixture.runCli(['daemon', 'stop'])).code).toBe(0);
    } else process.kill(owner.pid, 'SIGTERM');

    await vi.waitFor(async () => {
      expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
      expect(await readDaemonOwner(fixture.directory)).toBeUndefined();
      expect(await readDaemonIpcState(fixture.directory)).toBeUndefined();
    }, { timeout: 30000 });
  } finally { await fixture.cleanup(); }
});

it.each([{ version: 'old-version' }, { cliPath: '/old/cli.js' }])('exits a mismatching manager with update instructions and preserves the resident daemon: %j', async (difference) => {
  const fixture = managerDaemonFixture('en');
  try {
    const owner = await fixture.startDaemon(true);
    const recorded = { ...owner, ...difference };
    // 実際の daemon を置き換えず、起動元が読む記録にだけ不一致を作る。
    await writeDaemonOwner(fixture.directory, recorded);

    const result = await fixture.runCli(['manager']);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/resident/iu);
    expect(result.output).toContain(difference.version ?? difference.cliPath);
    expect(result.output).toContain('takt daemon stop');
    expect(result.output).toContain('takt daemon --resident');
    expect(result.output.indexOf('takt daemon stop')).toBeLessThan(result.output.indexOf('takt daemon --resident'));
    await expectDaemonSurvivesIdle(fixture.directory, recorded);
    expect((await readDaemonIpcState(fixture.directory))?.owner).toEqual(owner);
    expect(await isConversationIpcReady(fixture.directory, owner)).toBe(true);
  } finally { await fixture.cleanup(); }
});

it('automatically stops a manually started daemon without --resident when there is no work', async () => {
  const fixture = managerDaemonFixture('en');
  try {
    const owner = await fixture.startDaemon(false);
    await vi.waitFor(async () => {
      expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
      expect(await readDaemonOwner(fixture.directory)).toBeUndefined();
      expect(await readDaemonIpcState(fixture.directory)).toBeUndefined();
    }, { timeout: 10000 });
  } finally { await fixture.cleanup(); }
});

it.each([true, false])('preserves the running daemon and TUI after duplicate startup with resident=%s', async (resident) => {
  const fixture = managerDaemonFixture('en', ['The existing daemon still responds']);
  fixture.release();
  try {
    const tui = await fixture.start(fixture.repository, undefined);
    await waitForManager(tui, 'Discuss your goal');
    const owner = (await readDaemonOwner(fixture.directory))!;
    expect(owner).toBeDefined();
    expect(owner.resident).not.toBe(true);
    const ipc = await readDaemonIpcState(fixture.directory);
    expect(ipc?.owner).toEqual(owner);

    const result = await fixture.runCli(['daemon', ...(resident ? ['--resident'] : [])]);

    if (resident) {
      expect(result.code).not.toBeNull();
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/already running/iu);
      expect(result.output).toContain('takt daemon stop');
      expect(result.output).toContain('takt daemon --resident');
      expect(result.output.indexOf('takt daemon stop')).toBeLessThan(result.output.indexOf('takt daemon --resident'));
    } else expect(result.code).toBe(0);
    expect(await readDaemonOwner(fixture.directory)).toEqual(owner);
    expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
    expect(await readDaemonIpcState(fixture.directory)).toEqual(ipc);
    await submitManagerText(tui, 'Continue using this daemon after the duplicate startup');
    await waitForManager(tui, 'The existing daemon still responds');
    await vi.waitFor(async () => expect(await fixture.state()).toMatchObject({ pending: null, running: null, turn: null }), { timeout: 30000 });
    expect(await readDaemonOwner(fixture.directory)).toEqual(owner);

    await tui.exit();

    await vi.waitFor(async () => {
      expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
      expect(await readDaemonOwner(fixture.directory)).toBeUndefined();
      expect(await readDaemonIpcState(fixture.directory)).toBeUndefined();
    }, { timeout: 10000 });
  } finally { await fixture.cleanup(); }
});

it('starts the dedicated daemon entry, confirms authenticated IPC, reuses the owner and stops it', async () => {
  await lifecycle.ensureDaemon();
  const directory = getGlobalConfigDir();
  const owner = (await readDaemonOwner(directory))!;
  expect(owner).toMatchObject({ version: packageVersion, cliPath: lifecycle.daemonEntryPath() });
  expect(owner.pid).not.toBe(process.pid);
  expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
  expect(await isConversationIpcReady(directory, owner)).toBe(true);
  await lifecycle.ensureDaemon();
  expect(await readDaemonOwner(directory)).toEqual(owner);
  await lifecycle.stopDaemon();
  expect(await readDaemonOwner(directory)).toBeUndefined();
  expect(await readDaemonIpcState(directory)).toBeUndefined();
  expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
});

it('lets concurrent starters reuse the single daemon owner', async () => {
  await Promise.all([lifecycle.ensureDaemon(), lifecycle.ensureDaemon()]);
  const owner = (await readDaemonOwner(getGlobalConfigDir()))!;
  expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
  expect(await isConversationIpcReady(getGlobalConfigDir(), owner)).toBe(true);
});

it('replaces an owner from another executable before admitting new connections', async () => {
  await lifecycle.ensureDaemon();
  const directory = getGlobalConfigDir(); const previous = (await readDaemonOwner(directory))!;
  await writeDaemonOwner(directory, { ...previous, version: 'old-version' });
  await lifecycle.ensureDaemon();
  const current = (await readDaemonOwner(directory))!;
  expect(current.pid).not.toBe(previous.pid);
  expect(current.version).toBe(packageVersion);
  expect(await isDaemonOwnerRunning(previous, io())).toBe(false);
  expect(await isConversationIpcReady(directory, current)).toBe(true);
});

it('forwards manual CLI startup and termination to the dedicated daemon process', async () => {
  const cli = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'daemon'], {
    cwd: getGlobalConfigDir(), env: { ...process.env, TAKT_CONFIG_DIR: getGlobalConfigDir() }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cli.stdout!.resume(); cli.stderr!.resume();
  const exit = new Promise<number | null>((resolve, reject) => { cli.once('error', reject); cli.once('close', resolve); });
  try {
    await vi.waitFor(async () => {
      const started = await readDaemonOwner(getGlobalConfigDir());
      expect(started).toBeDefined();
      expect(await isConversationIpcReady(getGlobalConfigDir(), started!)).toBe(true);
    }, { timeout: 30_000 });
    const owner = (await readDaemonOwner(getGlobalConfigDir()))!;
    expect(owner.cliPath).toBe(lifecycle.daemonEntryPath());
    expect(owner.pid).not.toBe(cli.pid);
    cli.kill('SIGTERM');
    const code = await exit;
    expect(code).toBe(0);
  } finally { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM'); await exit; }
});

it('hands new, concurrent and already-ready daemon connections through delayed opens and returns to idle after detach', async () => {
  const sockets: import('node:net').Socket[] = [];
  try {
    const results = await Promise.allSettled([
      lifecycle.ensureDaemon({ retainConnection: true }), lifecycle.ensureDaemon({ retainConnection: true }),
    ]);
    for (const result of results) if (result.status === 'fulfilled') sockets.push(result.value);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Daemon startup failed');
    const directory = getGlobalConfigDir();
    const owner = (await readDaemonOwner(directory))!;
    const survivesIdle = async () => {
      const readyAt = Date.now();
      // 最初の open を送らず、実子プロセスの複数回の idle 判定をまたぐ。
      await vi.waitFor(async () => {
        expect(await isDaemonOwnerRunning(owner, io())).toBe(true);
        expect(await readDaemonOwner(directory)).toEqual(owner);
        expect(Date.now() - readyAt).toBeGreaterThanOrEqual(1500);
      }, { timeout: 5000 });
    };
    await survivesIdle();
    const selected = await createTuiConversationPort(directory, { async deliver() { return { kind: 'delivered' }; } }).resolve({ kind: 'daemon' });
    const existing = await lifecycle.ensureDaemon({ retainConnection: true });
    sockets.push(existing);
    const openAndDetach = async (socket: import('node:net').Socket) => {
      const client = new Client(socket);
      const opened = (await client.request('open', selected)).result!;
      expect(await client.items(opened.read.transferId)).toContainEqual(expect.objectContaining({ kind: 'state' }));
      await client.request('detach', { attachmentId: opened.attachmentId });
    };
    await openAndDetach(sockets[0]!);
    await openAndDetach(sockets[1]!);
    // 既存 daemon から受け取った接続だけで待機する状態へ移す。
    await survivesIdle();
    await openAndDetach(existing);
    await vi.waitFor(async () => {
      expect(await isDaemonOwnerRunning(owner, io())).toBe(false);
      expect(await readDaemonOwner(directory)).toBeUndefined();
      expect(await readDaemonIpcState(directory)).toBeUndefined();
    }, { timeout: 10_000 });
  } finally { for (const socket of sockets) socket.destroy(); }
});
