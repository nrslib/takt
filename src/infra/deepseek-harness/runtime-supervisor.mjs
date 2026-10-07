#!/usr/bin/env node

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertDeepSeekRuntimeCreationAllowedLocked,
  markDeepSeekCleanupBarrierLocked,
  withDeepSeekRuntimeStateFileLock,
} from './runtime-state-lock.mjs';

const ownerDirectory = process.env.TAKT_DSH_OWNER_DIRECTORY;
const stateDirectory = process.env.TAKT_DSH_STATE_DIRECTORY;
const managedPackageDirectory = process.env.TAKT_DSH_MANAGED_PACKAGE_DIRECTORY;
const parentPid = Number(process.env.TAKT_DSH_PARENT_PID);
if (!ownerDirectory || !stateDirectory || !managedPackageDirectory || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
  process.exit(70);
}

const require = createRequire(join(managedPackageDirectory, 'package.json'));
const runtimePackage = require('@deepseek-ai/dsh/package.json');
const runtimeBin = require.resolve(`@deepseek-ai/dsh/${runtimePackage.bin.dsh}`);
const ownerPath = join(ownerDirectory, `${process.pid}.json`);
const cleanupConfirmationPath = process.env.TAKT_DSH_CLEANUP_CONFIRMATION;
let runtime;
let terminationPromise;
let resolveOwnerReady;
const ownerReady = new Promise((resolve) => { resolveOwnerReady = resolve; });

/** Atomically publish the supervised runtime PID and optional failed-cleanup marker. */
async function writeOwner(cleanupFailure = false) {
  if (runtime?.pid === undefined) return;
  const tempPath = `${ownerPath}.${process.pid}.tmp`;
  const record = {
    parentPid,
    supervisorPid: process.pid,
    runtimePid: runtime.pid,
    ...(cleanupFailure ? { cleanupFailed: true } : {}),
  };
  await mkdir(dirname(ownerPath), { recursive: true, mode: 0o700 });
  await writeFile(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    await rename(tempPath, ownerPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Probe the whole runtime group, preserving uncertainty as distinct from exit. */
function processGroupState(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return undefined;
  }
}

/** Wait a bounded interval for every tool/runtime process in the group to exit. */
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (processGroupState(pid) === false) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processGroupState(pid) === false;
}

/** Signal the entire supervised group without surfacing raw OS diagnostic text. */
function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

/** Persist failed cleanup, including unpublished runtime PIDs, or retain the state lock. */
async function recordUnconfirmedCleanup(lock) {
  try {
    await writeOwner(true);
  } catch {
    try {
      await markDeepSeekCleanupBarrierLocked(stateDirectory, ownerDirectory, runtime?.pid);
    } catch {
      lock.retain();
    }
  }
}

/** Escalate TERM to KILL under the state lock; remove owners only after proven exit. */
async function cleanRuntimeGroupLocked(lock) {
  if (runtime?.pid === undefined) {
    try {
      if (cleanupConfirmationPath) await writeFile(cleanupConfirmationPath, 'confirmed\n', { mode: 0o600 });
      await rm(ownerPath, { force: true });
      return true;
    } catch {
      await recordUnconfirmedCleanup(lock);
      return false;
    }
  }
  signalProcessGroup(runtime.pid, 'SIGTERM');
  if (await waitForProcessGroupExit(runtime.pid, 1_000)) {
    try {
      if (cleanupConfirmationPath) await writeFile(cleanupConfirmationPath, 'confirmed\n', { mode: 0o600 });
      await rm(ownerPath, { force: true });
      return true;
    } catch {
      await recordUnconfirmedCleanup(lock);
      return false;
    }
  }
  signalProcessGroup(runtime.pid, 'SIGKILL');
  if (await waitForProcessGroupExit(runtime.pid, 2_000)) {
    try {
      if (cleanupConfirmationPath) await writeFile(cleanupConfirmationPath, 'confirmed\n', { mode: 0o600 });
      await rm(ownerPath, { force: true });
      return true;
    } catch {
      await recordUnconfirmedCleanup(lock);
      return false;
    }
  }
  await recordUnconfirmedCleanup(lock);
  return false;
}

/** Acquire the shared state lock before group termination and owner removal. */
async function cleanRuntimeGroup() {
  return withDeepSeekRuntimeStateFileLock(stateDirectory, (lock) => cleanRuntimeGroupLocked(lock));
}

/** Share one termination promise between exit, cancellation and parent-loss handlers. */
function terminateRuntime() {
  if (terminationPromise === undefined) {
    terminationPromise = cleanRuntimeGroup();
  }
  return terminationPromise;
}

let startupFailed = false;
try {
  await withDeepSeekRuntimeStateFileLock(stateDirectory, async (lock) => {
    await assertDeepSeekRuntimeCreationAllowedLocked(stateDirectory, ownerDirectory, parentPid);
    try {
      runtime = spawn(process.execPath, [runtimeBin, ...process.argv.slice(2)], {
        cwd: process.cwd(),
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'inherit', 'ignore'],
      });

      runtime.once('exit', async (code, signal) => {
        await ownerReady;
        const cleanupConfirmed = await terminateRuntime().catch(() => false);
        process.exitCode = cleanupConfirmed ? (code ?? (signal ? 1 : 0)) : 1;
        process.stdin.destroy();
      });

      await new Promise((resolve, reject) => {
        runtime.once('spawn', resolve);
        runtime.once('error', reject);
      });
      await writeOwner();
    } catch (error) {
      // Until publication succeeds, the shared registry cannot account for this group.
      // Reap it under the same lock; otherwise a peer may spawn across this gap.
      if (runtime?.pid !== undefined) {
        let cleanupConfirmed = false;
        try {
          cleanupConfirmed = await cleanRuntimeGroupLocked(lock);
        } finally {
          if (!cleanupConfirmed) lock.retain();
        }
      }
      throw error;
    }
  });
} catch {
  startupFailed = true;
}

if (startupFailed) {
  resolveOwnerReady();
  if (runtime?.pid !== undefined) await terminateRuntime().catch(() => false);
  process.exit(70);
}

resolveOwnerReady();
if (runtime.exitCode !== null || runtime.signalCode !== null) {
  await terminateRuntime();
  process.stdin.destroy();
}
process.stdin.pipe(runtime.stdin);
process.stdin.on('end', () => { void terminateRuntime(); });
process.on('SIGTERM', () => { void terminateRuntime(); });
process.on('SIGINT', () => { void terminateRuntime(); });
runtime.stdout?.on('error', () => { void terminateRuntime(); });
runtime.stdin?.on('error', () => { void terminateRuntime(); });
