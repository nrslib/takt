import { z } from 'zod/v4';
import type { ChildProcess } from 'node:child_process';
import { getProcessIdentity, hasProcessIdentityMismatch, isProcessAlive, sameProcessIdentity, type ProcessIdentity } from '../../infra/task/process.js';

export interface OwnedProcess {
  pid: number;
  identity: ProcessIdentity | undefined;
}

const markerSchema = z.object({ pid: z.number().int().positive(), startTime: z.string().optional() }).strict();

export function readOwnedProcessMarker(content: string): OwnedProcess {
  const marker = markerSchema.parse(JSON.parse(content) as unknown);
  return { pid: marker.pid, identity: marker.startTime === undefined ? undefined : { startTime: marker.startTime } };
}

export function captureOwnedProcess(pid: number): OwnedProcess {
  return { pid, identity: getProcessIdentity(pid) };
}

export async function captureOwnedChild(child: ChildProcess): Promise<OwnedProcess | undefined> {
  if (child.pid === undefined) return undefined;
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null) {
    const owned = captureOwnedProcess(child.pid);
    if (owned.identity !== undefined) return owned;
    if (Date.now() >= deadline) throw new Error(`Child process identity unavailable: ${child.pid}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

export function ownedProcessMarkerScript(processModuleUrl: string): string {
  return `
import { writeFileSync as writeMarkerFile, renameSync as renameMarkerFile } from 'node:fs';
import { getSelfProcessIdentity } from ${JSON.stringify(processModuleUrl)};
function writeProcessMarker(path) {
  const identity = getSelfProcessIdentity();
  if (identity === undefined) throw new Error('Cannot record test process identity');
  const temporary = path + '.' + process.pid + '.tmp';
  writeMarkerFile(temporary, JSON.stringify({ pid: process.pid, startTime: identity.startTime }));
  renameMarkerFile(temporary, path);
}
`;
}

function ownedProcessState(owned: OwnedProcess, hasExited: () => boolean): 'exited' | 'running' | 'unknown' {
  if (!Number.isSafeInteger(owned.pid) || owned.pid <= 0 || owned.pid === process.pid) throw new Error(`Invalid cleanup PID: ${owned.pid}`);
  if (hasExited() || !isProcessAlive(owned.pid)) return 'exited';
  const current = getProcessIdentity(owned.pid);
  if (hasProcessIdentityMismatch(owned.identity, current)) return 'exited';
  if (!sameProcessIdentity(owned.identity, current)) {
    if (hasExited() || !isProcessAlive(owned.pid)) return 'exited';
    return 'unknown';
  }
  return 'running';
}

export function signalOwnedProcess(owned: OwnedProcess, signal: NodeJS.Signals, hasExited: () => boolean): boolean {
  if (ownedProcessState(owned, hasExited) !== 'running') return false;
  try { process.kill(owned.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
  return true;
}

export async function terminateOwnedProcess(owned: OwnedProcess, hasExited: () => boolean): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    let signalled = false;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const state = ownedProcessState(owned, hasExited);
      if (state === 'exited') return;
      if (state === 'running' && !signalled) signalled = signalOwnedProcess(owned, signal, hasExited);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  if (ownedProcessState(owned, hasExited) !== 'exited') throw new Error(`Process exit was not confirmed: ${owned.pid}`);
}
