import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getProcessIdentity, isProcessAlive, sameProcessIdentity, type ProcessIdentity } from '../../infra/task/process.js';

const LOCK_VERSION = 1;
interface LockOwner {
  readonly version: typeof LOCK_VERSION;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly processIdentity?: ProcessIdentity;
  readonly inode: number;
}

export interface WebUiInstanceLock {
  readonly path: string;
  release(): Promise<void>;
}

function parseOwner(value: unknown): LockOwner | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    raw.version !== LOCK_VERSION
    || typeof raw.instanceId !== 'string'
    || raw.instanceId.length === 0
    || !Number.isInteger(raw.pid)
    || (raw.pid as number) <= 0
    || !Number.isInteger(raw.port)
    || typeof raw.startedAt !== 'string'
    || !Number.isSafeInteger(raw.inode)
    || (raw.inode as number) < 0
  ) return null;
  if (raw.processIdentity !== undefined && (
    typeof raw.processIdentity !== 'object'
    || typeof (raw.processIdentity as Readonly<Record<string, unknown>>).startTime !== 'string'
  )) return null;
  return raw as unknown as LockOwner;
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    return parseOwner(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function claimPath(path: string, instanceId: string): string {
  return `${path}.${createHash('sha256').update(instanceId).digest('hex')}.claim`;
}

function sameOwner(first: LockOwner, second: LockOwner): boolean {
  const identityMatches = first.processIdentity === undefined && second.processIdentity === undefined
    || sameProcessIdentity(first.processIdentity, second.processIdentity);
  return first.instanceId === second.instanceId
    && first.pid === second.pid
    && first.inode === second.inode
    && identityMatches;
}

function ownerIsStale(owner: LockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return true;
  const currentIdentity = getProcessIdentity(owner.pid);
  return owner.processIdentity !== undefined
    && currentIdentity !== undefined
    && !sameProcessIdentity(owner.processIdentity, currentIdentity);
}

async function compareDeleteLock(
  path: string,
  owner: LockOwner,
  expectedStat: { readonly dev: number; readonly ino: number },
): Promise<boolean> {
  const claim = claimPath(path, owner.instanceId);
  try {
    await link(path, claim);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'EEXIST')) {
      return false;
    }
    throw new Error('Web UI instance lock cannot be claimed safely on this platform');
  }
  try {
    const [canonicalStat, claimStat, current] = await Promise.all([
      lstat(path),
      lstat(claim),
      readOwner(claim),
    ]);
    if (
      canonicalStat.dev !== expectedStat.dev
      || canonicalStat.ino !== expectedStat.ino
      || claimStat.dev !== expectedStat.dev
      || claimStat.ino !== expectedStat.ino
      || current === null
      || !sameOwner(current, owner)
    ) return false;
    const beforeDelete = await lstat(path);
    if (beforeDelete.dev !== expectedStat.dev || beforeDelete.ino !== expectedStat.ino) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  } finally {
    await unlink(claim).catch((error: unknown) => {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
  }
}

export async function acquireWebUiInstanceLock(
  globalConfigDirectory: string,
  port: number,
): Promise<WebUiInstanceLock> {
  const directory = join(globalConfigDirectory, 'web-ui');
  const path = join(directory, 'instance.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: LockOwner = {
      version: LOCK_VERSION,
      instanceId: randomUUID(),
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      inode: 0,
    };
    const temporary = `${path}.${owner.instanceId}.${randomUUID()}.tmp`;
    let temporaryHandle: import('node:fs/promises').FileHandle | undefined;
    let publishedOwner: { readonly owner: LockOwner; readonly stat: { readonly dev: number; readonly ino: number } } | undefined;
    try {
      temporaryHandle = await open(temporary, 'wx', 0o600);
      const fileStat = await temporaryHandle.stat();
      const processIdentity = getProcessIdentity(process.pid);
      const completeOwner: LockOwner = {
        ...owner,
        inode: fileStat.ino,
        ...(processIdentity === undefined ? {} : { processIdentity }),
      };
      try {
        await temporaryHandle.writeFile(`${JSON.stringify(completeOwner, null, 2)}\n`, 'utf8');
        await temporaryHandle.chmod(0o600);
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
        temporaryHandle = undefined;
      }
      // Publish only a complete, synced owner document. Hard-link creation is
      // exclusive and never overwrites a concurrent replacement owner.
      await link(temporary, path);
      publishedOwner = { owner: completeOwner, stat: { dev: fileStat.dev, ino: fileStat.ino } };
      await unlink(temporary);
      const publishedHandle = await open(path, 'r');
      const publishedStat = await publishedHandle.stat();
      await publishedHandle.close();
      const publishedDocument = await readOwner(path);
      if (
        publishedStat.dev !== fileStat.dev
        || publishedStat.ino !== fileStat.ino
        || publishedDocument === null
        || !sameOwner(publishedDocument, completeOwner)
      ) {
        throw new Error('Web UI instance lock publication identity changed');
      }
      return {
        path,
        async release(): Promise<void> {
          await compareDeleteLock(path, completeOwner, { dev: fileStat.dev, ino: fileStat.ino });
        },
      };
    } catch (error) {
      if (publishedOwner !== undefined) {
        await compareDeleteLock(path, publishedOwner.owner, publishedOwner.stat).catch(() => undefined);
      }
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      const current = await readOwner(path);
      if (current === null) throw new Error('TAKT Web UI instance lock is malformed or incomplete');
      if (!ownerIsStale(current)) {
        throw new Error(`TAKT Web UI is already running (PID ${current.pid}, port ${current.port})`);
      }
      const stats = await lstat(path).catch(() => null);
      if (stats === null) continue;
      await compareDeleteLock(path, current, { dev: stats.dev, ino: stats.ino });
    } finally {
      if (temporaryHandle !== undefined) await temporaryHandle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire the TAKT Web UI instance lock');
}
