import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readDaemonOwner, isDaemonOwnerRunning, writeDaemonOwner } from '../infra/daemon/owner.js';
import { readDaemonIpcState } from '../infra/daemon/ipcEndpoint.js';
import { isConversationIpcReady } from '../features/daemon/conversationReadiness.js';
import { packageVersion } from '../shared/package-info.js';

const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');
const io = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });
afterEach(async () => { await lifecycle.stopDaemon(); });

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
