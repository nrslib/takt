import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { GoalStore } from '../infra/goals/store.js';
import { isProcessAlive } from '../infra/task/process.js';
import { packageVersion } from '../shared/package-info.js';
import { captureOwnedChild, captureOwnedProcess, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const cliPath = join(process.cwd(), 'dist/app/cli/index.js');
const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');
let root: string;
let cwd: string;
let owned: OwnedProcess[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-process-')));
  cwd = join(root, 'project');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\nlanguage: ja\n');
  owned = [];
});

afterEach(async () => {
  const owner = readDaemonOwner(getGlobalConfigDir());
  if (owner !== undefined) owned.push({ pid: owner.pid, identity: owner.identity });
  for (const processOwner of owned) await terminateOwnedProcess(processOwner, () => false);
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  await lifecycle.ensureDaemon();
  const owner = readDaemonOwner(getGlobalConfigDir());
  expect(owner).toBeDefined();
  owned.push({ pid: owner!.pid, identity: owner!.identity });
  return owner!;
}

async function keepWork() {
  await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd, command: 'manager', managerUsed: true });
  return new GoalStore(cwd).create(goalRecord());
}

it('starts detached, records its executable/version, reuses it and stops from an unrelated directory', async () => {
  await keepWork();
  const owner = await start();
  expect(owner).toMatchObject({ version: packageVersion, cliPath });
  expect(owner.pid).not.toBe(process.pid);
  expect(isDaemonOwnerRunning(owner)).toBe(true);
  await vi.waitFor(() => {
    expect(readFileSync(join(getGlobalConfigDir(), 'logs', 'daemon.log'), 'utf8')).toContain(cwd);
  }, { timeout: 5_000 });
  await lifecycle.ensureDaemon();
  expect(readDaemonOwner(getGlobalConfigDir())).toEqual(owner);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const stopped = spawn(process.execPath, [cliPath, 'daemon', 'stop'], {
    cwd: outside, env: { ...process.env, TAKT_CONFIG_DIR: getGlobalConfigDir() }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  stopped.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    stopped.once('error', reject);
    stopped.once('exit', resolve);
  });
  const stopOwner = await captureOwnedChild(stopped);
  if (stopOwner !== undefined) owned.push(stopOwner);
  expect(await exited, stderr).toBe(0);
  expect(isProcessAlive(owner.pid)).toBe(false);
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  expect(readFileSync(join(cwd, '.takt', 'goals', goalRecord().id, 'goal.json'), 'utf8')).toContain(goalRecord().objective);
  expect(existsSync(join(outside, '.takt'))).toBe(false);
});

it('exits and removes the owner record when no projects have work', async () => {
  const owner = await start();
  await vi.waitFor(() => {
    expect(isProcessAlive(owner.pid)).toBe(false);
    expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  }, { timeout: 5_000 });
});

it('exits after the last unfinished goal is aborted without processing its records', async () => {
  const goal = await keepWork();
  const owner = await start();
  await new GoalStore(cwd).update(goal.id, (record) => ({ ...record, executionStatus: 'aborted' }));
  await vi.waitFor(() => expect(isProcessAlive(owner.pid)).toBe(false), { timeout: 5_000 });
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  expect((await new GoalStore(cwd).get(goal.id)).executionStatus).toBe('aborted');
});

it.each([{ version: 'previous' }, { cliPath: '/previous/takt.js' }])('restarts a daemon with a differing record: %j', async (difference) => {
  await keepWork();
  const previous = await start();
  writeDaemonOwner(getGlobalConfigDir(), { ...previous, ...difference });
  const current = await start();
  expect(current.pid).not.toBe(previous.pid);
  expect(isProcessAlive(previous.pid)).toBe(false);
  expect(current).toMatchObject({ version: packageVersion, cliPath });
  expect(isDaemonOwnerRunning(current)).toBe(true);
  await lifecycle.stopDaemon();
  expect(isProcessAlive(current.pid)).toBe(false);
});

it('does not signal a reused PID belonging to an unrelated live process', async () => {
  const fixture = captureOwnedProcess(process.pid);
  expect(fixture.identity).toBeDefined();
  const startTime = fixture.identity!.startTime;
  const changed = process.platform === 'win32'
    ? `${new Date(Date.parse(startTime) + 1_000).toISOString().slice(0, -1)}0000Z`
    : startTime.replace(/\d+$/, (ticks) => String(BigInt(ticks) + 1n));
  writeDaemonOwner(getGlobalConfigDir(), {
    pid: process.pid, identity: { startTime: changed }, version: packageVersion, cliPath,
  });
  await lifecycle.stopDaemon();
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
});
