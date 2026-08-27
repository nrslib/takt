import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProcessIdentity, isProcessAlive, sameProcessIdentity, type ProcessIdentity } from '../../infra/task/process.js';

const LOCK_VERSION = 1;
const ENDPOINT_VERSION = 1;
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 25;
interface LockOwner {
  readonly version: typeof LOCK_VERSION;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
  readonly controlToken?: string;
  readonly processIdentity?: ProcessIdentity;
  readonly inode: number;
}

interface EndpointDocument {
  readonly version: typeof ENDPOINT_VERSION;
  readonly instanceId: string;
  readonly origin: string;
}

export interface WebUiInstance {
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
}

interface ManagedWebUiInstance extends WebUiInstance {
  readonly instanceId: string;
  readonly controlToken?: string;
  readonly processIdentity?: ProcessIdentity;
}

export class WebUiAlreadyRunningError extends Error {
  constructor(readonly instance: WebUiInstance) {
    super(`TAKT Web UI is already running: ${instance.origin} (PID ${instance.pid})`);
  }
}

export interface WebUiInstanceLock {
  readonly path: string;
  readonly controlToken: string;
  publishOrigin(origin: string): Promise<void>;
  release(): Promise<void>;
}

export type StopWebUiResult =
  | { readonly disposition: 'not_running' }
  | { readonly disposition: 'stopped'; readonly instance: WebUiInstance };

function webUiPaths(globalConfigDirectory: string): {
  readonly directory: string;
  readonly lock: string;
  readonly endpoint: string;
} {
  const directory = join(globalConfigDirectory, 'web-ui');
  return {
    directory,
    lock: join(directory, 'instance.json'),
    endpoint: join(directory, 'endpoint.json'),
  };
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
  if (raw.controlToken !== undefined && (
    typeof raw.controlToken !== 'string'
    || raw.controlToken.length < 32
  )) return null;
  if (raw.processIdentity !== undefined && (
    typeof raw.processIdentity !== 'object'
    || typeof (raw.processIdentity as Readonly<Record<string, unknown>>).startTime !== 'string'
  )) return null;
  return raw as unknown as LockOwner;
}

function parseEndpoint(value: unknown): EndpointDocument | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Readonly<Record<string, unknown>>;
  if (
    raw.version !== ENDPOINT_VERSION
    || typeof raw.instanceId !== 'string'
    || raw.instanceId.length === 0
    || typeof raw.origin !== 'string'
  ) return null;
  try {
    const origin = new URL(raw.origin);
    if (
      origin.protocol !== 'http:'
      || origin.hostname !== '127.0.0.1'
      || origin.origin !== raw.origin
    ) return null;
  } catch {
    return null;
  }
  return raw as unknown as EndpointDocument;
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

async function resolveOwnerOrigin(
  endpointPath: string,
  owner: LockOwner,
): Promise<string> {
  try {
    const endpoint = parseEndpoint(JSON.parse(await readFile(endpointPath, 'utf8')) as unknown);
    if (endpoint !== null && endpoint.instanceId === owner.instanceId) return endpoint.origin;
  } catch {
    // A missing or stale endpoint document does not supersede the lock owner.
  }
  if (owner.port === 0) {
    throw new Error('TAKT Web UI is starting and has not published its URL yet');
  }
  return `http://127.0.0.1:${owner.port}`;
}

async function readManagedWebUiInstance(
  globalConfigDirectory: string,
): Promise<ManagedWebUiInstance | undefined> {
  const paths = webUiPaths(globalConfigDirectory);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(paths.lock);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!stats.isFile()) throw new Error('TAKT Web UI instance lock is not a regular file');
  const owner = await readOwner(paths.lock);
  if (owner === null || owner.inode !== stats.ino) {
    throw new Error('TAKT Web UI instance lock is malformed or incomplete');
  }
  if (ownerIsStale(owner)) return undefined;
  return {
    instanceId: owner.instanceId,
    pid: owner.pid,
    port: owner.port,
    origin: await resolveOwnerOrigin(paths.endpoint, owner),
    startedAt: owner.startedAt,
    ...(owner.controlToken === undefined ? {} : { controlToken: owner.controlToken }),
    ...(owner.processIdentity === undefined ? {} : { processIdentity: owner.processIdentity }),
  };
}

export async function readWebUiInstance(
  globalConfigDirectory: string,
): Promise<WebUiInstance | undefined> {
  const instance = await readManagedWebUiInstance(globalConfigDirectory);
  if (instance === undefined) return undefined;
  return {
    pid: instance.pid,
    port: instance.port,
    origin: instance.origin,
    startedAt: instance.startedAt,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function requestWebUiStop(instance: ManagedWebUiInstance): Promise<void> {
  if (instance.controlToken === undefined) {
    const currentIdentity = getProcessIdentity(instance.pid);
    if (!sameProcessIdentity(instance.processIdentity, currentIdentity)) {
      throw new Error('TAKT Web UI cannot be stopped safely because its process identity is unavailable');
    }
    process.kill(instance.pid, 'SIGTERM');
    return;
  }
  const response = await fetch(`${instance.origin}/api/control/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    headers: {
      Connection: 'close',
      'X-TAKT-Web-Control-Token': instance.controlToken,
    },
  });
  if (response.status !== 202) {
    throw new Error(`TAKT Web UI refused the stop request (HTTP ${response.status})`);
  }
}

async function waitForWebUiStop(
  globalConfigDirectory: string,
  instanceId: string,
): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readManagedWebUiInstance(globalConfigDirectory);
    if (current === undefined || current.instanceId !== instanceId) return;
    await delay(STOP_POLL_INTERVAL_MS);
  }
  throw new Error(`TAKT Web UI did not stop within ${STOP_TIMEOUT_MS}ms`);
}

export async function stopWebUiInstance(
  globalConfigDirectory: string,
): Promise<StopWebUiResult> {
  const instance = await readManagedWebUiInstance(globalConfigDirectory);
  if (instance === undefined) return { disposition: 'not_running' };
  await requestWebUiStop(instance);
  await waitForWebUiStop(globalConfigDirectory, instance.instanceId);
  return {
    disposition: 'stopped',
    instance: {
      pid: instance.pid,
      port: instance.port,
      origin: instance.origin,
      startedAt: instance.startedAt,
    },
  };
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
  const paths = webUiPaths(globalConfigDirectory);
  const path = paths.lock;
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controlToken = randomBytes(32).toString('base64url');
    const owner: LockOwner = {
      version: LOCK_VERSION,
      instanceId: randomUUID(),
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      controlToken,
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
        controlToken,
        async publishOrigin(origin: string): Promise<void> {
          const endpoint: EndpointDocument = {
            version: ENDPOINT_VERSION,
            instanceId: completeOwner.instanceId,
            origin,
          };
          if (parseEndpoint(endpoint) === null) {
            throw new Error('TAKT Web UI origin must be a loopback HTTP origin');
          }
          const temporaryEndpoint = `${paths.endpoint}.${completeOwner.instanceId}.${randomUUID()}.tmp`;
          await writeFile(temporaryEndpoint, `${JSON.stringify(endpoint, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          });
          try {
            await unlink(paths.endpoint).catch((error: unknown) => {
              if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
                throw error;
              }
            });
            await rename(temporaryEndpoint, paths.endpoint);
          } finally {
            await unlink(temporaryEndpoint).catch(() => undefined);
          }
        },
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
        throw new WebUiAlreadyRunningError({
          pid: current.pid,
          port: current.port,
          origin: await resolveOwnerOrigin(paths.endpoint, current),
          startedAt: current.startedAt,
        });
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
