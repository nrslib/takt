import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isRecordedProcessAlive, withFileLock } from '../fs/file-lock.js';
import { getProcessIdentity, hasProcessIdentityMismatch, isProcessAlive, sameProcessIdentity } from '../task/process.js';
import { ensurePrivateDirectory, readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';

const DaemonOwnerSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identity: z.object({ startTime: z.string().min(1) }).strict(),
  version: z.string().min(1),
  cliPath: z.string().min(1),
}).strict();
export type DaemonOwner = z.infer<typeof DaemonOwnerSchema>;

function ownerPath(globalConfigDirectory: string): string {
  return join(globalConfigDirectory, 'daemon.json');
}

export function readDaemonOwner(globalConfigDirectory: string): DaemonOwner | undefined {
  const snapshot = readPrivateFileState(ownerPath(globalConfigDirectory));
  if (!('content' in snapshot)) return undefined;
  return DaemonOwnerSchema.parse(JSON.parse(snapshot.content.toString('utf8')) as unknown);
}

export function writeDaemonOwner(globalConfigDirectory: string, owner: DaemonOwner): void {
  ensurePrivateDirectory(globalConfigDirectory);
  writePrivateFile(ownerPath(globalConfigDirectory), JSON.stringify(DaemonOwnerSchema.parse(owner)));
}

export function registerDaemonOwner(globalConfigDirectory: string, owner: DaemonOwner): boolean {
  ensurePrivateDirectory(globalConfigDirectory);
  return withFileLock(`${ownerPath(globalConfigDirectory)}.lock`, () => {
    const existing = readDaemonOwner(globalConfigDirectory);
    if (existing !== undefined && isRecordedProcessAlive(existing.pid, existing.identity)) return false;
    writeDaemonOwner(globalConfigDirectory, owner);
    return true;
  });
}

export function removeDaemonOwner(globalConfigDirectory: string): void {
  rmSync(ownerPath(globalConfigDirectory), { force: true });
}

export function isDaemonOwnerRunning(owner: DaemonOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  const identity = getProcessIdentity(owner.pid);
  if (hasProcessIdentityMismatch(owner.identity, identity)) return false;
  if (!sameProcessIdentity(owner.identity, identity)) {
    if (!isProcessAlive(owner.pid)) return false;
    throw new Error(`Cannot verify daemon process identity (PID ${owner.pid})`);
  }
  return true;
}
