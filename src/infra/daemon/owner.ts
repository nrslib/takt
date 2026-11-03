import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { IoOptions } from '../../core/daemon/io.js';
import { FileAsyncLock } from './lock.js';
import { ensurePrivateDirectory, hasCode, readPrivateFile, writePrivateFile } from './privateFile.js';
import { observeProcess } from './process.js';

const DaemonOwnerSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identity: z.object({ startTime: z.string().min(1) }).strict(),
  version: z.string().min(1), cliPath: z.string().min(1),
}).strict();
export type DaemonOwner = z.infer<typeof DaemonOwnerSchema>;
const ownerPath = (directory: string): string => join(directory, 'daemon.json');

export async function readDaemonOwner(directory: string): Promise<DaemonOwner | undefined> {
  const content = await readPrivateFile(ownerPath(directory), 16 * 1024);
  return content === undefined ? undefined : DaemonOwnerSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
}

export async function writeDaemonOwner(directory: string, owner: DaemonOwner, signal?: AbortSignal): Promise<void> {
  await writePrivateFile(ownerPath(directory), JSON.stringify(DaemonOwnerSchema.parse(owner)), signal);
}

export async function registerDaemonOwner(directory: string, owner: DaemonOwner, options: IoOptions): Promise<boolean> {
  await ensurePrivateDirectory(directory);
  return new FileAsyncLock().exclusive(`${ownerPath(directory)}.lock`, async () => {
    const existing = await readDaemonOwner(directory);
    if (existing !== undefined) {
      const observed = await observeProcess({ pid: existing.pid, startTime: existing.identity.startTime }, options);
      if (observed.kind === 'alive') return false;
      if (observed.kind === 'unknown') throw new Error(`Cannot verify daemon owner: ${observed.reason}`);
    }
    await writeDaemonOwner(directory, owner, options.signal);
    return true;
  }, options);
}

export async function removeDaemonOwner(directory: string, expected: DaemonOwner, options: IoOptions): Promise<void> {
  if (await readDaemonOwner(directory) === undefined) return;
  await new FileAsyncLock().exclusive(`${ownerPath(directory)}.lock`, async () => {
    const owner = await readDaemonOwner(directory);
    if (owner === undefined || owner.pid !== expected.pid || owner.identity.startTime !== expected.identity.startTime) return;
    options.signal.throwIfAborted();
    await unlink(ownerPath(directory)).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
  }, options);
}

export async function isDaemonOwnerRunning(owner: DaemonOwner, options: IoOptions): Promise<boolean> {
  const observed = await observeProcess({ pid: owner.pid, startTime: owner.identity.startTime }, options);
  if (observed.kind === 'unknown') throw new Error(`Cannot verify daemon process identity: ${observed.reason}`);
  return observed.kind === 'alive';
}
